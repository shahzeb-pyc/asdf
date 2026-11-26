import { z } from 'zod';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  CopyObjectParams,
  IStorageService,
  ListedObject,
  ListObjectsParams,
  PresignedUploadParams,
  PresignedUploadResult,
  PutObjectParams,
  PutObjectResult,
} from '@fbuploadpro/contracts';
// Test-only mock. Only used by the non-production fallback in getStorageService()
// below; never instantiated in production (a storage backend is always configured there).
import { getMockStorageProvider } from '../../tests/helpers/mock-storage';

export const R2ConfigSchema = z.object({
  accountId: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  accessKeyId: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  secretAccessKey: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  bucketName: z.string().min(1, 'R2_BUCKET_NAME is required'),
  publicUrl: z.string().url('R2_PUBLIC_URL must be a valid URL'),
});

export type R2Config = z.infer<typeof R2ConfigSchema>;

export function getR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
    return null;
  }

  const result = R2ConfigSchema.safeParse({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicUrl,
  });

  return result.success ? result.data : null;
}

/**
 * Backblaze B2 configuration (spec 259). The web app touches only the
 * media bucket (`fbuploadpro-media-prod`); the ADU buffer bucket is
 * downloader-side and never appears here.
 *
 * The application key must be a standard (non-master) scoped key: the
 * master key CANNOT authenticate the S3-Compatible API at all, so an
 * app running with the master key would fail auth on every call.
 * The region is the account's single B2 region (verified live:
 * `eu-central-003`); the S3 endpoint and the signing region must match
 * the bucket's region exactly or requests fail with signature errors.
 */
export const B2ConfigSchema = z.object({
  applicationKeyId: z.string().min(1, 'B2_APPLICATION_KEY_ID is required'),
  applicationKey: z.string().min(1, 'B2_APPLICATION_KEY is required'),
  bucketName: z.string().min(1, 'B2_BUCKET_NAME is required'),
  region: z.string().min(1, 'B2_REGION is required'),
});

export type B2Config = z.infer<typeof B2ConfigSchema>;

export function getB2Config(): B2Config | null {
  const applicationKeyId = process.env.B2_APPLICATION_KEY_ID;
  const applicationKey = process.env.B2_APPLICATION_KEY;
  const bucketName = process.env.B2_BUCKET_NAME;
  const region = process.env.B2_REGION;

  if (!applicationKeyId || !applicationKey || !bucketName || !region) {
    return null;
  }

  const result = B2ConfigSchema.safeParse({
    applicationKeyId,
    applicationKey,
    bucketName,
    region,
  });

  return result.success ? result.data : null;
}

/** S3 endpoint for a B2 region: `https://s3.<region>.backblazeb2.com`. */
export function getB2Endpoint(region: string): string {
  return `https://s3.${region}.backblazeb2.com`;
}

/**
 * Explicit network bounds for the S3 clients (spec 139). Without
 * these, the AWS SDK v3 defaults leave request/connection timeouts
 * disabled (a hung storage connection can stall a serverless invocation
 * indefinitely) and the retry count implicit. `requestHandler` is
 * passed as plain NodeHttpHandler options — the SDK instantiates the
 * handler from them — so no extra handler package is needed.
 *
 * R2 and B2 share the same bounds (spec 259): 3 attempts, 15s request,
 * 5s connection.
 */
export const R2_MAX_ATTEMPTS = 3;
export const R2_REQUEST_TIMEOUT_MS = 15_000;
export const R2_CONNECTION_TIMEOUT_MS = 5_000;

export const B2_MAX_ATTEMPTS = R2_MAX_ATTEMPTS;
export const B2_REQUEST_TIMEOUT_MS = R2_REQUEST_TIMEOUT_MS;
export const B2_CONNECTION_TIMEOUT_MS = R2_CONNECTION_TIMEOUT_MS;

export function createR2S3Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    maxAttempts: R2_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
      requestTimeout: R2_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}

