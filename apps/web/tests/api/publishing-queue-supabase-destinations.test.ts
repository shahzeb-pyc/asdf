import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListQueueItems } from '../../src/app/api/tenant/[subdomain]/publishing/queue/route';

const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const USER_ID = '11111111-1111-4111-a111-111111111111';
const PAGE_ID = '22222222-2222-4222-a222-222222222222';

function destId(i: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;
}

function queueRow(destinationId: string) {
  return {
    id: '33333333-3333-4333-a333-333333333333',
    destination_id: destinationId,
    slot_id: null,
    media_item_id: null,
    kind: 'video',
    platform_format: 'reel',
    link_url: null,
    scheduled_time: null,
    caption: 'Beyond cap post',
    first_comment: null,
    status: 'queued',
    retry_count: 0,
    max_retries: 3,
    external_post_id: null,
    external_comment_id: null,
    created_at: '2026-10-07T12:00:00.000Z',
    updated_at: '2026-10-07T12:00:00.000Z',
    media: null,
    // The queue row's own media_url column (post-owned rows);
    // null here, overridden by the post-owned test below.
    media_url: null as string | null,
  };
}

describe('Publishing queue Supabase destinations fetch (R7)', () => {
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET,
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  function makeSupabase(opts: {
    destinations: Array<{ id: string; status: string; metadata: Record<string, unknown> | null }>;
    destinationsError: boolean;
    queueRows: Array<ReturnType<typeof queueRow>>;
  }) {
    const rangesLog: Array<[number, number]> = [];
    const builder = (table: string) => {
      const state: {
        selectColumns: string | undefined;
        head: boolean;
        eqFilters: Array<[string, unknown]>;
        inFilters: Array<[string, unknown[]]>;
        range: [number, number] | null;
      } = { selectColumns: undefined, head: false, eqFilters: [], inFilters: [], range: null };
      const chain: Record<string, unknown> = {
        select: (columns: string, selOpts?: { head?: boolean; count?: string }) => {
          state.selectColumns = columns;
          state.head = selOpts?.head === true;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          state.eqFilters.push([column, value]);
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          state.inFilters.push([column, values]);
          return chain;
        },
        order: () => chain,
        range: (from: number, to: number) => {
          state.range = [from, to];
          if (table === 'destinations') rangesLog.push([from, to]);
          return chain;
        },
        maybeSingle: async () => {
          if (table === 'workspaces' && state.selectColumns === 'id') {
            return { data: { id: 'ws_123' }, error: null };
          }
          if (table === 'workspaces') {
            return { data: { owner_id: USER_ID }, error: null };
          }
          return { data: null, error: null };
        },
      };
      // Awaitable: the route awaits the queue/destinations chains.
      (chain as { then: unknown }).then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        let result: unknown;
        if (table === 'destinations') {
          if (opts.destinationsError) {
            result = { data: null, error: { message: 'destinations boom' } };
          } else {
            const [from, to] = state.range ?? [0, 999];
            result = {
              data: opts.destinations.slice(from, to + 1),
              error: null,
            };
          }
        } else if (table === 'queue_items') {
          let rows = [...opts.queueRows];
          for (const [column, value] of state.eqFilters) {
            if (column === 'destination_id') {
              rows = rows.filter((r) => r.destination_id === value);
            } else if (column === 'status') {
              rows = rows.filter((r) => r.status === value);
            }
          }
          for (const [column, values] of state.inFilters) {
            if (column === 'destination_id') {
              rows = rows.filter((r) => (values as unknown[]).includes(r.destination_id));
            }
          }
          if (state.head) {
            result = { data: [], count: rows.length, error: null };
          } else {
            const [from, to] = state.range ?? [0, 999];
            const sliced = rows.slice(from, to + 1);
            result = { data: sliced, count: rows.length, error: null };
          }
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(onFulfilled, onRejected);
      };
      return chain;
    };
    return {
      supabase: { from: vi.fn((table: string) => builder(table)) },
      rangesLog,
    };
  }

  it('returns 500, not an empty 200 list, when the destinations fetch fails', async () => {
    const { supabase } = makeSupabase({
      destinations: [],
      destinationsError: true,
      queueRows: [queueRow(PAGE_ID)],
    });
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/publishing/queue?pageId=${PAGE_ID}`,
      { headers: { cookie: validSessionCookie } },
    );
    const res = await handleListQueueItems(req, 'acme', supabase as never);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Failed to list queue items');
    expect(json.items).toBeUndefined();
  });

  it('pages destinations past 1,000 so queue rows on later destinations still list', async () => {
    const destinations = Array.from({ length: 1001 }, (_, i) => ({
      id: destId(i),
      status: 'active',
      metadata: null,
    }));
    const beyondCap = destId(1000);
    const { supabase, rangesLog } = makeSupabase({
      destinations,
      destinationsError: false,
      queueRows: [queueRow(beyondCap)],
    });
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/publishing/queue?pageId=${beyondCap}`,
      { headers: { cookie: validSessionCookie } },
    );
    const res = await handleListQueueItems(req, 'acme', supabase as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].pageId).toBe(beyondCap);
    // The destinations fetch was ranged in 1,000-row chunks, not
    // capped at the first page.
    expect(rangesLog).toContainEqual([0, 999]);
    expect(rangesLog).toContainEqual([1000, 1999]);
  });

  it('counts publishing posts (R11) on the Supabase path', async () => {
    const { supabase } = makeSupabase({
      destinations: [{ id: PAGE_ID, status: 'active', metadata: null }],
      destinationsError: false,
      queueRows: [
        queueRow(PAGE_ID),
        { ...queueRow(PAGE_ID), id: '44444444-4444-4444-a444-444444444444', status: 'publishing' },
      ],
    });
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/publishing/queue?pageId=${PAGE_ID}`,
      { headers: { cookie: validSessionCookie } },
    );
    const res = await handleListQueueItems(req, 'acme', supabase as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queuedCount).toBe(1);
    expect(json.publishingCount).toBe(1);
  });

  it('returns the row media_url for a post-owned row with no library link (Supabase path)', async () => {
    const postOwnedUrl =
      'https://media.fbuploadpro.com/users/11111111-1111-4111-a111-111111111111/post-media/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/clip.mp4';
    const { supabase } = makeSupabase({
      destinations: [{ id: PAGE_ID, status: 'active', metadata: null }],
      destinationsError: false,
      queueRows: [
        {
          ...queueRow(PAGE_ID),
          kind: 'video',
          media: null,
          media_url: postOwnedUrl,
        },
      ],
    });
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/publishing/queue?pageId=${PAGE_ID}`,
      { headers: { cookie: validSessionCookie } },
    );
    const res = await handleListQueueItems(req, 'acme', supabase as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    // Same send-back-1 regression on the production (Supabase)
    // path: the select used to embed only the joined media row.
    expect(json.items[0].media).toBeDefined();
    expect(json.items[0].media.url).toBe(postOwnedUrl);
    expect(json.items[0].media.name).toBe('clip.mp4');
    expect(json.items[0].media.mediaType).toBe('video');
    expect(json.items[0].media.thumbnailUrl).toBeNull();
  });
});
