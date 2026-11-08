import { describe, expect, it, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { POST as initiatePost } from '../../src/app/api/tenant/[subdomain]/media/multipart/initiate/route';

/**
 * Storage quota gate (plan check) for multipart initiate.
 *
 * Composer staged uploads (purpose 'post-staging') skip the gate
 * entirely: post-staging bytes never enter the Media Library, so a
 * plan with no library storage must not refuse them. Library
 * uploads keep the gate exactly as before (403 no-quota, 413
 * over-quota). The gate is driven here through the real
 * checkStorageQuota via a mocked quota-state lookup, and the admin
 * client through a minimal fake (role lookup only) — the route has
 * no provider seam, unlike the single-PUT upload-url route.
 */

const fakeS3 = vi.hoisted(() => ({
  sent: [] as string[],
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
        return {};
      },
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://mock-r2.fbuploadpro.com/upload/thumbnail'),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

const { mockGetAdminClient, mockGetQuotaState } = vi.hoisted(() => ({
  mockGetAdminClient: vi.fn(),
  mockGetQuotaState: vi.fn(),
}));

vi.mock('@/lib/auth/clients', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSupabaseAdminClient: mockGetAdminClient };
});

vi.mock('@/lib/billing/storage-quota', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getStorageQuotaState: mockGetQuotaState };
});

/** Minimal fake admin client: only the users-table role lookup runs. */
const fakeAdminClient = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { role: 'user' }, error: null }),
      }),
    }),
  }),
};

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const NO_QUOTA_MESSAGE =
  'Your plan includes no Media Library storage. Upgrade to a paid plan to upload files.';

describe('Multipart initiate storage quota gate (plan check)', () => {
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
    mockGetAdminClient.mockReset();
    mockGetQuotaState.mockReset();
    mockGetAdminClient.mockReturnValue(fakeAdminClient as never);

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

  function initiateRequest(purpose: 'library' | 'post-staging'): NextRequest {
    return new NextRequest('http://localhost:3000/api/tenant/acme/media/multipart/initiate', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({
        fileName: 'clip.mp4',
        fileSize: 20 * 1024 * 1024,
        mimeType: 'video/mp4',
        purpose,
      }),
    });
  }

  const params = { params: Promise.resolve({ subdomain: 'acme' }) };

  it('post-staging upload with quota 0 succeeds — the gate is skipped (the reported bug)', async () => {
    mockGetQuotaState.mockResolvedValue({ quotaBytes: 0, usedBytes: 0 });

    const res = await initiatePost(initiateRequest('post-staging'), params);

    expect(res.status).toBe(200);
    expect(mockGetQuotaState).not.toHaveBeenCalled();
    expect(mockGetAdminClient).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.uploadId).toBe('mock-upload-id');
    expect(body.mediaKey).toMatch(
      new RegExp(`^users/${userId}/post-staging/[^/]+/clip\\.mp4$`)
    );
    expect(fakeS3.sent).toContain('CreateMultipartUploadCommand');
  });

  it('post-staging upload over quota succeeds', async () => {
    mockGetQuotaState.mockResolvedValue({ quotaBytes: 5368709120, usedBytes: 5368709120 });

    const res = await initiatePost(initiateRequest('post-staging'), params);

    expect(res.status).toBe(200);
    expect(mockGetQuotaState).not.toHaveBeenCalled();
    expect(mockGetAdminClient).not.toHaveBeenCalled();
  });

  it('library upload with quota 0 is still refused with 403 and the same message', async () => {
    mockGetQuotaState.mockResolvedValue({ quotaBytes: 0, usedBytes: 0 });

    const res = await initiatePost(initiateRequest('library'), params);

    expect(res.status).toBe(403);
    expect(mockGetQuotaState).toHaveBeenCalledWith(fakeAdminClient, userId);
    const body = await res.json();
    expect(body.error).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(body.message).toBe(NO_QUOTA_MESSAGE);
    expect(fakeS3.sent).not.toContain('CreateMultipartUploadCommand');
  });

  it('library upload over quota is still refused with 413', async () => {
    mockGetQuotaState.mockResolvedValue({ quotaBytes: 5368709120, usedBytes: 5368709120 });

    const res = await initiatePost(initiateRequest('library'), params);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(fakeS3.sent).not.toContain('CreateMultipartUploadCommand');
  });

  it('library upload with ample quota still succeeds', async () => {
    mockGetQuotaState.mockResolvedValue({ quotaBytes: 5368709120, usedBytes: 0 });

    const res = await initiatePost(initiateRequest('library'), params);

    expect(res.status).toBe(200);
    expect(mockGetQuotaState).toHaveBeenCalledWith(fakeAdminClient, userId);
    const body = await res.json();
    expect(body.uploadId).toBe('mock-upload-id');
    expect(fakeS3.sent).toContain('CreateMultipartUploadCommand');
  });
});
