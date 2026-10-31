import { describe, expect, it, vi } from 'vitest';
import { fetchReferencedStagedKeys } from '@/lib/publishing/destination-enqueue';
import { postStagingKeyPrefix } from '@/lib/publishing/post-owned-media';

/**
 * fetchReferencedStagedKeys fallback branches (PR #74 Sonar gate):
 * the main keep-set suite covers the happy paging paths; these
 * cover the guards around them — no Supabase client available,
 * a Supabase error, and rows carrying a null/empty key, which the
 * keep set must skip rather than keep.
 */
vi.mock('@/lib/route-auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/route-auth')>();
  return {
    ...original,
    // Same as the real helper minus the admin-client fallback, so a
    // client without `from` deterministically yields null here.
    getRouteSupabase: (client: unknown) =>
      client !== null &&
      typeof client === 'object' &&
      'from' in (client as Record<string, unknown>)
        ? client
        : null,
  };
});

const userId = '11111111-1111-4111-a111-111111111111';
const workspaceId = '22222222-2222-4222-a222-222222222222';

function stagedKey(name: string): string {
  return `${postStagingKeyPrefix(userId)}aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/${name}`;
}

/** Minimal Supabase-shaped fake resolving one scripted page result. */
function makeSupabase(result: {
  data: Array<{ id: string; media_storage_key?: string | null }> | null;
  error: { message: string } | null;
}) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'like', 'in', 'gt', 'order', 'limit']) {
    chain[method] = () => chain;
  }
  (chain as { then: unknown }).then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  return { from: () => chain };
}

describe('fetchReferencedStagedKeys fallbacks', () => {
  it('returns an empty keep set when no Supabase client is available', async () => {
    const keys = await fetchReferencedStagedKeys({} as never, workspaceId, userId);
    expect(keys).toEqual(new Set());
  });

  it('returns an empty keep set when the Supabase page errors', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'boom' } });
    const keys = await fetchReferencedStagedKeys(
      supabase as never,
      workspaceId,
      userId
    );
    expect(keys).toEqual(new Set());
  });

  it('skips null and empty keys on the Supabase path', async () => {
    const supabase = makeSupabase({
      data: [
        { id: 'a', media_storage_key: null },
        { id: 'b', media_storage_key: '' },
        { id: 'c', media_storage_key: stagedKey('kept.jpg') },
      ],
      error: null,
    });
    const keys = await fetchReferencedStagedKeys(
      supabase as never,
      workspaceId,
      userId
    );
    expect(keys).toEqual(new Set([stagedKey('kept.jpg')]));
  });

  it('skips null and empty keys on the legacy path', async () => {
    const legacy = {
      query: vi.fn(async () => [
        { id: 'a', media_storage_key: null },
        { id: 'b', media_storage_key: '' },
        { id: 'c', media_storage_key: stagedKey('kept.jpg') },
      ]),
    };
    const keys = await fetchReferencedStagedKeys(
      legacy as never,
      workspaceId,
      userId
    );
    expect(keys).toEqual(new Set([stagedKey('kept.jpg')]));
  });
});