/**
 * B2 S3 client (spec 259): real region (NOT `'auto'`), endpoint
 * `https://s3.<region>.backblazeb2.com`, scoped application key as the
 * S3 credentials. No `forcePathStyle` — B2 supports virtual-hosted
 * style. Presigned PUT URLs (the app's only presigned flow) are
 * supported by B2; presigned POST is not supported and is never used.
 */
export function createB2S3Client(config: B2Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: getB2Endpoint(config.region),
    credentials: {
      accessKeyId: config.applicationKeyId,
      secretAccessKey: config.applicationKey,
    },
    maxAttempts: B2_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: B2_CONNECTION_TIMEOUT_MS,
      requestTimeout: B2_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) {
    end--;
  }
  return str.slice(0, end);
}

/**
 * Percent-encode each path segment of a storage key, preserving `/`
 * separators (spec 257). R2 keys are raw strings — a Devanagari or
 * space-containing filename must reach Meta as a percent-encoded URL
 * or its fetcher cannot fetch the media — but encoding the slashes
 * would break the key. ASCII keys are byte-identical through this.
 */
export function encodeStorageKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * The shared public base for media URLs (`R2_PUBLIC_URL`, value
 * `https://media.vinsmokemedia.online`). The variable names the public
 * base, NOT the backend: the domain is repointed at B2 in phase 2 while
 * the keys stay identical, so the same base serves objects from either
 * backend during the transition and no stored URL ever changes.
 * Returns null when the variable is absent or not a valid URL.
 */
export function getPublicBaseUrl(): string | null {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) return null;
  const result = z.string().url().safeParse(publicUrl);
  return result.success ? result.data : null;
}

/** True for an S3 "object does not exist" failure (any spelling). */
export function isStorageNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const candidate = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === '404' ||
    candidate.Code === 'NoSuchKey'
  );
}

/**
 * The web app's storage service: the shared base interface plus
 * the server-side copy/list operations the media/posting
 * separation needs (post-owned copies, staged-upload sweep).
 *
 * Deliberately a WEB-ONLY extension, not a widening of the shared
 * `IStorageService`: the download-worker's own implementers
 * (R2 binding sink, test fakes) must not grow copy/list methods
 * they never use, and widening the shared interface broke their
 * typecheck. Only the separation code depends on this interface;
 * everything else keeps depending on the base.
 */
export interface IStorageServiceWithCopy extends IStorageService {
  copyObject(params: CopyObjectParams): Promise<void>;
  listObjects(params: ListObjectsParams): Promise<ListedObject[]>;
}

/** Minimal config for one S3-compatible backend: its bucket + the shared public base. */
export interface SingleBackendConfig {
  bucketName: string;
  publicUrl: string;
}

/** Bytes read back from a single backend, with the stored content type when known. */
export interface StorageObjectBytes {
  body: Uint8Array;
  contentType?: string | undefined;
}

/**
 * One S3-compatible backend (one bucket behind one endpoint). R2 and
 * B2 are the same operations against different endpoints/buckets, so
 * both providers share this implementation; only their construction
 * (config shape + client) differs.
 */
export class S3StorageProvider implements IStorageServiceWithCopy {
  protected readonly client: S3Client;
  protected readonly bucketName: string;
  protected readonly publicUrl: string;

  constructor(config: SingleBackendConfig, client: S3Client) {
    this.bucketName = config.bucketName;
    this.publicUrl = config.publicUrl;
    this.client = client;
  }

