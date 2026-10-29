import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  DELETE,
  POST,
} from '@/app/api/tenant/[subdomain]/publishing/publish-now/temp-media/route';

/**
 * Publish Now temporary device-media route (PR #33), tested with
 * mocked session and storage — no real R2 call. Covers: presigned
 * upload URLs under the caller's own temp prefix, filename
 * sanitising, validation messages, the own-prefix-only delete
 * rule, and the storage-failure shapes.
 */

const extractConnectSession = vi.fn(async () => ({
  userId: 'user-1',
  role: 'admin',
  status: 'active',
}));

vi.mock('@/lib/connect/session', () => ({
  extractConnectSession: (...args: unknown[]) =>
    extractConnectSession(...args),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

const getPresignedUploadUrl = vi.fn(async ({ key }: { key: string }) => ({
  uploadUrl: `https://r2.example.com/${key}`,
  publicUrl: `https://media.example.com/${key}`,
}));
const deleteObject = vi.fn(async () => undefined);
let storageShouldThrow = false;

vi.mock('@/lib/storage', () => ({
  getStorageService: () => {
    if (storageShouldThrow) {
      throw new Error('storage down');
    }
    return { getPresignedUploadUrl, deleteObject };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  storageShouldThrow = false;
  extractConnectSession.mockResolvedValue({
    userId: 'user-1',
    role: 'admin',
    status: 'active',
  } as never);
});

async function callPost(body: unknown) {
  const request = new NextRequest(
    'http://localhost/api/tenant/acme/publishing/publish-now/temp-media',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }
  );
  const response = await POST(request, {
    params: Promise.resolve({ subdomain: 'acme' }),
  });
  return { status: response.status, body: await response.json() };
}

async function callDelete(body: unknown) {
  const request = new NextRequest(
    'http://localhost/api/tenant/acme/publishing/publish-now/temp-media',
    {
      method: 'DELETE',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }
  );
  const response = await DELETE(request, {
    params: Promise.resolve({ subdomain: 'acme' }),
  });
  return { status: response.status, body: await response.json() };
}

describe('POST publish-now temp-media', () => {
  it('issues a presigned URL under the caller temp prefix', async () => {
    const { status, body } = await callPost({
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
    });
    expect(status).toBe(200);
    expect(body.key).toMatch(/^users\/user-1\/publish-now-temp\//);
    expect(body.key).toContain('photo.jpg');
    expect(body.uploadUrl).toContain(body.key);
    expect(body.publicUrl).toContain(body.key);
    expect(body.expiresInSeconds).toBe(900);
    expect(getPresignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/jpeg' })
    );
  });

  it('normalises the image/jpg browser alias', async () => {
    const { status, body } = await callPost({
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpg',
    });
    expect(status).toBe(200);
    expect(getPresignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/jpeg' })
    );
    expect(body.key).toContain('photo.jpg');
  });

  it('sanitises path separators out of the file name', async () => {
    const { status, body } = await callPost({
      fileName: '../../evil.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
    });
    expect(status).toBe(200);
    // No path segment may be a traversal segment, and the key keeps
    // the users/<user>/publish-now-temp/<uuid>/<file> shape.
    expect(body.key.split('/')).not.toContain('..');
    expect(body.key.split('/').length).toBe(5);
  });

  it('returns plain-language validation failures, never a bare code', async () => {
    const badType = await callPost({
      fileName: 'clip.mkv',
      fileSize: 1024,
      mimeType: 'video/x-matroska',
    });
    expect(badType.status).toBe(400);
    expect(badType.body.message).toBe(
      'This file type is not supported. Choose an image or video.'
    );
    const empty = await callPost({
      fileName: 'photo.jpg',
      fileSize: 0,
      mimeType: 'image/jpeg',
    });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toContain('empty');
  });

  it('returns 401 without a session and 500 when storage is down', async () => {
    extractConnectSession.mockResolvedValueOnce(null as never);
    const unauthenticated = await callPost({
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
    });
    expect(unauthenticated.status).toBe(401);

    storageShouldThrow = true;
    const failed = await callPost({
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
    });
    expect(failed.status).toBe(500);
  });
});

describe('DELETE publish-now temp-media', () => {
  const ownKey = 'users/user-1/publish-now-temp/abc/photo.jpg';

  it('deletes a key under the caller temp prefix', async () => {
    const { status, body } = await callDelete({ key: ownKey });
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(deleteObject).toHaveBeenCalledWith(ownKey);
  });

  it('refuses keys outside the caller prefix and keys with dot-dot', async () => {
    const foreign = await callDelete({
      key: 'users/user-2/publish-now-temp/abc/photo.jpg',
    });
    expect(foreign.status).toBe(400);
    const traversal = await callDelete({
      key: 'users/user-1/publish-now-temp/../secret.jpg',
    });
    expect(traversal.status).toBe(400);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('reports deleted false with a 500 when storage fails', async () => {
    storageShouldThrow = true;
    const { status, body } = await callDelete({ key: ownKey });
    expect(status).toBe(500);
    expect(body.deleted).toBe(false);
  });
});
