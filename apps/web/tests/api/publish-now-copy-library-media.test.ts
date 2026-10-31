import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/tenant/[subdomain]/publishing/publish-now/copy-library-media/route';

/**
 * Publish Now library-copy endpoint (media/posting separation),
 * tested with mocked session, Supabase reads, and object storage —
 * no real database or R2 call. Covers: a library pick is copied
 * server-side to a post-owned key (never served from the library
 * row at publish time), a copy failure fails loud with no
 * post-owned key, and a foreign library row is rejected.
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
  trackServerEvent: vi.fn(),
}));

let copiedPairs: Array<{ sourceKey: string; destinationKey: string }> = [];
let copyShouldFail = false;

vi.mock('@/lib/storage', () => ({
  getR2Config: () => ({
    accountId: 'acct',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'bucket',
    publicUrl: 'https://media.example.com',
  }),
  getStorageService: () => ({
    copyObject: async ({
      sourceKey,
      destinationKey,
    }: {
      sourceKey: string;
      destinationKey: string;
    }) => {
      if (copyShouldFail) throw new Error('R2 down');
      copiedPairs.push({ sourceKey, destinationKey });
    },
    getPublicUrl: (key: string) => `https://media.example.com/${key}`,
  }),
}));

let mediaRow: Record<string, unknown> | null;

vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'media_items') {
        throw new Error(`unexpected table ${table}`);
      }
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        maybeSingle: async () => {
          if (!mediaRow) return { data: null, error: null };
          if (
            filters['user_id'] !== undefined &&
            mediaRow['user_id'] !== filters['user_id']
          ) {
            return { data: null, error: null };
          }
          return { data: mediaRow, error: null };
        },
      };
      return chain;
    },
  }),
}));

beforeEach(() => {
  copiedPairs = [];
  copyShouldFail = false;
  mediaRow = {
    id: '22222222-2222-4222-a222-222222222222',
    user_id: 'user-1',
    name: 'photo.jpg',
    media_type: 'image',
    storage_key: 'users/user-1/library/photo.jpg',
    thumbnail_url: null,
  };
});

async function callCopy(body: unknown) {
  const request = new NextRequest(
    'http://localhost/api/tenant/acme/publishing/publish-now/copy-library-media',
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

describe('POST publish-now/copy-library-media', () => {
  it('copies a library file to a post-owned key and returns it', async () => {
    const { status, body } = await callCopy({
      mediaId: '22222222-2222-4222-a222-222222222222',
    });
    expect(status).toBe(200);
    expect(body.storageKey).toMatch(
      /^users\/user-1\/post-media\/[0-9a-f-]+\/photo\.jpg$/
    );
    expect(body.url).toBe(`https://media.example.com/${body.storageKey}`);
    expect(body.mediaType).toBe('image');
    expect(body.thumbnailUrl).toBeNull();
    // The copy ran server-side from the library bytes to the new key.
    expect(copiedPairs).toHaveLength(1);
    expect(copiedPairs[0].sourceKey).toBe('users/user-1/library/photo.jpg');
    expect(copiedPairs[0].destinationKey).toBe(body.storageKey);
  });

  it('fails loud when the copy fails, with no post-owned key', async () => {
    copyShouldFail = true;
    const { status, body } = await callCopy({
      mediaId: '22222222-2222-4222-a222-222222222222',
    });
    expect(status).toBe(500);
    expect(body.error).toBe('MEDIA_COPY_FAILED');
    expect(copiedPairs).toHaveLength(0);
  });

  it('rejects a library row that does not exist or belongs to someone else', async () => {
    mediaRow = null;
    const missing = await callCopy({
      mediaId: '22222222-2222-4222-a222-222222222222',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('not found');
    expect(copiedPairs).toHaveLength(0);

    mediaRow = {
      id: '22222222-2222-4222-a222-222222222222',
      user_id: 'user-2',
      name: 'photo.jpg',
      media_type: 'image',
      storage_key: 'users/user-2/library/photo.jpg',
      thumbnail_url: null,
    };
    const foreign = await callCopy({
      mediaId: '22222222-2222-4222-a222-222222222222',
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.message).toContain('not found');
    expect(copiedPairs).toHaveLength(0);
  });
});