  async getPresignedUploadUrl(params: PresignedUploadParams): Promise<PresignedUploadResult> {
    const expiresIn = params.expiresInSeconds ?? 900;
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: params.key,
      ContentType: params.contentType,
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });
    return {
      uploadUrl,
      publicUrl: this.getPublicUrl(params.key),
      expiresInSeconds: expiresIn,
    };
  }

  async putObject(params: PutObjectParams): Promise<PutObjectResult> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ContentLength: params.body.byteLength,
    });
    await this.client.send(command);
    return {
      key: params.key,
      publicUrl: this.getPublicUrl(params.key),
      byteLength: params.body.byteLength,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    await this.client.send(command);
  }

  /**
   * Server-side copy (media/posting separation): the bytes never
   * travel through the app server. CopySource carries the bucket
   * plus the key with each path segment URL-encoded (slashes stay
   * literal — encoding them breaks the copy). Same-endpoint only:
   * the dual provider falls back to a streamed Get → Put when the
   * source lives on the other backend.
   */
  async copyObject(params: CopyObjectParams): Promise<void> {
    const encodedKey = encodeStorageKey(params.sourceKey);
    const command = new CopyObjectCommand({
      Bucket: this.bucketName,
      CopySource: `${this.bucketName}/${encodedKey}`,
      Key: params.destinationKey,
    });
    await this.client.send(command);
  }

  async listObjects(params: ListObjectsParams): Promise<ListedObject[]> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: params.prefix,
      MaxKeys: params.maxKeys ?? 1000,
    });
    const result = await this.client.send(command);
    return (result.Contents ?? [])
      .filter((entry) => typeof entry.Key === 'string')
      .map((entry) => ({
        key: entry.Key as string,
        lastModified: entry.LastModified ?? null,
      }));
  }

  getPublicUrl(key: string): string {
    const trimmedBase = trimTrailingSlashes(this.publicUrl);
    const trimmedKey = key.replace(/^\/+/, '');
    return `${trimmedBase}/${encodeStorageKey(trimmedKey)}`;
  }

  /**
   * Read an object's bytes back from this backend. Returns null when
   * the key does not exist; any other failure throws (fail loud).
   * Used by the dual provider's cross-backend copy only.
   */
  async readObject(key: string): Promise<StorageObjectBytes | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key })
      );
      const body = result.Body;
      if (!body || typeof body.transformToByteArray !== 'function') {
        throw new Error(`Storage read failed: empty body for key ${key}`);
      }
      return {
        body: await body.transformToByteArray(),
        contentType: result.ContentType,
      };
    } catch (err) {
      if (isStorageNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }
}

export class R2StorageProvider extends S3StorageProvider {
  constructor(config: R2Config, client?: S3Client) {
    super(
      { bucketName: config.bucketName, publicUrl: config.publicUrl },
      client ?? createR2S3Client(config)
    );
  }
}

export class B2StorageProvider extends S3StorageProvider {
  constructor(config: B2Config, publicUrl: string, client?: S3Client) {
    super(
      { bucketName: config.bucketName, publicUrl },
      client ?? createB2S3Client(config)
    );
  }
}

/**
 * Transition provider (spec 259): B2 is the write backend, R2 is the
 * read fallback while the backfill runs. Writes (putObject, presigned
 * upload URLs) go to B2 only. `getPublicUrl` is a pure string from the
 * shared public base — identical for both backends. Deletes go to BOTH
 * backends (S3 delete is idempotent; a missing key returns success).
 * Listings are the union of both backends, deduplicated by key (the
 * write backend wins on a collision). Copies try the server-side copy
 * on the write backend first; when the source lives only on R2, the
 * bytes stream Get (R2) → Put (B2) through the app server, and any
 * failure other than a missing source throws — never silently skipped.
 */
export class DualStorageProvider implements IStorageServiceWithCopy {
  private readonly write: S3StorageProvider;
  private readonly read: S3StorageProvider;

  constructor(write: S3StorageProvider, read: S3StorageProvider) {
    this.write = write;
    this.read = read;
  }

  async getPresignedUploadUrl(params: PresignedUploadParams): Promise<PresignedUploadResult> {
    return this.write.getPresignedUploadUrl(params);
  }

  async putObject(params: PutObjectParams): Promise<PutObjectResult> {
    return this.write.putObject(params);
  }

