import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  R2StorageProvider,
  B2StorageProvider,
  DualStorageProvider,
  getWriteBackendClient,
  isStorageNotFoundError,
  type B2Config,
  type R2Config,
} from '../../src/lib/storage';
import { getMultipartClient } from '../../src/app/api/tenant/[subdomain]/media/multipart/multipart-lib';
import { probeHealth } from '../../src/app/api/health/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

/**
 * Dual-backend behaviour (spec 259). Every test runs against in-memory
 * fake S3 clients — no live B2 (or R2) is ever touched.
 */

const B2_REGION = 'eu-central-003';
const PUBLIC_BASE = 'https://media.vinsmokemedia.online';

const b2Config: B2Config = {
  applicationKeyId: 'b2_key_id',
  applicationKey: 'b2_application_key',
  bucketName: 'fbuploadpro-media-prod',
  region: B2_REGION,
};

const r2Config: R2Config = {
  accountId: 'fake_account',
  accessKeyId: 'fake_key',
  secretAccessKey: 'fake_secret',
  bucketName: 'fake_bucket',
  publicUrl: PUBLIC_BASE,
};

function notFoundError(): Error {
  const err = new Error('NoSuchKey') as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = 'NoSuchKey';
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

function serverError(): Error {
  const err = new Error('InternalError') as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = 'InternalError';
  err.$metadata = { httpStatusCode: 500 };
  return err;
}

interface StoredObject {
  body: Uint8Array;
  contentType?: string | undefined;
  lastModified: Date;
}

interface FakeCall {
  name: string;
  input: Record<string, unknown>;
}

/** Minimal in-memory S3 stand-in: one bucket's objects + a call log. */
class FakeS3Client {
  readonly store = new Map<string, StoredObject>();
  readonly calls: FakeCall[] = [];
  failGetWith: Error | null = null;
  failDeleteWith: Error | null = null;

  constructor(readonly bucketName: string) {}

  seed(key: string, body: Uint8Array, contentType = 'video/mp4', lastModified = new Date()): void {
    this.store.set(key, { body, contentType, lastModified });
  }

  async send(command: { input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const name = command.constructor.name;
    const input = command.input;
    this.calls.push({ name, input });
    switch (name) {
      case 'PutObjectCommand': {
        this.store.set(input.Key as string, {
          body: input.Body as Uint8Array,
          contentType: input.ContentType as string | undefined,
          lastModified: new Date(),
        });
        return {};
      }
      case 'GetObjectCommand': {
        if (this.failGetWith) throw this.failGetWith;
        const entry = this.store.get(input.Key as string);
        if (!entry) throw notFoundError();
        return {
          Body: { transformToByteArray: async () => entry.body },
          ContentType: entry.contentType,
        };
      }
      case 'DeleteObjectCommand': {
        if (this.failDeleteWith) throw this.failDeleteWith;
        this.store.delete(input.Key as string);
        return {};
      }
      case 'CopyObjectCommand': {
        const copySource = input.CopySource as string;
        const slash = copySource.indexOf('/');
        const sourceKey = copySource
          .slice(slash + 1)
          .split('/')
          .map((segment) => decodeURIComponent(segment))
          .join('/');
        const entry = this.store.get(sourceKey);
        if (!entry) throw notFoundError();
        this.store.set(input.Key as string, { ...entry, lastModified: new Date() });
        return {};
      }
      case 'ListObjectsV2Command': {
        const prefix = (input.Prefix as string) ?? '';
        const contents = [...this.store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([Key, value]) => ({ Key, LastModified: value.lastModified }));
        return { Contents: contents };
      }
      case 'HeadObjectCommand': {
        const entry = this.store.get(input.Key as string);
        if (!entry) throw notFoundError();
        return { ContentLength: entry.body.byteLength, ContentType: entry.contentType };
      }
      default:
        throw new Error(`FakeS3Client: unexpected command ${name}`);
    }
  }
}

function buildDual(): {
  dual: DualStorageProvider;
  b2Client: FakeS3Client;
  r2Client: FakeS3Client;
} {
  const b2Client = new FakeS3Client(b2Config.bucketName);
  const r2Client = new FakeS3Client(r2Config.bucketName);
  const write = new B2StorageProvider(b2Config, PUBLIC_BASE, b2Client as never);
  const read = new R2StorageProvider(r2Config, r2Client as never);
  return { dual: new DualStorageProvider(write, read), b2Client, r2Client };
}

async function clientHostname(client: { config: { endpoint: () => Promise<unknown> } }): Promise<string> {
  const endpoint = (await client.config.endpoint()) as { hostname: string };
  return endpoint.hostname;
}

describe('DualStorageProvider (spec 259)', () => {
  it('writes go to the write backend only', async () => {
    const { dual, b2Client, r2Client } = buildDual();
    const body = new Uint8Array([1, 2, 3]);

    const result = await dual.putObject({ key: 'users/u1/media/a.mp4', body, contentType: 'video/mp4' });

    expect(result.key).toBe('users/u1/media/a.mp4');
    expect(result.publicUrl).toBe(`${PUBLIC_BASE}/users/u1/media/a.mp4`);
    expect(b2Client.store.get('users/u1/media/a.mp4')?.body).toEqual(body);
    expect(r2Client.store.size).toBe(0);
    expect(r2Client.calls).toEqual([]);
  });

  it('presigned upload URL host is the write backend endpoint', async () => {
    const b2Provider = new B2StorageProvider(b2Config, PUBLIC_BASE);
    const b2Result = await b2Provider.getPresignedUploadUrl({
      key: 'users/u1/media/a.mp4',
      contentType: 'video/mp4',
    });
    // B2 presigns virtual-hosted style: the bucket is a subdomain of
    // the S3 endpoint host.
    expect(new URL(b2Result.uploadUrl).hostname).toBe(
      'fbuploadpro-media-prod.s3.eu-central-003.backblazeb2.com'
    );
    expect(b2Result.publicUrl).toBe(`${PUBLIC_BASE}/users/u1/media/a.mp4`);

    const r2Provider = new R2StorageProvider(r2Config);
    const r2Result = await r2Provider.getPresignedUploadUrl({
      key: 'users/u1/media/a.mp4',
      contentType: 'video/mp4',
    });
    expect(new URL(r2Result.uploadUrl).hostname).toBe('fake_account.r2.cloudflarestorage.com');
  });

  it('getPublicUrl is the shared public base for both backends', () => {
    const { dual } = buildDual();
    expect(dual.getPublicUrl('users/u1/media/a.mp4')).toBe(
      `${PUBLIC_BASE}/users/u1/media/a.mp4`
    );
  });

  it('cross-backend copy: source only on R2 lands on B2 with the same bytes', async () => {
    const { dual, b2Client, r2Client } = buildDual();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    r2Client.seed('users/u1/media/old.mp4', bytes, 'video/mp4');

    await dual.copyObject({
      sourceKey: 'users/u1/media/old.mp4',
      destinationKey: 'users/u1/post-media/x/old.mp4',
    });

    const copied = b2Client.store.get('users/u1/post-media/x/old.mp4');
    expect(copied?.body).toEqual(bytes);
    expect(copied?.contentType).toBe('video/mp4');
    // The write backend tried its server-side copy first (missed),
    // then streamed the bytes across from R2.
    expect(b2Client.calls.map((call) => call.name)).toContain('CopyObjectCommand');
    expect(b2Client.calls.map((call) => call.name)).toContain('PutObjectCommand');
    expect(r2Client.calls.map((call) => call.name)).toContain('GetObjectCommand');
    // The R2 original is untouched — the backfill owns the R2 copy.
    expect(r2Client.store.get('users/u1/media/old.mp4')?.body).toEqual(bytes);
  });

  it('copy: source on the write backend takes the server-side path, R2 untouched', async () => {
    const { dual, b2Client, r2Client } = buildDual();
    const bytes = new Uint8Array([4, 5, 6]);
    b2Client.seed('users/u1/media/new.mp4', bytes, 'video/mp4');

    await dual.copyObject({
      sourceKey: 'users/u1/media/new.mp4',
      destinationKey: 'users/u1/post-media/x/new.mp4',
    });

    expect(b2Client.store.get('users/u1/post-media/x/new.mp4')?.body).toEqual(bytes);
    expect(r2Client.calls).toEqual([]);
    expect(b2Client.calls.map((call) => call.name)).toEqual(['CopyObjectCommand']);
  });

  it('copy: source on neither backend fails loud', async () => {
    const { dual } = buildDual();
    await expect(
      dual.copyObject({ sourceKey: 'users/u1/media/gone.mp4', destinationKey: 'users/u1/post-media/x/gone.mp4' })
    ).rejects.toThrow(/source object not found on either backend/);
  });

  it('copy: a non-NotFound read failure fails loud instead of falling back silently', async () => {
    const { dual, r2Client } = buildDual();
    r2Client.failGetWith = serverError();
    await expect(
      dual.copyObject({ sourceKey: 'users/u1/media/old.mp4', destinationKey: 'users/u1/post-media/x/old.mp4' })
    ).rejects.toThrow('InternalError');
  });

  it('dual delete: object on R2 only is deleted from R2', async () => {
    const { dual, b2Client, r2Client } = buildDual();
    r2Client.seed('users/u1/media/old.mp4', new Uint8Array([1]));

    await dual.deleteObject('users/u1/media/old.mp4');

    expect(r2Client.store.has('users/u1/media/old.mp4')).toBe(false);
    expect(b2Client.calls.map((call) => call.name)).toEqual(['DeleteObjectCommand']);
    expect(r2Client.calls.map((call) => call.name)).toEqual(['DeleteObjectCommand']);
  });

  it('dual delete: object on B2 is deleted from B2', async () => {
    const { dual, b2Client, r2Client } = buildDual();
    b2Client.seed('users/u1/media/new.mp4', new Uint8Array([1]));

    await dual.deleteObject('users/u1/media/new.mp4');

    expect(b2Client.store.has('users/u1/media/new.mp4')).toBe(false);
    expect(r2Client.store.has('users/u1/media/new.mp4')).toBe(false);
  });

  it('dual delete: a failure on either backend fails loud', async () => {
    const { dual, r2Client } = buildDual();
    r2Client.failDeleteWith = serverError();
    await expect(dual.deleteObject('users/u1/media/old.mp4')).rejects.toThrow('InternalError');
  });

  it('listObjects returns the union of both backends, deduplicated by key', async () => {
    const { dual, b2Client, r2Client } = buildDual();
    const b2Date = new Date('2026-11-26T00:00:00.000Z');
    const r2Date = new Date('2026-11-20T00:00:00.000Z');
    b2Client.seed('users/u1/post-staging/b2-only.mp4', new Uint8Array([1]), 'video/mp4', b2Date);
    b2Client.seed('users/u1/post-staging/shared.mp4', new Uint8Array([2]), 'video/mp4', b2Date);
    r2Client.seed('users/u1/post-staging/r2-only.mp4', new Uint8Array([3]), 'video/mp4', r2Date);
    r2Client.seed('users/u1/post-staging/shared.mp4', new Uint8Array([4]), 'video/mp4', r2Date);

    const listed = await dual.listObjects({ prefix: 'users/u1/post-staging/' });

    expect(listed.map((entry) => entry.key).sort()).toEqual([
      'users/u1/post-staging/b2-only.mp4',
      'users/u1/post-staging/r2-only.mp4',
      'users/u1/post-staging/shared.mp4',
    ]);
    // On a collision the write backend's entry wins.
    expect(listed.find((entry) => entry.key === 'users/u1/post-staging/shared.mp4')).toEqual({
      key: 'users/u1/post-staging/shared.mp4',
      lastModified: b2Date,
    });
  });

  it('isStorageNotFoundError recognises every NotFound spelling', () => {
    expect(isStorageNotFoundError(notFoundError())).toBe(true);
    expect(isStorageNotFoundError({ name: 'NotFound' })).toBe(true);
    expect(isStorageNotFoundError({ Code: 'NoSuchKey' })).toBe(true);
    expect(isStorageNotFoundError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isStorageNotFoundError(serverError())).toBe(false);
    expect(isStorageNotFoundError(new Error('boom'))).toBe(false);
    expect(isStorageNotFoundError(null)).toBe(false);
  });
});

describe('Write-backend client selection (spec 259)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const setR2Env = () => {
    process.env.R2_ACCOUNT_ID = 'prod_acc';
    process.env.R2_ACCESS_KEY_ID = 'prod_key';
    process.env.R2_SECRET_ACCESS_KEY = 'prod_secret';
    process.env.R2_BUCKET_NAME = 'prod_bucket';
    process.env.R2_PUBLIC_URL = PUBLIC_BASE;
  };

  const setB2Env = () => {
    process.env.B2_APPLICATION_KEY_ID = 'b2_key_id';
    process.env.B2_APPLICATION_KEY = 'b2_application_key';
    process.env.B2_BUCKET_NAME = 'fbuploadpro-media-prod';
    process.env.B2_REGION = B2_REGION;
    process.env.R2_PUBLIC_URL = PUBLIC_BASE;
  };

  const clearStorageEnv = () => {
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET_NAME;
    delete process.env.R2_PUBLIC_URL;
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    delete process.env.B2_BUCKET_NAME;
    delete process.env.B2_REGION;
  };

  it('getWriteBackendClient returns the B2 client when both backends are configured', async () => {
    clearStorageEnv();
    setR2Env();
    setB2Env();

    const backend = getWriteBackendClient();
    expect(backend).not.toBeNull();
    expect(backend?.bucketName).toBe('fbuploadpro-media-prod');
    expect(backend?.publicUrl).toBe(PUBLIC_BASE);
    expect(await clientHostname(backend!.client)).toBe('s3.eu-central-003.backblazeb2.com');
  });

  it('getWriteBackendClient returns the B2 client when only B2 is configured', async () => {
    clearStorageEnv();
    setB2Env();

    const backend = getWriteBackendClient();
    expect(backend?.bucketName).toBe('fbuploadpro-media-prod');
    expect(await clientHostname(backend!.client)).toBe('s3.eu-central-003.backblazeb2.com');
  });

  it('getWriteBackendClient returns the R2 client when only R2 is configured', async () => {
    clearStorageEnv();
    setR2Env();

    const backend = getWriteBackendClient();
    expect(backend?.bucketName).toBe('prod_bucket');
    expect(await clientHostname(backend!.client)).toBe('prod_acc.r2.cloudflarestorage.com');
  });

  it('getWriteBackendClient returns null when neither backend is configured', () => {
    clearStorageEnv();
    expect(getWriteBackendClient()).toBeNull();
  });

  it('multipart client uses the write backend (B2 when configured)', async () => {
    clearStorageEnv();
    setR2Env();
    setB2Env();

    const result = getMultipartClient();
    expect('client' in result).toBe(true);
    if (!('client' in result)) return;
    expect(result.config.bucketName).toBe('fbuploadpro-media-prod');
    expect(result.config.publicUrl).toBe(PUBLIC_BASE);
    expect(await clientHostname(result.client)).toBe('s3.eu-central-003.backblazeb2.com');
  });

  it('multipart client uses R2 when only R2 is configured', async () => {
    clearStorageEnv();
    setR2Env();

    const result = getMultipartClient();
    expect('client' in result).toBe(true);
    if (!('client' in result)) return;
    expect(result.config.bucketName).toBe('prod_bucket');
    expect(await clientHostname(result.client)).toBe('prod_acc.r2.cloudflarestorage.com');
  });

  it('multipart client returns 503 when no backend is configured', async () => {
    clearStorageEnv();
    const result = getMultipartClient();
    expect('client' in result).toBe(false);
    if ('client' in result) return;
    expect(result.status).toBe(503);
  });
});

describe('Health storage check with B2 only (spec 259)', () => {
  // 64 hex chars, deliberately not the dev fallback key.
  const VALID_TOKEN_KEY =
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
  const healthyDb = () => ({ query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });

  const baseEnv: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'session-secret-value-that-is-long-enough-123456',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
    TOKEN_ENCRYPTION_KEY: VALID_TOKEN_KEY,
    B2_APPLICATION_KEY_ID: 'b2_key_id',
    B2_APPLICATION_KEY: 'b2_application_key',
    B2_BUCKET_NAME: 'fbuploadpro-media-prod',
    B2_REGION: B2_REGION,
  };

  it('reports config healthy with B2 configured and no R2 vars', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const res = await probeHealth(healthyDb() as unknown as DatabaseClient, 2000, {
      env: { ...baseEnv },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload.checks.config).toBe(true);
  });

  it('reports config unhealthy when B2 is incomplete and R2 is absent', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const env = { ...baseEnv };
    delete env.B2_BUCKET_NAME;
    const res = await probeHealth(healthyDb() as unknown as DatabaseClient, 2000, {
      env,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(res.statusCode).toBe(503);
    expect(res.payload.checks.config).toBe(false);
  });
});
