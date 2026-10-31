import { z } from 'zod';
import {
  S3Client,
  PutObjectCommand,
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
// below; never instantiated in production (R2 is always configured there).
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
 * Explicit network bounds for the R2 S3 client (spec 139). Without
 * these, the AWS SDK v3 defaults leave request/connection timeouts
 * disabled (a hung R2 connection can stall a serverless invocation
 * indefinitely) and the retry count implicit. `requestHandler` is
 * passed as plain NodeHttpHandler options — the SDK instantiates the
 * handler from them — so no extra handler package is needed.
 */
export const R2_MAX_ATTEMPTS = 3;
export const R2_REQUEST_TIMEOUT_MS = 15_000;
export const R2_CONNECTION_TIMEOUT_MS = 5_000;

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

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) {
    end--;
  }
  return str.slice(0, end);
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

export class R2StorageProvider implements IStorageServiceWithCopy {
  private readonly client: S3Client;
  private readonly config: R2Config;

  constructor(config: R2Config, client?: S3Client) {
    this.config = config;
    this.client = client ?? createR2S3Client(config);
  }

  async getPresignedUploadUrl(params: PresignedUploadParams): Promise<PresignedUploadResult> {
    const expiresIn = params.expiresInSeconds ?? 900;
    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
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
      Bucket: this.config.bucketName,
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
      Bucket: this.config.bucketName,
      Key: key,
    });
    await this.client.send(command);
  }

  /**
   * Server-side copy (media/posting separation): the bytes never
   * travel through the app server. CopySource carries the bucket
   * plus the key with each path segment URL-encoded (slashes stay
   * literal — encoding them breaks the copy).
   */
  async copyObject(params: CopyObjectParams): Promise<void> {
    const encodedKey = params.sourceKey
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const command = new CopyObjectCommand({
      Bucket: this.config.bucketName,
      CopySource: `${this.config.bucketName}/${encodedKey}`,
      Key: params.destinationKey,
    });
    await this.client.send(command);
  }

  async listObjects(params: ListObjectsParams): Promise<ListedObject[]> {
    const command = new ListObjectsV2Command({
      Bucket: this.config.bucketName,
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
    const trimmedBase = trimTrailingSlashes(this.config.publicUrl);
    const trimmedKey = key.replace(/^\/+/, '');
    return `${trimmedBase}/${trimmedKey}`;
  }
}

export function getStorageService(): IStorageServiceWithCopy {
  const config = getR2Config();
  if (config) {
    return new R2StorageProvider(config);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Cloudflare R2 storage credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) are strictly required in production'
    );
  }
  // Development/test fallback only. The mock lives in tests/helpers/ and is
  // never instantiated in production (R2 is always configured there).
  return getMockStorageProvider();
}
