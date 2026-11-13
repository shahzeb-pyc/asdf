import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  authorizeInternalRequest,
  probeInternalHealth,
  GET,
} from '../../src/app/api/internal/health/route.js';

/**
 * Chainable Supabase-builder mock. Awaiting the builder resolves a head-count
 * style result; .maybeSingle() resolves row-style results.
 */
type CapturedQuery = {
  table: string;
  select: string | null;
  filters: Record<string, unknown>;
  neq: Record<string, unknown>;
  not: Array<{ column: string; operator: string; value: unknown }>;
  lte: Record<string, unknown>;
  or: string | null;
};

function createMockDb(options: {
  heartbeat: Record<string, unknown> | null;
  dueCount?: number;
  stuckCount?: number;
  oldestScheduledTime?: string | null;
  pageCounts?: Record<string, number>;
  accountCounts?: Record<string, number>;
  sectionCheck?: {
    unsectioned?: number;
    slots?: number;
    queueItems?: number;
    aduConfigs?: number;
    slotClaims?: number;
  };
}) {
  const queries: CapturedQuery[] = [];
  const makeBuilder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const neq: Record<string, unknown> = {};
    const not: Array<{ column: string; operator: string; value: unknown }> = [];
    const lte: Record<string, unknown> = {};
    const captured: CapturedQuery = {
      table,
      select: null,
      filters,
      neq,
      not,
      lte,
      or: null,
    };
    queries.push(captured);
    const builder: Record<string, unknown> = {};
    const resolveCount = () => {
      // Spec 174 3B: the section-check queries. The destinations
      // query has NO status filter (unlike the per-section buckets,
      // which always carry one); child queries carry the
      // `destinations!inner` embed.
      if (
        table === 'destinations' &&
        filters.section === null &&
        filters.status === undefined
      ) {
        return { count: options.sectionCheck?.unsectioned ?? 0, error: null };
      }
      if (captured.select?.includes('destinations!inner')) {
        const perTable: Record<string, number | undefined> = {
          posting_slots: options.sectionCheck?.slots,
          queue_items: options.sectionCheck?.queueItems,
          adu_configs: options.sectionCheck?.aduConfigs,
          posting_slot_claims: options.sectionCheck?.slotClaims,
        };
        return { count: perTable[table] ?? 0, error: null };
      }
      if (table === 'queue_items') {
        return {
          count: filters.status === 'publishing' ? (options.stuckCount ?? 0) : (options.dueCount ?? 0),
          error: null,
        };
      }
      if (table === 'destinations') {
        return { count: options.pageCounts?.[String(filters.status)] ?? 0, error: null };
      }
      if (table === 'social_accounts') {
        return { count: options.accountCounts?.[String(filters.status)] ?? 0, error: null };
      }
      return { count: 0, error: null };
    };
    builder.select = (columns: string) => {
      captured.select = columns;
      return builder;
    };
    builder.eq = (_col: string, val: unknown) => {
      filters[_col] = val;
      return builder;
    };
    builder.neq = (_col: string, val: unknown) => {
      neq[_col] = val;
      return builder;
    };
    builder.not = (_col: string, op: string, val: unknown) => {
      not.push({ column: _col, operator: op, value: val });
      return builder;
    };
    builder.is = (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    };
    builder.lte = (col: string, val: unknown) => {
      lte[col] = val;
      return builder;
    };
    builder.or = (val: string) => {
      captured.or = val;
      return builder;
    };
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = async () => {
      if (table === 'worker_heartbeats') {
        return { data: options.heartbeat, error: null };
      }
      if (table === 'queue_items') {
        return {
          data: options.oldestScheduledTime
            ? { scheduled_time: options.oldestScheduledTime }
            : null,
          error: null,
        };
      }
      return { data: null, error: null };
    };
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(resolveCount()).then(resolve, reject);
    return builder;
  };
  const db = {
    from: vi.fn((table: string) => makeBuilder(table)),
    __queries: queries,
  } as unknown as SupabaseClient & { __queries: CapturedQuery[] };
  return db;
}

function queriesFor(
  db: SupabaseClient & { __queries: CapturedQuery[] },
  table: string
): CapturedQuery[] {
  return db.__queries.filter((q) => q.table === table);
}

