import { describe, expect, it, vi } from 'vitest';
import {
  bulkDeleteContent,
  listPageContent,
  resolveAccountToken,
  resolveDeleteCandidates,
  BulkDeleteError,
} from './facebook-bulk-delete';
import { encryptToken, getTokenEncryptionKey } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeFetch(handler: (url: string) => Response): FetchStub {
  return vi.fn(async (url: string) => handler(url)) as FetchStub;
}

function makeSupabaseStub(encryptedToken: string | null): SupabaseClient {
  const chain = {
    eq: () => chain,
    maybeSingle: async () => ({ data: { encrypted_access_token: encryptedToken }, error: null }),
  };
  return {
    from: () => ({ select: () => chain }),
  } as unknown as SupabaseClient;
}

describe('resolveAccountToken', () => {
  it('decrypts the workspace-scoped account token', async () => {
    const key = getTokenEncryptionKey();
    const encrypted = await encryptToken('EAABaccount-token', key);
    const token = await resolveAccountToken(
      makeSupabaseStub(encrypted),
      'workspace-1',
      '11111111-1111-4111-8111-111111111111',
    );
    expect(token).toBe('EAABaccount-token');
  });

  it('fails loudly when the account row has no token', async () => {
    await expect(
      resolveAccountToken(
        makeSupabaseStub(null),
        'workspace-1',
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toBeInstanceOf(BulkDeleteError);
  });
});

describe('listPageContent', () => {
  it('maps posts with the old title and permalink fallbacks', async () => {
    const fetchFn = makeFetch((url) => {
      expect(url).toContain('/123/posts');
      return jsonResponse({
        data: [
          { id: '123_1', message: 'Hello', created_time: '2026-01-02T00:00:00+0000', permalink_url: '/123_1', full_picture: 'https://example.com/pic.jpg' },
          { id: '123_2', created_time: '2026-01-03T00:00:00+0000' },
        ],
        paging: { cursors: { after: 'cursor-1' } },
      });
    });
    const result = await listPageContent(fetchFn, 'TOKEN', {
      pageId: '123',
      type: 'posts',
      limit: 25,
    });
    expect(result.items).toEqual([
      {
        id: '123_1',
        type: 'posts',
        title: 'Hello',
        createdTime: '2026-01-02T00:00:00+0000',
        permalinkUrl: 'https://www.facebook.com/123_1',
        previewImageUrl: 'https://example.com/pic.jpg',
      },
      {
        id: '123_2',
        type: 'posts',
        title: 'Untitled post',
        createdTime: '2026-01-03T00:00:00+0000',
        permalinkUrl: null,
        previewImageUrl: null,
      },
    ]);
    expect(result.paging.after).toBe('cursor-1');
  });

  it('falls back from video_reels to videos', async () => {
    const seen: string[] = [];
    const fetchFn = makeFetch((url) => {
      seen.push(url);
      if (url.includes('/video_reels')) {
        return jsonResponse({ error: { code: 100, message: 'No such edge' } }, 400);
      }
      return jsonResponse({
        data: [{ id: '123_9', title: 'A reel', created_time: '2026-01-04T00:00:00+0000' }],
        paging: {},
      });
    });
    const result = await listPageContent(fetchFn, 'TOKEN', {
      pageId: '123',
      type: 'reels',
      limit: 25,
    });
    expect(seen.some((u) => u.includes('/video_reels'))).toBe(true);
    expect(seen.some((u) => u.includes('/videos'))).toBe(true);
    expect(result.items[0]?.title).toBe('A reel');
  });

  it('throws loudly on a dead token instead of returning an empty list', async () => {
    const fetchFn = makeFetch(() =>
      jsonResponse({ error: { code: 190, error_subcode: 463, message: 'Token expired' } }, 400),
    );
    await expect(
      listPageContent(fetchFn, 'TOKEN', { pageId: '123', type: 'posts', limit: 25 }),
    ).rejects.toMatchObject({ code: 'TOKEN_DEAD' });
  });
});

describe('resolveDeleteCandidates', () => {
  it('fans out all types, sorts oldest first, and caps at 500', async () => {
    const fetchFn = makeFetch((url) => {
      const type = url.includes('/posts') ? 'posts' : url.includes('/photos') ? 'photos' : 'reels';
      return jsonResponse({
        data: [
          { id: `123_${type}-new`, message: 'new', created_time: '2026-06-01T00:00:00+0000' },
          { id: `123_${type}-old`, message: 'old', created_time: '2026-01-01T00:00:00+0000' },
        ],
        paging: {},
      });
    });
    const result = await resolveDeleteCandidates(fetchFn, 'TOKEN', {
      pageId: '123',
      type: 'all',
      sort: 'oldest_first',
    });
    expect(result.total).toBe(6);
    expect(result.candidates[0]?.createdTime).toBe('2026-01-01T00:00:00+0000');
    expect(result.candidates[5]?.createdTime).toBe('2026-06-01T00:00:00+0000');
  });

  it('applies the date range on both sides of the range', async () => {
    const fetchFn = makeFetch(() =>
      jsonResponse({
        data: [
          { id: '123_in', message: 'in', created_time: '2026-03-01T00:00:00+0000' },
          { id: '123_out', message: 'out', created_time: '2025-12-01T00:00:00+0000' },
        ],
        paging: {},
      }),
    );
    const result = await resolveDeleteCandidates(fetchFn, 'TOKEN', {
      pageId: '123',
      type: 'posts',
      sort: 'newest_first',
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
    });
    expect(result.candidates.map((c) => c.id)).toEqual(['123_in']);
  });
});

describe('bulkDeleteContent', () => {
  it('returns per-item results and masks (#200) as "Failed to delete"', async () => {
    const fetchFn = makeFetch((url) => {
      if (url.includes('123_ok')) return jsonResponse({ success: true });
      return jsonResponse(
        { error: { code: 200, message: '(#200) Requires pages_manage_posts' } },
        403,
      );
    });
    const result = await bulkDeleteContent(fetchFn, 'TOKEN', ['123_ok', '123_no']);
    expect(result).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { id: '123_ok', success: true },
        { id: '123_no', success: false, error: 'Failed to delete' },
      ],
    });
  });

  it('reports an already-deleted id as success so a retry cannot re-fail it', async () => {
    const fetchFn = makeFetch(() =>
      jsonResponse(
        { error: { code: 803, message: '(#803) Some of the aliases you requested do not exist' } },
        400,
      ),
    );
    const result = await bulkDeleteContent(fetchFn, 'TOKEN', ['123_gone']);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0]).toEqual({ id: '123_gone', success: true, alreadyDeleted: true });
  });

  it('fails the whole batch loudly on a dead token', async () => {
    const fetchFn = makeFetch(() =>
      jsonResponse({ error: { code: 190, error_subcode: 463, message: 'Token expired' } }, 400),
    );
    await expect(bulkDeleteContent(fetchFn, 'TOKEN', ['123_1'])).rejects.toMatchObject({
      code: 'TOKEN_DEAD',
    });
  });
});
