import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleCreateUploadUrl } from '../../src/app/api/tenant/[subdomain]/media/upload-url/route';
import { MockStorageProvider } from '../helpers/mock-storage';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Presigned Upload URL Endpoint (POST /api/tenant/[subdomain]/media/upload-url)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;
  let mockStorage: MockStorageProvider;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;

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
    mockStorage = new MockStorageProvider();
  });

  it('rejects unauthenticated requests with 401 Unauthorized', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        fileName: 'reel.mp4',
        fileSize: 10485760,
        mimeType: 'video/mp4',
      }),
    });
    const res = await handleCreateUploadUrl(req, 'acme');

    expect(res.status).toBe(401);
  });

  it('rejects cross-tenant requests with 403 Forbidden', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/other-tenant/media/upload-url', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({
        fileName: 'reel.mp4',
        fileSize: 10485760,
        mimeType: 'video/mp4',
      }),
    });
    const res = await handleCreateUploadUrl(req, 'other-tenant');

    expect(res.status).toBe(403);
  });

  it('rejects unsupported MIME types with 400 Bad Request', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/upload-url', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({
        fileName: 'script.exe',
        fileSize: 1024,
        mimeType: 'application/x-msdownload',
      }),
    });
    const res = await handleCreateUploadUrl(req, 'acme');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
  });

  it('rejects files exceeding 500 MB limit with 400 Bad Request', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/upload-url', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({
        fileName: 'huge.mp4',
        fileSize: 524288001, // 500 MB + 1 byte
        mimeType: 'video/mp4',
      }),
    });
    const res = await handleCreateUploadUrl(req, 'acme');

    expect(res.status).toBe(400);
  });

  it('generates presigned PUT URLs with hierarchical isolation and valid response contract', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/upload-url', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({
        fileName: 'summer vacation promo.mp4',
        fileSize: 20971520, // 20 MB
        mimeType: 'video/mp4',
        thumbnailMimeType: 'image/webp',
      }),
    });
    const res = await handleCreateUploadUrl(req, 'acme', mockStorage);

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.mediaId).toBeDefined();
    expect(data.mediaKey).toBe(
      `users/${userId}/media/${data.mediaId}/summer_vacation_promo.mp4`
    );
    expect(data.mediaUploadUrl).toContain('mock-r2.fbuploadpro.com/upload/');
    expect(data.thumbnailKey).toBe(`users/${userId}/thumbnails/${data.mediaId}.webp`);
    expect(data.thumbnailUploadUrl).toContain('mock-r2.fbuploadpro.com/upload/');
    expect(data.publicMediaUrl).toBe(
      `https://media.fbuploadpro.com/users/${userId}/media/${data.mediaId}/summer_vacation_promo.mp4`
    );
    expect(data.publicThumbnailUrl).toBe(
      `https://media.fbuploadpro.com/users/${userId}/thumbnails/${data.mediaId}.webp`
    );
    expect(data.expiresInSeconds).toBe(900);
  });

  it('preserves non-Latin and Unicode characters in filenames (Spec 046)', async () => {
    const unicodeName = 'فيديو_تسويقي_2026.mp4';
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/upload-url', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({
        fileName: unicodeName,
        fileSize: 1048576,
        mimeType: 'video/mp4',
        thumbnailMimeType: 'image/webp',
      }),
    });
    const res = await handleCreateUploadUrl(req, 'acme', mockStorage);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mediaKey).toContain('فيديو_تسويقي_2026');
    expect(data.mediaKey).not.toContain('____________');
  });

  it('mints post-staging keys for purpose post-staging (composer uploads, never the library)', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/upload-url', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({
        fileName: 'clip.mp4',
        fileSize: 20971520,
        mimeType: 'video/mp4',
        thumbnailMimeType: 'image/webp',
        purpose: 'post-staging',
      }),
    });
    const res = await handleCreateUploadUrl(req, 'acme', mockStorage);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mediaKey).toBe(
      `users/${userId}/post-staging/${data.mediaId}/clip.mp4`
    );
    expect(data.thumbnailKey).toBe(
      `users/${userId}/post-staging/${data.mediaId}/thumbnail.webp`
    );
    expect(data.mediaKey).not.toContain('/media/');
    expect(data.publicMediaUrl).toBe(
      `https://media.fbuploadpro.com/users/${userId}/post-staging/${data.mediaId}/clip.mp4`
    );
  });
});
