import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getR2Config,
  createR2S3Client,
  R2ConfigSchema,
  R2_MAX_ATTEMPTS,
  R2_REQUEST_TIMEOUT_MS,
  R2_CONNECTION_TIMEOUT_MS,
  getB2Config,
  createB2S3Client,
  getB2Endpoint,
  B2ConfigSchema,
  B2_MAX_ATTEMPTS,
  B2_REQUEST_TIMEOUT_MS,
  B2_CONNECTION_TIMEOUT_MS,
} from '../../src/lib/storage';

/** The account's confirmed B2 region (verified live 2026-11-26). */
const B2_REGION = 'eu-central-003';

describe('Cloudflare R2 Storage Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('validates configuration schema correctly', () => {
    const valid = R2ConfigSchema.safeParse({
      accountId: 'acc_123',
      accessKeyId: 'key_123',
      secretAccessKey: 'sec_123',
      bucketName: 'media-bucket',
      publicUrl: 'https://media.fbuploadpro.com',
    });

    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.bucketName).toBe('media-bucket');
    }
  });

  it('returns null from getR2Config when environment variables are missing', () => {
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET_NAME;
    delete process.env.R2_PUBLIC_URL;

    expect(getR2Config()).toBeNull();
  });

  it('loads valid configuration when all environment variables are populated', () => {
    process.env.R2_ACCOUNT_ID = 'test_acc';
    process.env.R2_ACCESS_KEY_ID = 'test_key';
    process.env.R2_SECRET_ACCESS_KEY = 'test_secret';
    process.env.R2_BUCKET_NAME = 'test_bucket';
    process.env.R2_PUBLIC_URL = 'https://media.test.com';

    const config = getR2Config();
    expect(config).not.toBeNull();
    expect(config?.accountId).toBe('test_acc');
    expect(config?.bucketName).toBe('test_bucket');

    const client = createR2S3Client(config!);
    expect(client).toBeDefined();
    client.destroy();
  });

  it('configures explicit maxAttempts and request/connection timeouts (spec 139)', async () => {
    const client = createR2S3Client({
      accountId: 'acc_123',
      accessKeyId: 'key_123',
      secretAccessKey: 'sec_123',
      bucketName: 'media-bucket',
      publicUrl: 'https://media.fbuploadpro.com',
    });

    expect(R2_MAX_ATTEMPTS).toBe(3);
    expect(R2_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(R2_CONNECTION_TIMEOUT_MS).toBe(5_000);

    const resolvedMaxAttempts = client.config.maxAttempts;
    const maxAttempts =
      typeof resolvedMaxAttempts === 'function'
        ? await (resolvedMaxAttempts as () => Promise<number>)()
        : resolvedMaxAttempts;
    expect(maxAttempts).toBe(R2_MAX_ATTEMPTS);

    const handler = client.config.requestHandler as unknown as {
      httpHandlerConfigs?: () => Record<string, unknown>;
      configProvider?: Promise<Record<string, unknown>>;
    };
    expect(typeof handler.httpHandlerConfigs).toBe('function');
    // NodeHttpHandler resolves the plain options object we pass lazily
    // via its internal configProvider — the resolved config is what
    // every request actually runs with.
    const resolvedHandlerConfig = await handler.configProvider;
    expect(resolvedHandlerConfig).toMatchObject({
      requestTimeout: R2_REQUEST_TIMEOUT_MS,
      connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    });

    client.destroy();
  });
});

describe('Backblaze B2 Storage Configuration (spec 259)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('validates configuration schema correctly', () => {
    const valid = B2ConfigSchema.safeParse({
      applicationKeyId: 'b2_key_id',
      applicationKey: 'b2_application_key',
      bucketName: 'fbuploadpro-media-prod',
      region: B2_REGION,
    });

    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.bucketName).toBe('fbuploadpro-media-prod');
      expect(valid.data.region).toBe(B2_REGION);
    }
  });

  it('returns null from getB2Config when environment variables are missing', () => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    delete process.env.B2_BUCKET_NAME;
    delete process.env.B2_REGION;

    expect(getB2Config()).toBeNull();
  });

  it('returns null from getB2Config when any single B2 variable is missing', () => {
    process.env.B2_APPLICATION_KEY_ID = 'b2_key_id';
    process.env.B2_APPLICATION_KEY = 'b2_application_key';
    process.env.B2_BUCKET_NAME = 'fbuploadpro-media-prod';
    delete process.env.B2_REGION;

    expect(getB2Config()).toBeNull();
  });

  it('loads valid configuration when all environment variables are populated', () => {
    process.env.B2_APPLICATION_KEY_ID = 'test_key_id';
    process.env.B2_APPLICATION_KEY = 'test_application_key';
    process.env.B2_BUCKET_NAME = 'test_bucket';
    process.env.B2_REGION = B2_REGION;

    const config = getB2Config();
    expect(config).not.toBeNull();
    expect(config?.applicationKeyId).toBe('test_key_id');
    expect(config?.bucketName).toBe('test_bucket');
    expect(config?.region).toBe(B2_REGION);

    const client = createB2S3Client(config!);
    expect(client).toBeDefined();
    client.destroy();
  });

  it('derives the S3 endpoint from the region', () => {
    expect(getB2Endpoint(B2_REGION)).toBe('https://s3.eu-central-003.backblazeb2.com');
    expect(getB2Endpoint('us-west-004')).toBe('https://s3.us-west-004.backblazeb2.com');
  });

  it('builds the client against the B2 S3 endpoint with the real region (spec 259)', async () => {
    const client = createB2S3Client({
      applicationKeyId: 'b2_key_id',
      applicationKey: 'b2_application_key',
      bucketName: 'fbuploadpro-media-prod',
      region: B2_REGION,
    });

    const resolvedRegion = client.config.region;
    const region =
      typeof resolvedRegion === 'function'
        ? await (resolvedRegion as () => Promise<string>)()
        : resolvedRegion;
    expect(region).toBe(B2_REGION);

    const endpoint = await client.config.endpoint!();
    expect((endpoint as unknown as { hostname: string }).hostname).toBe(
      's3.eu-central-003.backblazeb2.com'
    );

    client.destroy();
  });

  it('configures the same explicit maxAttempts and timeouts as R2 (spec 259)', async () => {
    const client = createB2S3Client({
      applicationKeyId: 'b2_key_id',
      applicationKey: 'b2_application_key',
      bucketName: 'fbuploadpro-media-prod',
      region: B2_REGION,
    });

    expect(B2_MAX_ATTEMPTS).toBe(3);
    expect(B2_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(B2_CONNECTION_TIMEOUT_MS).toBe(5_000);

    const resolvedMaxAttempts = client.config.maxAttempts;
    const maxAttempts =
      typeof resolvedMaxAttempts === 'function'
        ? await (resolvedMaxAttempts as () => Promise<number>)()
        : resolvedMaxAttempts;
    expect(maxAttempts).toBe(B2_MAX_ATTEMPTS);

    const handler = client.config.requestHandler as unknown as {
      httpHandlerConfigs?: () => Record<string, unknown>;
      configProvider?: Promise<Record<string, unknown>>;
    };
    expect(typeof handler.httpHandlerConfigs).toBe('function');
    const resolvedHandlerConfig = await handler.configProvider;
    expect(resolvedHandlerConfig).toMatchObject({
      requestTimeout: B2_REQUEST_TIMEOUT_MS,
      connectionTimeout: B2_CONNECTION_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    });

    client.destroy();
  });
});
