import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { DELETE } from '@/app/api/tenant/[subdomain]/publishing/publish-now/temp-media/route';

/**
 * Publish Now temp-media DELETE (media/posting separation),
 * tested with a mocked session and object storage. Covers: the
 * endpoint deletes post-owned keys (post-media and post-staging)
 * as well as temp keys, and still refuses library keys and keys
 * outside the caller's own prefix — so run cleanup can never
 * delete library bytes.
 */

vi.mock('@/lib/connect/session', () => ({
  extractConnectSession: vi.fn(async () => ({
    userId: 'user-1',
    subdomain: 'acme',
    role: 'user',
    status: 'active',
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

let deletedKeys: string[] = [];

vi.mock('@/lib/storage', () => ({
  getStorageService: () => ({
    deleteObject: async (key: string) => {
      deletedKeys.push(key);
    },
  }),
}));

beforeEach(() => {
  deletedKeys = [];
});

async function callDelete(key: string) {
  const request = new NextRequest(
    'http://localhost/api/tenant/acme/publishing/publish-now/temp-media',
    {
      method: 'DELETE',
      body: JSON.stringify({ key }),
      headers: { 'content-type': 'application/json' },
    }
  );
  const response = await DELETE(request, {
    params: Promise.resolve({ subdomain: 'acme' }),
  });
  return { status: response.status, body: await response.json() };
}

describe('DELETE publish-now/temp-media', () => {
  it('deletes a post-media key', async () => {
    const key =
      'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg';
    const { status, body } = await callDelete(key);
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(deletedKeys).toContain(key);
  });

  it('deletes a post-staging key', async () => {
    const key =
      'users/user-1/post-staging/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/photo.jpg';
    const { status, body } = await callDelete(key);
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(deletedKeys).toContain(key);
  });

  it('still deletes a temp key', async () => {
    const key = 'users/user-1/publish-now-temp/abc/photo.jpg';
    const { status, body } = await callDelete(key);
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(deletedKeys).toContain(key);
  });

  it('refuses a library key and a foreign post-owned key', async () => {
    const library = await callDelete('users/user-1/library/photo.jpg');
    expect(library.status).toBe(400);
    expect(deletedKeys).not.toContain('users/user-1/library/photo.jpg');

    const foreign = await callDelete(
      'users/user-2/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg'
    );
    expect(foreign.status).toBe(400);
    expect(deletedKeys).toHaveLength(0);
  });
});
