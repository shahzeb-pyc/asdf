/**
 * Creator Finder daily cap at the route level (trending as the
 * representative discovery route, plus the usage route and the
 * Saved route's exemption).
 *
 * The gate helper runs for real against a fake Supabase client;
 * only the session/supabase plumbing and the upstream fetcher
 * are mocked. The fetcher fake invokes the passed
 * onUpstreamCall N times, simulating a multi-call discovery
 * method, so the mid-flight rule is exercised end to end: a
 * request that starts under the cap completes even when its
 * calls push the count past 100, and only the next request
 * blocks — with zero upstream calls on the blocked request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionPayload } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GET as getTrending } from '../../src/app/api/tenant/[subdomain]/creator-finder/trending/route';
import { GET as getUsage } from '../../src/app/api/tenant/[subdomain]/creator-finder/usage/route';
import { GET as getSaved } from '../../src/app/api/tenant/[subdomain]/creator-finder/saved/route';

const USER_A = '11111111-1111-4111-a111-111111111111';
const SUBDOMAIN = 'testsub';

/** Today's PKT date, computed independently (PKT is fixed UTC+5). */
function pktToday(): string {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Minimal Supabase fake: keyed counters + injectable failures. */
class FakeSupabase {
  public counts = new Map<string, number>();
  public readError: unknown = null;
  public rpcError: unknown = null;
  public readCalls = 0;
  public rpcCalls = 0;

  public from(): FakeQuery {
    return new FakeQuery(this);
  }

  public async rpc(
    _name: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }> {
    this.rpcCalls += 1;
    if (this.rpcError) return { data: null, error: this.rpcError };
    const key = `${params.p_user_id as string}|${params.p_usage_date as string}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return { data: next, error: null };
  }
}

class FakeQuery {
  private filters: Record<string, string> = {};

  public constructor(private readonly fake: FakeSupabase) {}

  public select(): this {
    return this;
  }

  public eq(column: string, value: string): this {
    this.filters[column] = value;
    return this;
  }

  public async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    this.fake.readCalls += 1;
    if (this.fake.readError) {
      return { data: null, error: this.fake.readError };
    }
    const key = `${this.filters.user_id}|${this.filters.usage_date}`;
    const count = this.fake.counts.get(key);
    return {
      data: count === undefined ? null : { call_count: count },
      error: null,
    };
  }
}

function asClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

let mockRole: 'user' | 'admin' = 'user';
let mockSupabase: SupabaseClient | null = null;
let upstreamCallsPerFetch = 1;
let fetchTrendingCalls = 0;

vi.mock(
  '../../src/app/api/tenant/[subdomain]/creator-finder/lib',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../src/app/api/tenant/[subdomain]/creator-finder/lib')
      >();
    return {
      ...actual,
      getCreatorFinderSession: async () => ({
        session: {
          userId: USER_A,
          email: 'user@gmail.com',
          subdomain: SUBDOMAIN,
          role: mockRole,
          status: 'active',
          iat: 1,
          exp: 9999999999,
        } satisfies SessionPayload,
      }),
      getCreatorFinderSupabase: () => mockSupabase,
      getCreatorFinderWorkspaceId: async () => 'workspace-id',
      getCreatorFinderKeys: () => ['key-1'],
      saveCreatorsToDb: async () => true,
      listSavedCreators: async () => [],
    };
  },
);

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@fbuploadpro/contracts')>();
  return {
    ...actual,
    fetchTrendingCreators: async (
      _region: string,
      options: { onUpstreamCall?: () => Promise<void> },
    ) => {
      fetchTrendingCalls += 1;
      for (let i = 0; i < upstreamCallsPerFetch; i += 1) {
        await options.onUpstreamCall?.();
      }
      return { region: 'PK', creators: [], videosSeen: 0 };
    },
  };
});

function trendingRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/tenant/${SUBDOMAIN}/creator-finder/trending?region=PK`,
  );
}

function params() {
  return { params: Promise.resolve({ subdomain: SUBDOMAIN }) };
}

describe('Creator Finder daily cap (routes)', () => {
  let fake: FakeSupabase;

  beforeEach(() => {
    fake = new FakeSupabase();
    mockSupabase = asClient(fake);
    mockRole = 'user';
    upstreamCallsPerFetch = 1;
    fetchTrendingCalls = 0;
  });

  it('blocks at exactly 100 with 429, no upstream call, no count', async () => {
    fake.counts.set(`${USER_A}|${pktToday()}`, 100);
    const res = await getTrending(trendingRequest(), params());
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('DAILY_LIMIT_EXCEEDED');
    expect(body.message).toBe('Daily limit exceeded');
    expect(body.dailyLimitExceeded).toBe(true);
    expect(fetchTrendingCalls).toBe(0);
    expect(fake.rpcCalls).toBe(0);
  });

  it('lets a request starting at 99 finish past 100, then blocks the next', async () => {
    fake.counts.set(`${USER_A}|${pktToday()}`, 99);
    upstreamCallsPerFetch = 2;
    const first = await getTrending(trendingRequest(), params());
    expect(first.status).toBe(200);
    expect(fetchTrendingCalls).toBe(1);
    expect(fake.counts.get(`${USER_A}|${pktToday()}`)).toBe(101);
    const second = await getTrending(trendingRequest(), params());
    expect(second.status).toBe(429);
    expect(fetchTrendingCalls).toBe(1);
  });

  it('admins bypass with no client and no counting', async () => {
    mockRole = 'admin';
    mockSupabase = null;
    const res = await getTrending(trendingRequest(), params());
    expect(res.status).toBe(200);
    expect(fetchTrendingCalls).toBe(1);
    expect(fake.rpcCalls).toBe(0);
  });

  it('fails loud with 503 when the counter cannot be read', async () => {
    fake.readError = { code: 'PGRST000', message: 'boom' };
    const res = await getTrending(trendingRequest(), params());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('USAGE_UNAVAILABLE');
    expect(fetchTrendingCalls).toBe(0);
  });

  it('usage route reports today’s count and is itself ungated', async () => {
    fake.counts.set(`${USER_A}|${pktToday()}`, 100);
    const res = await getUsage(
      new NextRequest(
        `http://localhost/api/tenant/${SUBDOMAIN}/creator-finder/usage`,
      ),
      params(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.used).toBe(100);
    expect(body.limit).toBe(100);
    expect(body.date).toBe(pktToday());
    // The usage read is not a discovery call: no increments.
    expect(fake.rpcCalls).toBe(0);
  });

  it('usage route reports 0 for admins without touching the counter', async () => {
    mockRole = 'admin';
    mockSupabase = null;
    const res = await getUsage(
      new NextRequest(
        `http://localhost/api/tenant/${SUBDOMAIN}/creator-finder/usage`,
      ),
      params(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.used).toBe(0);
    expect(fake.readCalls).toBe(0);
  });

  it('Saved stays ungated and uncounted at the cap', async () => {
    fake.counts.set(`${USER_A}|${pktToday()}`, 100);
    const res = await getSaved(
      new NextRequest(
        `http://localhost/api/tenant/${SUBDOMAIN}/creator-finder/saved`,
      ),
      params(),
    );
    expect(res.status).toBe(200);
    expect(fake.readCalls).toBe(0);
    expect(fake.rpcCalls).toBe(0);
  });
});
