import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockStorageProvider, getMockStorageProvider } from '../helpers/mock-storage';
import {
  R2StorageProvider,
  getStorageService,
  type R2Config,
} from '../../src/lib/storage';

describe('Storage Service Providers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('MockStorageProvider', () => {
    it('generates presigned upload URLs and computes public URLs', async () => {
      const mock = new MockStorageProvider();
      const result = await mock.getPresignedUploadUrl({
        key: 'users/123/media/abc/video.mp4',
        contentType: 'video/mp4',
        expiresInSeconds: 600,
      });

      expect(result.expiresInSeconds).toBe(600);
      expect(result.uploadUrl).toContain('mock-r2.fbuploadpro.com');
      expect(result.uploadUrl).toContain(encodeURIComponent('users/123/media/abc/video.mp4'));
      expect(result.publicUrl).toBe('https://media.fbuploadpro.com/users/123/media/abc/video.mp4');
      expect(mock.requestedUploadKeys.has('users/123/media/abc/video.mp4')).toBe(true);
    });

    it('uploads objects via putObject and tracks uploadedObjects', async () => {
      const mock = new MockStorageProvider();
      const key = 'users/123/media/abc/downloaded.mp4';
      const payload = new Uint8Array([1, 2, 3, 4, 5]);

      const result = await mock.putObject({
        key,
        body: payload,
        contentType: 'video/mp4',
      });

      expect(result.key).toBe(key);
      expect(result.publicUrl).toBe('https://media.fbuploadpro.com/users/123/media/abc/downloaded.mp4');
      expect(result.byteLength).toBe(5);
      expect(mock.uploadedObjects.get(key)).toEqual({
        contentType: 'video/mp4',
        byteLength: 5,
        // Added with the media/posting separation: the mock tracks
        // upload time so listObjects can report lastModified for
        // the staged-upload sweep's age check.
        uploadedAt: expect.any(Date),
      });

      await mock.deleteObject(key);
      expect(mock.uploadedObjects.has(key)).toBe(false);
    });

    it('deletes objects and updates tracked keys', async () => {
      const mock = new MockStorageProvider();
      const key = 'users/123/media/abc/image.png';

      await mock.getPresignedUploadUrl({ key, contentType: 'image/png' });
      expect(mock.requestedUploadKeys.has(key)).toBe(true);

      await mock.deleteObject(key);
      expect(mock.deletedKeys.has(key)).toBe(true);
      expect(mock.requestedUploadKeys.has(key)).toBe(false);

      mock.reset();
      expect(mock.deletedKeys.size).toBe(0);
    });
  });

  describe('R2StorageProvider', () => {
    const fakeConfig: R2Config = {
      accountId: 'fake_account',
      accessKeyId: 'fake_key',
      secretAccessKey: 'fake_secret',
      bucketName: 'fake_bucket',
      publicUrl: 'https://media.customdomain.com',
    };

    it('computes public URLs correctly using config publicUrl', () => {
      const provider = new R2StorageProvider(fakeConfig);
      const url = provider.getPublicUrl('users/tenant-1/media/file.mp4');
      expect(url).toBe('https://media.customdomain.com/users/tenant-1/media/file.mp4');
    });

    it('invokes client PutObjectCommand upon putObject', async () => {
      const mockSend = vi.fn().mockResolvedValue({});
      const fakeS3Client = { send: mockSend } as any;
      const body = new Uint8Array([10, 20, 30, 40]);

      const provider = new R2StorageProvider(fakeConfig, fakeS3Client);
      const res = await provider.putObject({
        key: 'users/tenant-1/media/file.mp4',
        body,
        contentType: 'video/mp4',
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(res).toEqual({
        key: 'users/tenant-1/media/file.mp4',
        publicUrl: 'https://media.customdomain.com/users/tenant-1/media/file.mp4',
        byteLength: 4,
      });
    });

    it('invokes client delete command upon deleteObject', async () => {
      const mockSend = vi.fn().mockResolvedValue({});
      const fakeS3Client = { send: mockSend } as any;

      const provider = new R2StorageProvider(fakeConfig, fakeS3Client);
      await provider.deleteObject('users/tenant-1/media/file.mp4');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStorageService Factory', () => {
    it('returns MockStorageProvider when R2 environment is unconfigured in development/test', () => {
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      (process.env as any).NODE_ENV = 'test';

      const service = getStorageService();
      expect(service).toBeInstanceOf(MockStorageProvider);
    });

    it('throws in production when R2 environment is unconfigured', () => {
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      (process.env as any).NODE_ENV = 'production';

      expect(() => getStorageService()).toThrow(
        /Cloudflare R2 storage credentials .* are strictly required in production/
      );
    });

    it('returns R2StorageProvider when valid R2 environment is configured', () => {
      (process.env as any).NODE_ENV = 'production';
      process.env.R2_ACCOUNT_ID = 'prod_acc';
      process.env.R2_ACCESS_KEY_ID = 'prod_key';
      process.env.R2_SECRET_ACCESS_KEY = 'prod_secret';
      process.env.R2_BUCKET_NAME = 'prod_bucket';
      process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

      const service = getStorageService();
      expect(service).toBeInstanceOf(R2StorageProvider);
    });
  });
});
