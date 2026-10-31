import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as instagramPost } from '@/app/api/tenant/[subdomain]/instagram/publish-now/route';
import { POST as threadsPost } from '@/app/api/tenant/[subdomain]/threads/publish-now/route';

/**
 * Instagram/Threads Publish Now post-owned guards (media/posting
 * separation): the shared request schema accepts the 'post-owned'
 * media source, so each route rejects it explicitly with 400
 * before any account, subscription, or Graph work. Net behaviour
 * is unchanged — it previously failed enum validation with 400 —
 * only the message is clearer. These tests pin the guards.
 */

vi.mock('@/lib/connect/session', () => ({
  resolveSocialRouteContext: vi.fn(async () => ({
    session: { userId: 'user-1' },
    workspaceId: 'ws-1',
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
  trackServerEvent: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  getR2Config: () => ({ publicUrl: 'https://r2.example.com' }),
}));

vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => ({}),
}));

const ACCOUNT_ID = '11111111-1111-4111-a111-111111111111';

function postOwnedMedia() {
  return {
    source: 'post-owned' as const,
    mediaId: null,
    tempKey: null,
    postOwnedKey:
      'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg',
    url: 'https://media.example.com/photo.jpg',
    mediaType: 'image' as const,
    aspectRatio: null,
    width: null,
    height: null,
    name: 'photo.jpg',
  };
}

async function callRoute(
  route: (
    request: NextRequest,
    context: { params: Promise<{ subdomain: string }> }
  ) => Promise<Response>,
  path: string,
  body: unknown
) {
  const request = new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const response = await route(request, {
    params: Promise.resolve({ subdomain: 'acme' }),
  });
  return { status: response.status, body: await response.json() };
}

describe('post-owned media guards', () => {
  it('Instagram Publish Now rejects post-owned media with 400', async () => {
    const { status, body } = await callRoute(
      instagramPost,
      '/api/tenant/acme/instagram/publish-now',
      {
        caption: 'Hello',
        postType: 'photo',
        targets: [{ accountId: ACCOUNT_ID, accountName: 'IG One' }],
        media: postOwnedMedia(),
      }
    );
    expect(status).toBe(400);
    expect(body.message).toBe(
      'Post-owned media is not supported for Instagram Publish Now.'
    );
  });

  it('Threads Publish Now rejects post-owned media with 400', async () => {
    const { status, body } = await callRoute(
      threadsPost,
      '/api/tenant/acme/threads/publish-now',
      {
        caption: 'Hello',
        postType: 'image',
        targets: [
          {
            accountId: ACCOUNT_ID,
            threadsUserId: 'th-1',
            accountName: 'Threads One',
          },
        ],
        media: postOwnedMedia(),
      }
    );
    expect(status).toBe(400);
    expect(body.message).toBe(
      'Post-owned media is not supported for Threads Publish Now.'
    );
  });
});
