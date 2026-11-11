/**
 * Creator Finder enrich endpoint (spec 169): return-first enrichment.
 *
 * The page POSTs the creators a search just returned; the route enriches
 * them (bounded), saves the enriched versions, and returns them. The
 * session/supabase plumbing and the save are mocked; Countik is stubbed
 * at the global fetch so the real enrichCreators deadline logic runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionPayload } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { POST as enrich } from '../../src/app/api/tenant/[subdomain]/creator-finder/enrich/route';

const USER_A = '11111111-1111-4111-a111-111111111111';
const SUBDOMAIN = 'testsub';

let mockSession:
  | { session: SessionPayload; errorResponse?: never }
  | { session?: never; errorResponse: NextResponse } = {
  session: {
    userId: USER_A,
    email: 'user@gmail.com',
    subdomain: SUBDOMAIN,
    role: 'user',
    status: 'active',
    iat: 1,
    exp: 9999999999,
  } satisfies SessionPayload,
};
// Read through closures only: the vi.mock factory below runs before this
// module body, so a direct reference here would hit the TDZ (the same
// reason the cap test reads mockRole/mockSupabase inside closures).
const saveCalls: unknown[][] = [];
let saveResult = true;

vi.mock(
  '../../src/app/api/tenant/[subdomain]/creator-finder/lib',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../src/app/api/tenant/[subdomain]/creator-finder/lib')
      >();
    return {
      ...actual,
      getCreatorFinderSession: async () => mockSession,
      getCreatorFinderSupabase: () => ({}) as SupabaseClient,
      getCreatorFinderWorkspaceId: async () => 'workspace-id',
      saveCreatorsToDb: (async (...args: unknown[]) => {
        saveCalls.push(args);
        return saveResult;
      }) as typeof actual.saveCreatorsToDb,
    };
  },
);

const EXIST_BODY = { sec_uid: 'SEC123', verified: true };
const ANALYZE_BODY = {
  author: {
    nickname: 'Alice Fit',
    signature: 'Making short videos about everyday life.',
    follower_count: 1_200_000,
    following_count: 850,
    total_heart: 42_000_000,
    video_count: 480,
    verified: true,
  },
  engagement_rates: { total: 8.4, likes: 6.1, comments: 1.4, shares: 0.9 },
  performance: {
    average_views: 2_100_000,
    average_likes: 180_000,
    average_comments: 9500,
    average_shares: 12_000,
  },
  hashtags: ['fitness'],
  mentions: [],
};

function stubCountik(handler: (url: string) => { ok: boolean; body: unknown }) {
  const fn = vi.fn(async (url: string) => {
    const result = handler(url);
    return {
      ok: result.ok,
      json: async () => result.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
}

function creator(handle: string) {
  return {
    handle,
    displayName: handle,
    avatarUrl: null,
    latestVideoTitle: null,
    latestVideoCover: null,
    profileUrl: `https://www.tiktok.com/@${handle}`,
  };
}

function enrichRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/tenant/${SUBDOMAIN}/creator-finder/enrich`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

function params() {
  return { params: Promise.resolve({ subdomain: SUBDOMAIN }) };
}

describe('Creator Finder enrich endpoint (spec 169)', () => {
  beforeEach(() => {
    mockSession = {
      session: {
        userId: USER_A,
        email: 'user@gmail.com',
        subdomain: SUBDOMAIN,
        role: 'user',
        status: 'active',
        iat: 1,
        exp: 9999999999,
      } satisfies SessionPayload,
    };
    saveCalls.length = 0;
    saveResult = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enriches the posted creators and saves them, reporting timing', async () => {
    stubCountik((url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: ANALYZE_BODY };
    });
    const res = await enrich(
      enrichRequest({
        source: 'trending',
        searchTerm: 'PK',
        creators: [creator('alice')],
      }),
      params(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      creators: Array<{ enrichment?: { verified?: boolean } }>;
      saveFailed?: boolean;
    };
    expect(body.creators[0]?.enrichment?.verified).toBe(true);
    expect(body.saveFailed).toBe(false);
    expect(saveCalls).toHaveLength(1);
    const saved = saveCalls[0]?.[3] as Array<{
      handle: string;
      enrichment?: unknown;
    }>;
    expect(saved[0]?.handle).toBe('alice');
    expect(saved[0]?.enrichment).toBeDefined();
    expect(saveCalls[0]?.[4]).toBe('trending');
    expect(saveCalls[0]?.[5]).toBe('PK');
    const timing = res.headers.get('Server-Timing') ?? '';
    expect(timing).toContain('session');
    expect(timing).toContain('enrich');
    expect(timing).toContain('save');
  });

  it('dedupes handles and isolates a per-creator failure', async () => {
    stubCountik((url) => {
      if (url.includes('/exist/bob')) return { ok: false, body: {} };
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: ANALYZE_BODY };
    });
    const res = await enrich(
      enrichRequest({
        source: 'similar',
        searchTerm: 'alice',
        creators: [creator('alice'), creator('alice'), creator('bob')],
      }),
      params(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      creators: Array<{
        handle: string;
        enrichment?: unknown;
        countikUnavailable?: boolean;
      }>;
    };
    expect(body.creators.map((c) => c.handle)).toEqual(['alice', 'bob']);
    expect(body.creators[0]?.enrichment).toBeDefined();
    expect(body.creators[1]?.countikUnavailable).toBe(true);
    expect(saveCalls).toHaveLength(1);
  });

  it('reports saveFailed instead of failing when the save fails', async () => {
    stubCountik((url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: ANALYZE_BODY };
    });
    saveResult = false;
    const res = await enrich(
      enrichRequest({
        source: 'niche',
        searchTerm: 'fitness',
        creators: [creator('alice')],
      }),
      params(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saveFailed?: boolean };
    expect(body.saveFailed).toBe(true);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await enrich(
      enrichRequest({ source: 'trending', searchTerm: 'PK', creators: [] }),
      params(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('INVALID_REQUEST');
    expect(saveCalls).toHaveLength(0);
  });

  it('returns 401 without a session', async () => {
    mockSession = {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      ),
    };
    const res = await enrich(
      enrichRequest({
        source: 'trending',
        searchTerm: 'PK',
        creators: [creator('alice')],
      }),
      params(),
    );
    expect(res.status).toBe(401);
    expect(saveCalls).toHaveLength(0);
  });
});
