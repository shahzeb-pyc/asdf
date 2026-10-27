import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleGetPageInsights } from '../../src/app/api/tenant/[subdomain]/pages/[pageId]/insights/route';

const TEST_SECRET = 'test-session-secret-0123456789abcdef';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const USER_ID = '11111111-1111-4111-a111-111111111111';
const PAGE_ID = '33333333-3333-4333-a333-333333333333';
const PLAINTEXT_TOKEN = 'mock_page_token_never_leak_this';

function chainable(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  return chain;
}

function fakeDb(destinationRow: unknown) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'workspaces') return chainable({ data: { id: 'ws-1' }, error: null });
      if (table === 'destinations') return chainable({ data: destinationRow, error: null });
      return chainable({ data: null, error: null });
    }),
  };
}

function graphPayload() {
  const daily = (name: string, value: number) => ({
    name,
    period: 'day',
    values: [{ value, end_time: '2026-10-27T07:00:00+0000' }],
  });
  return {
    daily: {
      data: [
        daily('page_media_view', 100),
        daily('page_total_media_view_unique', 80),
        daily('page_post_engagements', 20),
        daily('page_actions_post_reactions_like_total', 10),
        daily('page_actions_post_reactions_love_total', 5),
        daily('page_actions_post_reactions_wow_total', 0),
        daily('page_actions_post_reactions_haha_total', 2),
        daily('page_actions_post_reactions_sorry_total', 0),
        daily('page_actions_post_reactions_anger_total', 1),
        daily('page_daily_follows', 12),
        daily('page_daily_unfollows', 3),
        daily('page_video_view_time', 3_600_000),
      ],
    },
    audience: {
      data: [
        { name: 'page_follows_country', period: 'lifetime', values: [{ value: { US: 500, PK: 300 } }] },
        { name: 'page_follows_city', period: 'lifetime', values: [{ value: { Karachi: 120 } }] },
      ],
    },
    page: { followers_count: 1234 },
  };
}

describe('rebuilt insights route (live proxy, no DB writes)', () => {
  let sessionCookie: string;
  let encryptedToken: string;

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
    sessionCookie = `fbup_session=${token}`;
    encryptedToken = await encryptToken(PLAINTEXT_TOKEN, TEST_ENCRYPTION_KEY);
  });

  function request(range = '28d') {
    return new NextRequest(
      `http://localhost/api/tenant/acme/pages/${PAGE_ID}/insights?range=${range}`,
      { headers: { cookie: sessionCookie } },
    );
  }

  it('returns a fresh live payload, never leaks the token, and writes nothing', async () => {
    const payloads = graphPayload();
    const seenUrls: string[] = [];
    const graphFetch = vi.fn(async (url: string) => {
      seenUrls.push(url);
      const body = url.includes('/insights?metric=page_media_view')
        ? payloads.daily
        : url.includes('/insights?metric=page_follows_country')
          ? payloads.audience
          : payloads.page;
      return { ok: true, status: 200, json: async () => body };
    });
    const db = fakeDb({
      id: PAGE_ID,
      external_destination_id: 'fb-999',
      encrypted_destination_token: encryptedToken,
    });
    const res = await handleGetPageInsights(request(), 'acme', PAGE_ID, db as never, graphFetch);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-cache');
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.kpis.followers).toBe(1234);
    expect(body.kpis.mediaViews).toBe(100);
    expect(body.range).toBe('28d');
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_TOKEN);
    expect(seenUrls).toHaveLength(3);
    // The fake db only ever served SELECT-shaped chains; assert no writes happened.
    const fromMock = (db.from as unknown as ReturnType<typeof vi.fn>);
    expect(fromMock).not.toHaveBeenCalledWith(expect.stringMatching(/insert|update|delete/i));
  });

  it('fails loud with 502 when Facebook fails, and 404 for an unknown page', async () => {
    const failingFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Graph said no' } }),
    }));
    const db = fakeDb({
      id: PAGE_ID,
      external_destination_id: 'fb-999',
      encrypted_destination_token: encryptedToken,
    });
    const failed = await handleGetPageInsights(request(), 'acme', PAGE_ID, db as never, failingFetch);
    expect(failed.status).toBe(502);
    const missing = await handleGetPageInsights(
      request(),
      'acme',
      PAGE_ID,
      fakeDb(null) as never,
      failingFetch,
    );
    expect(missing.status).toBe(404);
  });

  it('rejects an unknown range with 400 and rejects missing sessions with 401', async () => {
    const db = fakeDb({
      id: PAGE_ID,
      external_destination_id: 'fb-999',
      encrypted_destination_token: encryptedToken,
    });
    const badRange = await handleGetPageInsights(request('30d'), 'acme', PAGE_ID, db as never, vi.fn());
    expect(badRange.status).toBe(400);
    const anon = new NextRequest(`http://localhost/api/tenant/acme/pages/${PAGE_ID}/insights`);
    const unauth = await handleGetPageInsights(anon, 'acme', PAGE_ID, db as never, vi.fn());
    expect(unauth.status).toBe(401);
  });
});