const NOW = new Date('2026-10-22T12:00:00.000Z');
const freshHeartbeat = {
  last_run_at: '2026-10-22T11:59:30.000Z',
  last_success_at: '2026-10-22T11:59:30.000Z',
  last_claimed_count: 3,
  last_settled_count: 3,
  last_skip_reason: null,
};

describe('Internal Health Probe (/api/internal/health)', () => {
  it('returns ok when heartbeat is fresh, storage is up, and queue is clear', async () => {
    const db = createMockDb({
      heartbeat: freshHeartbeat,
      pageCounts: { active: 10, rate_limited: 2 },
      accountCounts: { active: 4 },
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe('ok');
    expect(res.payload.checks.database.ok).toBe(true);
    expect(res.payload.checks.heartbeat.ok).toBe(true);
    expect(res.payload.checks.heartbeat.ageSeconds).toBe(30);
    expect(res.payload.checks.heartbeat.claimed).toBe(3);
    expect(res.payload.checks.storage.ok).toBe(true);
    // Spec 174 1B: page counts are per-section, keyed
    // `section:status` (the mock answers the same count per
    // section; the schedule bucket is the pinned one).
    expect(res.payload.checks.facebook.pagesByStatus['schedule:active']).toBe(10);
    expect(res.payload.checks.facebook.accountsByStatus.active).toBe(4);
  });

  it('flips to unhealthy when the heartbeat is stale (simulated dead worker)', async () => {
    const db = createMockDb({
      heartbeat: {
        ...freshHeartbeat,
        last_run_at: '2026-10-22T11:50:00.000Z',
        last_success_at: '2026-10-22T11:50:00.000Z',
      },
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.statusCode).toBe(503);
    expect(res.payload.status).toBe('unhealthy');
    expect(res.payload.checks.heartbeat.ok).toBe(false);
    expect(res.payload.checks.heartbeat.ageSeconds).toBe(600);
  });

  it('flips to unhealthy when no heartbeat row exists', async () => {
    const db = createMockDb({ heartbeat: null });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.statusCode).toBe(503);
    expect(res.payload.status).toBe('unhealthy');
    expect(res.payload.checks.heartbeat.ok).toBe(false);
    expect(res.payload.checks.heartbeat.ageSeconds).toBeNull();
  });

  it('reports the skip reason recorded by the worker', async () => {
    const db = createMockDb({
      heartbeat: {
        last_run_at: '2026-10-22T11:59:30.000Z',
        last_success_at: '2026-10-22T11:40:00.000Z',
        last_claimed_count: 0,
        last_settled_count: 0,
        last_skip_reason: 'missing_token_encryption_key',
      },
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.payload.checks.heartbeat.lastSkipReason).toBe(
      'missing_token_encryption_key'
    );
    expect(res.payload.status).toBe('unhealthy');
  });

  it('returns degraded when items are stuck in publishing beyond the recovery threshold', async () => {
    const db = createMockDb({
      heartbeat: freshHeartbeat,
      stuckCount: 2,
      dueCount: 5,
      oldestScheduledTime: '2026-10-22T11:55:00.000Z',
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe('degraded');
    expect(res.payload.checks.queue.stuckPublishingCount).toBe(2);
    expect(res.payload.checks.queue.dueCount).toBe(5);
    expect(res.payload.checks.queue.oldestDueAgeSeconds).toBe(300);
  });

  it('reads queue counts from the unified queue_items table only (Phase 7: no legacy field)', async () => {
    const db = createMockDb({
      heartbeat: freshHeartbeat,
      dueCount: 7,
      stuckCount: 0,
      oldestScheduledTime: '2026-10-22T11:50:00.000Z',
      pageCounts: { active: 3 },
      accountCounts: { active: 1 },
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.payload.status).toBe('ok');
    expect(res.payload.checks.queue.dueCount).toBe(7);
    expect(res.payload.checks.queue.oldestDueAgeSeconds).toBe(600);
    expect(res.payload.checks.queue.stuckPublishingCount).toBe(0);
    expect('legacy' in res.payload.checks.queue).toBe(false);
    // The probe never touches a dropped table, and the Facebook
    // aggregates come from the unified tables scoped to facebook.
    const touchedTables = new Set(db.__queries.map((q) => q.table));
    expect(touchedTables).not.toContain('legacy_queue_items');
    expect(touchedTables).not.toContain('facebook_pages');
    expect(touchedTables).not.toContain('facebook_accounts');
    const destinationQueries = queriesFor(db, 'destinations');
    expect(destinationQueries.length).toBeGreaterThan(0);
    expect(destinationQueries.every((q) => q.filters.platform === 'facebook')).toBe(true);
    const accountQueries = queriesFor(db, 'social_accounts');
    expect(accountQueries.length).toBeGreaterThan(0);
    expect(accountQueries.every((q) => q.filters.platform === 'facebook')).toBe(true);
    expect(res.payload.checks.facebook.pagesByStatus['schedule:active']).toBe(3);
    expect(res.payload.checks.facebook.accountsByStatus.active).toBe(1);
  });

  it('queries the unified queue with claim semantics: queued + scheduled_time due', async () => {
    const db = createMockDb({ heartbeat: freshHeartbeat });
    await probeInternalHealth({ db, checkStorage: async () => true, now: NOW });
    const unified = queriesFor(db, 'queue_items');
    const due = unified.find((q) => q.filters.status === 'queued');
    expect(due).toBeDefined();
    expect(due?.lte.scheduled_time).toBe(NOW.toISOString());
    // Oldest-due lookup uses the same predicate
    const oldestLookups = unified.filter(
      (q) => q.filters.status === 'queued' && q.lte.scheduled_time === NOW.toISOString()
    );
    expect(oldestLookups.length).toBeGreaterThanOrEqual(1);
  });

  it('queries unified stuck publishing with COALESCE(claimed_at, updated_at) at the 10-minute recovery threshold', async () => {
    const db = createMockDb({ heartbeat: freshHeartbeat, stuckCount: 4 });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.payload.checks.queue.stuckPublishingCount).toBe(4);
    const stuckBefore = '2026-10-22T11:50:00.000Z'; // NOW - 10 minutes
    const unified = queriesFor(db, 'queue_items');
    const stuck = unified.find((q) => q.filters.status === 'publishing');
    expect(stuck).toBeDefined();
    expect(stuck?.or).toBe(
      `claimed_at.lte.${stuckBefore},and(claimed_at.is.null,updated_at.lte.${stuckBefore})`
    );
  });

  it('reports a stalled unified queue as degraded with the oldest due age', async () => {
    const db = createMockDb({
      heartbeat: freshHeartbeat,
      dueCount: 42,
      stuckCount: 3,
      oldestScheduledTime: '2026-10-22T10:00:00.000Z',
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.payload.status).toBe('degraded');
    expect(res.payload.checks.queue.dueCount).toBe(42);
    expect(res.payload.checks.queue.oldestDueAgeSeconds).toBe(7200);
  });

  it('reports sectionCheck clean when every destination is labelled', async () => {
    const db = createMockDb({
      heartbeat: freshHeartbeat,
      pageCounts: { active: 10 },
      accountCounts: { active: 4 },
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.payload.status).toBe('ok');
    expect(res.payload.checks.facebook.sectionCheck).toEqual({
      dirty: false,
      unsectionedDestinations: 0,
      wrongSectionChildren: 0,
      checkedAt: NOW.toISOString(),
    });
  });

  it('flags unsectioned destinations in sectionCheck and degrades', async () => {
    const db = createMockDb({
      heartbeat: freshHeartbeat,
      sectionCheck: { unsectioned: 1 },
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe('degraded');
    expect(res.payload.checks.facebook.sectionCheck).toEqual({
      dirty: true,
      unsectionedDestinations: 1,
      wrongSectionChildren: 0,
      checkedAt: NOW.toISOString(),
    });
    // The unsectioned query is Facebook-scoped like the rest of
    // the block, and carries no status filter (unlike the
    // per-section buckets).
    const sectionQuery = queriesFor(db, 'destinations').find(
      (q) => q.filters.section === null && q.filters.status === undefined
    );
    expect(sectionQuery).toBeDefined();
    expect(sectionQuery?.filters.platform).toBe('facebook');
  });

  it('flags wrong-section children in sectionCheck with per-table predicates', async () => {
    const db = createMockDb({
      heartbeat: freshHeartbeat,
      sectionCheck: { slots: 1, queueItems: 2, aduConfigs: 0, slotClaims: 1 },
    });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => true,
      now: NOW,
    });
    expect(res.payload.status).toBe('degraded');
    expect(res.payload.checks.facebook.sectionCheck).toEqual({
      dirty: true,
      unsectionedDestinations: 0,
      wrongSectionChildren: 4,
      checkedAt: NOW.toISOString(),
    });
    // Every child query joins destinations, scopes to Facebook
    // pages, and filters on the owning section: slots/claims want
    // schedule, ADU configs want adu, queue items accept schedule
    // or publish_now.
    const childQueries = db.__queries.filter((q) =>
      q.select?.includes('destinations!inner')
    );
    expect(childQueries.map((q) => q.table).sort()).toEqual([
      'adu_configs',
      'posting_slot_claims',
      'posting_slots',
      'queue_items',
    ]);
    for (const q of childQueries) {
      expect(q.filters['destinations.platform']).toBe('facebook');
    }
    const slots = childQueries.find((q) => q.table === 'posting_slots');
    expect(slots?.neq['destinations.section']).toBe('schedule');
    const claims = childQueries.find((q) => q.table === 'posting_slot_claims');
    expect(claims?.neq['destinations.section']).toBe('schedule');
    const adu = childQueries.find((q) => q.table === 'adu_configs');
    expect(adu?.neq['destinations.section']).toBe('adu');
    const queue = childQueries.find((q) => q.table === 'queue_items');
    expect(queue?.not).toEqual([
      {
        column: 'destinations.section',
        operator: 'in',
        value: '(schedule,publish_now)',
      },
    ]);
  });

  it('flips to unhealthy when storage is down', async () => {
    const db = createMockDb({ heartbeat: freshHeartbeat });
    const res = await probeInternalHealth({
      db,
      checkStorage: async () => false,
      now: NOW,
    });
    expect(res.statusCode).toBe(503);
    expect(res.payload.checks.storage.ok).toBe(false);
  });
});

describe('Internal Health Authorization', () => {
  const SECRET = 'internal-test-session-secret-at-least-32-chars';
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
    process.env.INTERNAL_HEALTH_TOKEN = 'internal-health-token-value';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('rejects requests with no credentials', async () => {
    const req = new Request('https://app.example.com/api/internal/health');
    expect(await authorizeInternalRequest(req)).toBe(false);
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token', async () => {
    const req = new Request('https://app.example.com/api/internal/health', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(await authorizeInternalRequest(req)).toBe(false);
  });

  it('accepts the internal bearer token', async () => {
    const req = new Request('https://app.example.com/api/internal/health', {
      headers: { authorization: 'Bearer internal-health-token-value' },
    });
    expect(await authorizeInternalRequest(req)).toBe(true);
  });

  it('accepts an admin session and rejects a non-admin session', async () => {
    const adminToken = await signSessionToken(
      {
        userId: '11111111-1111-4111-a111-111111111111',
        email: 'adminregularuser@gmail.com',
        name: null,
        subdomain: 'adminws',
        role: 'admin',
        status: 'active',
      },
      SECRET
    );
    const adminReq = new Request('https://app.example.com/api/internal/health', {
      headers: { cookie: `fbup_session=${adminToken}` },
    });
    expect(await authorizeInternalRequest(adminReq)).toBe(true);

    const userToken = await signSessionToken(
      {
        userId: '22222222-2222-4222-a222-222222222222',
        email: 'regularuser@gmail.com',
        name: null,
        subdomain: 'userws',
        role: 'user',
        status: 'active',
      },
      SECRET
    );
    const userReq = new Request('https://app.example.com/api/internal/health', {
      headers: { cookie: `fbup_session=${userToken}` },
    });
    expect(await authorizeInternalRequest(userReq)).toBe(false);
  });
});