  async deleteObject(key: string): Promise<void> {
    const results = await Promise.allSettled([
      this.write.deleteObject(key),
      this.read.deleteObject(key),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed) {
      throw failed.reason;
    }
  }

  async copyObject(params: CopyObjectParams): Promise<void> {
    try {
      await this.write.copyObject(params);
      return;
    } catch (err) {
      if (!isStorageNotFoundError(err)) {
        throw err;
      }
    }
    // Source is not on the write backend — it may still live on R2.
    // Stream it across (Get from R2, Put to the write backend).
    const source = await this.read.readObject(params.sourceKey);
    if (!source) {
      throw new Error(
        `Storage copy failed: source object not found on either backend: ${params.sourceKey}`
      );
    }
    await this.write.putObject({
      key: params.destinationKey,
      body: source.body,
      contentType: source.contentType ?? 'application/octet-stream',
    });
  }

  async listObjects(params: ListObjectsParams): Promise<ListedObject[]> {
    const [writeListed, readListed] = await Promise.all([
      this.write.listObjects(params),
      this.read.listObjects(params),
    ]);
    const byKey = new Map<string, ListedObject>();
    // Read backend first so the write backend wins on a collision.
    for (const entry of readListed) {
      byKey.set(entry.key, entry);
    }
    for (const entry of writeListed) {
      byKey.set(entry.key, entry);
    }
    return [...byKey.values()];
  }

  getPublicUrl(key: string): string {
    return this.write.getPublicUrl(key);
  }
}

/**
 * The active WRITE backend's config, or null when no backend is
 * configured. B2 wins when configured; otherwise R2.
 *
 * Deliberately a CONFIG, not a built client: the multipart routes and
 * the confirm verifier build their S3 client from the config with the
 * imported `createR2S3Client` / `createB2S3Client` factories, and
 * tests fake the client at that factory seam. Building the client
 * inside storage.ts would bypass those fakes and hit the real network.
 */
export type WriteBackendConfig =
  | { kind: 'r2'; config: R2Config }
  | { kind: 'b2'; config: B2Config; publicUrl: string };

export function getWriteBackendConfig(): WriteBackendConfig | null {
  const b2Config = getB2Config();
  if (b2Config) {
    const publicBase = getPublicBaseUrl();
    if (!publicBase) {
      // B2 without the shared public base is a misconfiguration, not
      // a reason to silently write to R2 instead: fail the lookup and
      // let getStorageService() throw in production.
      return null;
    }
    return { kind: 'b2', config: b2Config, publicUrl: publicBase };
  }
  const r2Config = getR2Config();
  if (r2Config) {
    return { kind: 'r2', config: r2Config };
  }
  return null;
}

/** Bucket + public base for a write-backend config, whichever backend it is. */
export function writeBackendBucket(backend: WriteBackendConfig): SingleBackendConfig {
  return backend.kind === 'b2'
    ? { bucketName: backend.config.bucketName, publicUrl: backend.publicUrl }
    : { bucketName: backend.config.bucketName, publicUrl: backend.config.publicUrl };
}

/** Build the S3 client for a write-backend config (B2 or R2 factory). */
export function createWriteBackendClient(backend: WriteBackendConfig): S3Client {
  return backend.kind === 'b2'
    ? createB2S3Client(backend.config)
    : createR2S3Client(backend.config);
}

/**
 * Backend selection (spec 259):
 * - B2 + R2 configured → dual provider (write B2, read fallback R2).
 * - B2 only → B2 provider.
 * - R2 only → R2 provider, byte-identical behaviour to today.
 * - Neither → production throws (naming BOTH backends); dev/test fall
 *   back to the mock as today.
 */
export function getStorageService(): IStorageServiceWithCopy {
  const r2Config = getR2Config();
  const b2Config = getB2Config();
  if (b2Config) {
    const publicBase = getPublicBaseUrl();
    if (!publicBase) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'Backblaze B2 storage is configured (B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_REGION) but the shared public base R2_PUBLIC_URL is missing in production'
        );
      }
    } else {
      const write = new B2StorageProvider(b2Config, publicBase);
      if (r2Config) {
        return new DualStorageProvider(write, new R2StorageProvider(r2Config));
      }
      return write;
    }
  }
  if (r2Config) {
    return new R2StorageProvider(r2Config);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'No storage backend is configured in production: Cloudflare R2 storage credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) or Backblaze B2 storage credentials (B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_REGION) are strictly required'
    );
  }
  // Development/test fallback only. The mock lives in tests/helpers/ and is
  // never instantiated in production (a storage backend is always configured there).
  return getMockStorageProvider();
}
