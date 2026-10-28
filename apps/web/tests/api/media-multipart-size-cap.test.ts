import { describe, expect, it, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { POST as initiatePost } from '../../src/app/api/tenant/[subdomain]/media/multipart/initiate/route';
import { POST as completePost } from '../../src/app/api/tenant/[subdomain]/media/multipart/complete/route';

/**
 * Server-side 500 MB cap for multipart uploads.
 *
 * The S3 client is faked at the storage-module seam (createR2S3Client),
 * so no R2 call ever leaves the test: initiate mints an upload id,
 * complete lists whatever parts the test configures. The thumbnail
 * presign is faked at the presigner seam.
 */

const fakeS3 = vi.hoisted(() => ({
  sent: [] as string[],
  parts: [] as Array<{ PartNumber: number; ETag: string; Size?: number }>,
}));

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createR2S3Client: () => ({
      send: async (command: { constructor: { name: string } }) => {
        fakeS3.sent.push(command.constructor.name);
        if (command.constructor.name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'mock-upload-id' };
        }
        if (command.constructor.name === 'ListPartsCommand') {
          return { Parts: fakeS3.parts };
        }
        return {};
      },
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://mock-r2.fbuploadpro.com/upload/thumbnail'),
}));

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const MAX_BYTES = 524288000; // 500 MB, must match the initiate schema max

describe('Multipart 500 MB server-side cap', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'test-bucket';
    process.env.R2_PUBLIC_URL = 'https://media.fbuploadpro.com';
    fakeS3.sent = [];
    fakeS3.parts = [];

    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  function initiateRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost:3000/api/tenant/acme/media/multipart/initiate', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify(body),
    });
  }

  function completeRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost:3000/api/tenant/acme/media/multipart/complete', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify(body),
    });
  }

  const params = { params: Promise.resolve({ subdomain: 'acme' }) };

  it('rejects a declared fileSize over 500 MB at initiate, before any upload is created', async () => {
    const res = await initiatePost(
      initiateRequest({
        fileName: 'huge.mp4',
        fileSize: MAX_BYTES + 1, // 500 MB + 1 byte
        mimeType: 'video/mp4',
      }),
      params
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
    expect(fakeS3.sent).not.toContain('CreateMultipartUploadCommand');
  });

  it('accepts a declared fileSize of exactly 500 MB at initiate', async () => {
    const res = await initiatePost(
      initiateRequest({
        fileName: 'big.mp4',
        fileSize: MAX_BYTES,
        mimeType: 'video/mp4',
      }),
      params
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadId).toBe('mock-upload-id');
    expect(fakeS3.sent).toContain('CreateMultipartUploadCommand');
  });

  it('rejects actual uploaded bytes over 500 MB at complete and aborts instead of assembling', async () => {
    fakeS3.parts = [
      { PartNumber: 1, ETag: 'etag-1', Size: MAX_BYTES },
      { PartNumber: 2, ETag: 'etag-2', Size: 1 },
    ];
    const res = await completePost(
      completeRequest({
        key: `users/${userId}/media/some-id/big.mp4`,
        uploadId: 'mock-upload-id',
        expectedPartCount: 2,
      }),
      params
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Multipart upload exceeds the 500 MB limit');
    expect(fakeS3.sent).toContain('AbortMultipartUploadCommand');
    expect(fakeS3.sent).not.toContain('CompleteMultipartUploadCommand');
  });

  it('assembles actual uploaded bytes of exactly 500 MB at complete', async () => {
    fakeS3.parts = [{ PartNumber: 1, ETag: 'etag-1', Size: MAX_BYTES }];
    const res = await completePost(
      completeRequest({
        key: `users/${userId}/media/some-id/big.mp4`,
        uploadId: 'mock-upload-id',
        expectedPartCount: 1,
      }),
      params
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe(`users/${userId}/media/some-id/big.mp4`);
    expect(fakeS3.sent).toContain('CompleteMultipartUploadCommand');
    expect(fakeS3.sent).not.toContain('AbortMultipartUploadCommand');
  });

  it('rejects a declared size under the cap when the actual bytes exceed it (declared size is not trusted)', async () => {
    fakeS3.parts = [
      { PartNumber: 1, ETag: 'etag-1', Size: 300 * 1024 * 1024 },
      { PartNumber: 2, ETag: 'etag-2', Size: 300 * 1024 * 1024 },
    ];
    const res = await completePost(
      completeRequest({
        key: `users/${userId}/media/some-id/sneaky.mp4`,
        uploadId: 'mock-upload-id',
        expectedPartCount: 2,
      }),
      params
    );

    expect(res.status).toBe(400);
    expect(fakeS3.sent).toContain('AbortMultipartUploadCommand');
    expect(fakeS3.sent).not.toContain('CompleteMultipartUploadCommand');
  });
});
