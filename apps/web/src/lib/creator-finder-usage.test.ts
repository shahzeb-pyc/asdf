/**
 * Creator Finder daily-cap counter helper.
 *
 * Behavioural coverage for the locked gate rules: the day is a
 * PKT calendar day (not UTC); the gate blocks exactly at 100
 * (99 proceeds, 100 blocks); counts are per user and per day;
 * an in-flight request's increments cross the cap without
 * throwing; admins bypass with no database touch; any counter
 * failure throws instead of proceeding ungated.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CREATOR_FINDER_USAGE_TABLE,
  CreatorFinderUsageError,
  getCreatorFinderUsageCount,
  getCreatorFinderUsageDate,
  incrementCreatorFinderUsage,
  startCreatorFinderDiscovery,
} from './creator-finder-usage';

/** Minimal Supabase fake: keyed counters + injectable failures. */
class FakeSupabase {
  public counts = new Map<string, number>();
  public readError: unknown = null;
  public rpcError: unknown = null;
  public rpcCalls: Array<{ name: string; params: Record<string, unknown> }> =
    [];
  public readCalls = 0;

  public from(table: string): FakeQuery {
    if (table !== CREATOR_FINDER_USAGE_TABLE) {
      throw new Error(`unexpected table ${table}`);
    }
    return new FakeQuery(this);
  }

  public async rpc(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }> {
    this.rpcCalls.push({ name, params });
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

const USER_A = '11111111-1111-4111-a111-111111111111';
const USER_B = '22222222-2222-4222-a222-222222222222';
const DAY = '2026-11-01';
const NEXT_DAY = '2026-11-02';

describe('getCreatorFinderUsageDate (PKT day boundary)', () => {
  it('uses the Asia/Karachi date, not UTC', () => {
    // 19:00 UTC = 00:00 next day in PKT (UTC+5).
    expect(
      getCreatorFinderUsageDate(new Date('2026-11-01T19:00:00.000Z')),
    ).toBe(NEXT_DAY);
    // 18:59 UTC = 23:59 the same day in PKT.
    expect(
      getCreatorFinderUsageDate(new Date('2026-11-01T18:59:00.000Z')),
    ).toBe(DAY);
    // 00:00 UTC = 05:00 the same day in PKT.
    expect(
      getCreatorFinderUsageDate(new Date('2026-11-01T00:00:00.000Z')),
    ).toBe(DAY);
  });
});

describe('startCreatorFinderDiscovery (gate)', () => {
  it('allows at 99 and blocks at exactly 100', async () => {
    const fake = new FakeSupabase();
    fake.counts.set(`${USER_A}|${DAY}`, 99);
    const at99 = await startCreatorFinderDiscovery({
      supabase: asClient(fake),
      userId: USER_A,
      role: 'user',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    expect(at99.blocked).toBe(false);

    fake.counts.set(`${USER_A}|${DAY}`, 100);
    const at100 = await startCreatorFinderDiscovery({
      supabase: asClient(fake),
      userId: USER_A,
      role: 'user',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    expect(at100.blocked).toBe(true);
    expect(at100.used).toBe(100);
  });

  it('counts per user: one capped user does not block another', async () => {
    const fake = new FakeSupabase();
    fake.counts.set(`${USER_A}|${DAY}`, 100);
    const gate = await startCreatorFinderDiscovery({
      supabase: asClient(fake),
      userId: USER_B,
      role: 'user',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    expect(gate.blocked).toBe(false);
    expect(gate.used).toBe(0);
  });

  it('counts per day: a new PKT day starts at 0', async () => {
    const fake = new FakeSupabase();
    fake.counts.set(`${USER_A}|${DAY}`, 100);
    const gate = await startCreatorFinderDiscovery({
      supabase: asClient(fake),
      userId: USER_A,
      role: 'user',
      now: new Date('2026-11-02T12:00:00.000Z'),
    });
    expect(gate.blocked).toBe(false);
    expect(gate.used).toBe(0);
    expect(gate.date).toBe(NEXT_DAY);
  });

  it('lets an in-flight request cross the cap, then the next request blocks', async () => {
    const fake = new FakeSupabase();
    fake.counts.set(`${USER_A}|${DAY}`, 99);
    const gate = await startCreatorFinderDiscovery({
      supabase: asClient(fake),
      userId: USER_A,
      role: 'user',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    expect(gate.blocked).toBe(false);
    if (gate.blocked) throw new Error('unreachable');
    // Two upstream attempts in one started request: 99 -> 101.
    await gate.onUpstreamCall();
    await gate.onUpstreamCall();
    expect(fake.counts.get(`${USER_A}|${DAY}`)).toBe(101);
    const next = await startCreatorFinderDiscovery({
      supabase: asClient(fake),
      userId: USER_A,
      role: 'user',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    expect(next.blocked).toBe(true);
  });

  it('admins bypass with no database touch, even with no client', async () => {
    const fake = new FakeSupabase();
    const gate = await startCreatorFinderDiscovery({
      supabase: null,
      userId: USER_A,
      role: 'admin',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    expect(gate.blocked).toBe(false);
    if (gate.blocked) throw new Error('unreachable');
    await gate.onUpstreamCall();
    expect(fake.readCalls).toBe(0);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('fails loud when the client is missing or the counter cannot be read', async () => {
    await expect(
      startCreatorFinderDiscovery({
        supabase: null,
        userId: USER_A,
        role: 'user',
        now: new Date('2026-11-01T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(CreatorFinderUsageError);

    const fake = new FakeSupabase();
    fake.readError = { code: 'PGRST000', message: 'boom' };
    await expect(
      startCreatorFinderDiscovery({
        supabase: asClient(fake),
        userId: USER_A,
        role: 'user',
        now: new Date('2026-11-01T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(CreatorFinderUsageError);
  });

  it('fails loud when an increment fails mid-flight', async () => {
    const fake = new FakeSupabase();
    fake.rpcError = { code: 'PGRST000', message: 'boom' };
    const gate = await startCreatorFinderDiscovery({
      supabase: asClient(fake),
      userId: USER_A,
      role: 'user',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    expect(gate.blocked).toBe(false);
    if (gate.blocked) throw new Error('unreachable');
    await expect(gate.onUpstreamCall()).rejects.toBeInstanceOf(
      CreatorFinderUsageError,
    );
  });
});

describe('getCreatorFinderUsageCount / incrementCreatorFinderUsage', () => {
  it('returns 0 with no row and increments through the RPC', async () => {
    const fake = new FakeSupabase();
    const client = asClient(fake);
    expect(await getCreatorFinderUsageCount(client, USER_A, DAY)).toBe(0);
    expect(await incrementCreatorFinderUsage(client, USER_A, DAY)).toBe(1);
    expect(await incrementCreatorFinderUsage(client, USER_A, DAY)).toBe(2);
    expect(await getCreatorFinderUsageCount(client, USER_A, DAY)).toBe(2);
    expect(fake.rpcCalls).toHaveLength(2);
    expect(fake.rpcCalls[0]?.name).toBe('increment_creator_finder_usage');
  });

  it('does not log user data on failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fake = new FakeSupabase();
      fake.readError = { code: 'PGRST000', message: 'boom' };
      await expect(
        getCreatorFinderUsageCount(asClient(fake), USER_A, DAY),
      ).rejects.toBeInstanceOf(CreatorFinderUsageError);
      const logged = spy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(logged).not.toContain(USER_A);
    } finally {
      spy.mockRestore();
    }
  });
});
