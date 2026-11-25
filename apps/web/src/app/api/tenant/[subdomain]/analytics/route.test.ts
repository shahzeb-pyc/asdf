/**
 * Spec 241 — combined Analytics API route.
 *
 * - 401 without a session; 400 on a bad period/workspace; 403 for a
 *   workspace the caller does not own.
 * - workspace=all unions the CALLER's workspaces only.
 * - One row per Facebook page: a page in two sections (destinations
 *   + ADU + mirror rows) is counted once, preferring destinations.
 * - Read rules: sums from stored columns, unique viewers from the
 *   stored deduplicated values, every page except disconnected
 *   included (any status, any follower count).
 * - The scan pages in 200-row bounds (PostgREST truncates at 1,000).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getSessionSecret,
  signSessionToken,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { handleGetAnalytics } from './route';

type Row = Record<string, unknown>;

class FakeQuery {
  private readonly filters: Array<(r: Row) => boolean> = [];
  private orderColumn: string | null = null;
  private orderAscending = true;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;

  public constructor(
    private readonly rows: Row[],
    private readonly ranges: Array<{ table: string; from: number | null; to: number | null }>,
    private readonly table: string
  ) {}

  public select(): this {
    return this;
  }

  public eq(column: string, value: unknown): this {
    this.filters.push((r) => r[column] === value);
    return this;
  }

  public neq(column: string, value: unknown): this {
    this.filters.push((r) => r[column] !== value);
    return this;
  }

  public in(column: string, values: unknown[]): this {
    this.filters.push((r) => values.includes(r[column]));
    return this;
  }

  public order(column: string, opts?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.orderAscending = opts?.ascending ?? true;
    return this;
  }

  public range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  private matched(): Row[] {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderColumn !== null) {
      const column = this.orderColumn;
      const ascending = this.orderAscending;
      out = [...out].sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        const cmp = String(av) < String(bv) ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      out = out.slice(this.rangeFrom, this.rangeTo + 1);
    }
    return out;
  }

  public then<TResult1 = { data: Row[] | null; error: unknown }>(
    onFulfilled?: ((value: { data: Row[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1> {
    this.ranges.push({ table: this.table, from: this.rangeFrom, to: this.rangeTo });
    return Promise.resolve({ data: this.matched(), error: null }).then(onFulfilled, onRejected);
  }
}

class FakeSupabase {
  public readonly ranges: Array<{ table: string; from: number | null; to: number | null }> = [];

  public constructor(private readonly tables: Record<string, Row[]>) {}

  public from(table: string): FakeQuery {
    return new FakeQuery(this.tables[table] ?? [], this.ranges, table);
  }
}

const USER_ID = '11111111-1111-4111-a111-111111111111';
const OTHER_USER = '22222222-2222-4222-a222-222222222222';
const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WS_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function day(date: string, mediaViews: number, uniqueViewers: number) {
  return {
    date,
    media_views: mediaViews,
    unique_viewers: uniqueViewers,
    profile_views: 10,
    engagement: 20,
    video_views: 80,
    video_view_time_ms: 60_000,
    total_actions: 5,
    new_follows: 3,
    unfollows: 1,
    video_complete_views_30s: 40,
  };
}

function destRow(
  id: string,
  workspaceId: string,
  fbId: string,
  current: number,
  starting: number,
  withAnalytics = true,
  status = 'active'
): Row {
  return {
    id,
    workspace_id: workspaceId,
    external_destination_id: fbId,
    platform: 'facebook',
    status,
    metadata: {
      starting_followers: starting,
      current_followers: current,
      analytics_updated_at: '2026-11-10T22:00:00.000Z',
    },
    analytics_1d: withAnalytics ? day('2026-11-09', 100, 50) : null,
    analytics_7d: withAnalytics
      ? {
          days: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'].map(
            (d) => day(d, 100, 50)
          ),
          unique_viewers_7d: 300,
        }
      : null,
    analytics_28d: withAnalytics
      ? {
          days: Array.from({ length: 28 }, (_, i) => {
            const d = new Date(Date.UTC(2026, 9, 13 + i));
            return day(d.toISOString().slice(0, 10), 100, 50);
          }),
          unique_viewers_28d: 1200,
        }
      : null,
    analytics_locations: withAnalytics
      ? { countries: [{ country: 'PK', followers: 900 }], cities: [{ city: 'Karachi', followers: 400 }] }
      : null,
  };
}

function aduRow(id: string, destinationId: string, workspaceId: string): Row {
  return {
    id,
    destination_id: destinationId,
    workspace_id: workspaceId,
    status: 'active',
    starting_followers: 1000,
    current_followers: 1200,
    analytics_1d: day('2026-11-09', 100, 50),
    analytics_7d: {
      days: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'].map(
        (d) => day(d, 100, 50)
      ),
      unique_viewers_7d: 300,
    },
    analytics_28d: {
      days: Array.from({ length: 28 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 9, 13 + i));
        return day(d.toISOString().slice(0, 10), 100, 50);
      }),
      unique_viewers_28d: 1200,
    },
    analytics_locations: { countries: [{ country: 'PK', followers: 900 }], cities: [{ city: 'Karachi', followers: 400 }] },
    analytics_updated_at: '2026-11-10T22:00:00.000Z',
  };
}

function mirrorRow(id: string, workspaceId: string, fbId: string): Row {
  return {
    id,
    workspace_id: workspaceId,
    target_platform: 'facebook',
    target_external_id: fbId,
    status: 'active',
    starting_followers: 1000,
    current_followers: 1200,
    analytics_1d: day('2026-11-09', 100, 50),
    analytics_7d: {
      days: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'].map(
        (d) => day(d, 100, 50)
      ),
      unique_viewers_7d: 300,
    },
    analytics_28d: {
      days: Array.from({ length: 28 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 9, 13 + i));
        return day(d.toISOString().slice(0, 10), 100, 50);
      }),
      unique_viewers_28d: 1200,
    },
    analytics_locations: { countries: [{ country: 'PK', followers: 900 }], cities: [{ city: 'Karachi', followers: 400 }] },
    analytics_updated_at: '2026-11-10T22:00:00.000Z',
  };
}

async function sessionToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      userId: USER_ID,
      email: 'owner@example.com',
      name: 'Owner',
      subdomain: 'acme',
      workspaceId: WS_A,
      allowedSubdomains: ['acme'],
      role: 'user',
      status: 'active',
      iat: now,
      exp: now + 86400,
    } satisfies SessionPayload,
    getSessionSecret()
  );
}

function request(token: string | null, query = 'workspace=all&period=28'): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `fbup_session=${token}`;
  return new NextRequest(`http://localhost/api/tenant/acme/analytics?${query}`, { headers });
}

function workspaceTables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    workspaces: [
      { id: WS_A, owner_id: USER_ID, subdomain: 'acme', created_at: '2026-01-01T00:00:00.000Z' },
      { id: WS_B, owner_id: USER_ID, subdomain: 'beta', created_at: '2026-01-02T00:00:00.000Z' },
      { id: WS_C, owner_id: OTHER_USER, subdomain: 'gamma', created_at: '2026-01-03T00:00:00.000Z' },
    ],
    destinations: [],
    adu_configs: [],
    mirrors: [],
    ...extra,
  };
}

describe('GET /api/tenant/[subdomain]/analytics', () => {
  it('401 without a session', async () => {
    const res = await handleGetAnalytics(
      request(null),
      'acme',
      new FakeSupabase(workspaceTables()) as unknown as SupabaseClient
    );
    expect(res.status).toBe(401);
  });

  it('400 on a bad period and a non-uuid workspace', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(workspaceTables()) as unknown as SupabaseClient;
    expect((await handleGetAnalytics(request(token, 'workspace=all&period=90'), 'acme', db)).status).toBe(400);
    expect((await handleGetAnalytics(request(token, 'workspace=not-a-workspace&period=28'), 'acme', db)).status).toBe(400);
  });

  it('403 for a workspace the caller does not own', async () => {
    const token = await sessionToken();
    const res = await handleGetAnalytics(
      request(token, `workspace=${WS_C}&period=28`),
      'acme',
      new FakeSupabase(workspaceTables()) as unknown as SupabaseClient
    );
    expect(res.status).toBe(403);
  });

  it('workspace=all unions the caller workspaces only, and sums the stored columns', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [
          destRow('dest-a1', WS_A, 'fb-a', 1200, 1000),
          destRow('dest-b1', WS_B, 'fb-b', 800, 500),
          destRow('dest-c1', WS_C, 'fb-c', 5000, 4000),
        ],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.workspace).toBe('all');
    expect(body.period).toBe('28');
    expect(body.pagesIncluded).toBe(2); // fb-c (another owner's workspace) excluded
    expect(body.followers).toEqual({ total: 2000, gained: 500 });
    expect(body.mediaViews).toBe(28 * 200);
    // Stored deduplicated values, not the daily sums (28 × 50 × 2 = 2800).
    expect(body.uniqueViewers).toBe(2400);
    expect(body.dateRangeLabel).toBe('13 Oct 2026 – 9 Nov 2026');
    expect(body.periodLabel).toBe('Last 28 days · combined');
    expect(body.hasNoData).toBe(false);
    expect(body.topCountries).toEqual([{ name: 'Pakistan', count: 1800, sharePct: 90 }]);
  });

  it('a page in two sections is counted once, preferring destinations', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [destRow('dest-a1', WS_A, 'fb-a', 1200, 1000)],
        adu_configs: [aduRow('adu-a1', 'dest-a1', WS_A)],
        mirrors: [mirrorRow('mirror-a1', WS_A, 'fb-a')],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(1);
    expect(body.followers).toEqual({ total: 1200, gained: 200 });
    expect(body.mediaViews).toBe(28 * 100);
    expect(body.uniqueViewers).toBe(1200);
  });

  it('a page under 100 followers is included, with its followers and stored analytics counted', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [destRow('dest-small', WS_A, 'fb-small', 50, 10)],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(1);
    expect(body.followers).toEqual({ total: 50, gained: 40 });
    expect(body.hasNoData).toBe(false);
    expect(body.mediaViews).toBe(28 * 100);
    expect(body.uniqueViewers).toBe(1200);
  });

  it('a page with no analytics yet is hasNoData with its followers still counted', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [destRow('dest-fresh', WS_A, 'fb-fresh', 500, 400, false)],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(1);
    expect(body.followers).toEqual({ total: 500, gained: 100 });
    expect(body.hasNoData).toBe(true);
    expect(body.mediaViews).toBe(0);
    expect(body.chart).toEqual([]);
    expect(body.dateRangeLabel).toBe('');
  });

  it('an error-status page with stored analytics is included in the followers and views totals', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [destRow('dest-err', WS_A, 'fb-err', 1200, 1000, true, 'error')],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(1);
    expect(body.followers).toEqual({ total: 1200, gained: 200 });
    expect(body.mediaViews).toBe(28 * 100);
    expect(body.uniqueViewers).toBe(1200);
    expect(body.hasNoData).toBe(false);
  });

  it('a paused page and a 0-follower page are included, a disconnected page is excluded from both totals', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [
          destRow('dest-paused', WS_A, 'fb-p', 800, 500, true, 'paused'),
          destRow('dest-zero', WS_A, 'fb-z', 0, 0),
          destRow('dest-disc', WS_A, 'fb-d', 5000, 4000, true, 'disconnected'),
        ],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(2); // fb-p and fb-z; fb-d is disconnected
    expect(body.followers).toEqual({ total: 800, gained: 300 }); // the 0-follower page adds 0
    expect(body.mediaViews).toBe(2 * 28 * 100);
    expect(body.pagesConnected).toBe(2);
  });

  it('a page with unknown (null) followers contributes nothing', async () => {
    const token = await sessionToken();
    const nullRow = {
      ...destRow('dest-null', WS_A, 'fb-null', 500, 400, false),
      metadata: {
        starting_followers: null,
        current_followers: null,
        analytics_updated_at: '2026-11-10T22:00:00.000Z',
      },
    };
    const db = new FakeSupabase(workspaceTables({ destinations: [nullRow] }));
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(0);
    expect(body.followers).toEqual({ total: 0, gained: 0 });
    expect(body.hasNoData).toBe(true);
    expect(body.mediaViews).toBe(0);
  });

  it('a mirror in an error state is included, a disconnected mirror is excluded', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        mirrors: [
          { ...mirrorRow('mirror-err', WS_A, 'fb-merr'), status: 'error' },
          { ...mirrorRow('mirror-disc', WS_A, 'fb-mdisc'), status: 'disconnected' },
        ],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(1); // fb-merr only
    expect(body.followers).toEqual({ total: 1200, gained: 200 });
    expect(body.mediaViews).toBe(28 * 100);
    expect(body.uniqueViewers).toBe(1200);
  });

  it('a single workspace scopes to that workspace only', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [
          destRow('dest-a1', WS_A, 'fb-a', 1200, 1000),
          destRow('dest-b1', WS_B, 'fb-b', 800, 500),
        ],
      })
    );
    const res = await handleGetAnalytics(
      request(token, `workspace=${WS_B}&period=7`),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspace).toBe(WS_B);
    expect(body.pagesIncluded).toBe(1);
    expect(body.followers).toEqual({ total: 800, gained: 300 });
    expect(body.mediaViews).toBe(7 * 100);
    expect(body.uniqueViewers).toBe(300);
    expect(body.dateRangeLabel).toBe('3 – 9 Nov 2026');
    // The stored PK count (900) exceeds the current total (800):
    // the share clamps at 100, the count stays exact.
    expect(body.topCountries).toEqual([{ name: 'Pakistan', count: 900, sharePct: 100 }]);
  });

  it('pagesConnected counts every non-disconnected page (spec 242), even ones the listed set excludes', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [
          destRow('dest-a1', WS_A, 'fb-a', 1200, 1000),
          // Same page held in a second section: still one connected page.
          destRow('dest-a2', WS_A, 'fb-a', 1200, 1000),
          // Paused, error, and under-100 pages count as connected…
          destRow('dest-b1', WS_A, 'fb-b', 800, 500, true, 'paused'),
          destRow('dest-c1', WS_A, 'fb-c', 50, 10, true, 'error'),
          // …but a disconnected page does not.
          destRow('dest-d1', WS_A, 'fb-d', 5000, 4000, true, 'disconnected'),
        ],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesConnected).toBe(3); // fb-a, fb-b, fb-c
    expect(body.pagesIncluded).toBe(3); // fb-d (disconnected) is the only one out
    expect(body.followers).toEqual({ total: 2050, gained: 540 });
  });

  it('pagesConnected follows the workspace picker, and does not change with the period', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [
          destRow('dest-a1', WS_A, 'fb-a', 1200, 1000),
          destRow('dest-b1', WS_B, 'fb-b', 800, 500),
          destRow('dest-b2', WS_B, 'fb-b2', 300, 200, true, 'paused'),
        ],
      })
    );
    const single = (await (
      await handleGetAnalytics(
        request(token, `workspace=${WS_B}&period=28`),
        'acme',
        db as unknown as SupabaseClient
      )
    ).json()) as Record<string, unknown>;
    expect(single.pagesConnected).toBe(2);
    expect(single.pagesIncluded).toBe(2); // fb-b active and fb-b2 paused both count now
    const all = (await (
      await handleGetAnalytics(request(token, 'workspace=all&period=28'), 'acme', db as unknown as SupabaseClient)
    ).json()) as Record<string, unknown>;
    expect(all.pagesConnected).toBe(3);
    const oneDay = (await (
      await handleGetAnalytics(request(token, 'workspace=all&period=1'), 'acme', db as unknown as SupabaseClient)
    ).json()) as Record<string, unknown>;
    expect(oneDay.pagesConnected).toBe(3);
  });

  it('pagesConnected is zero when no page is connected', async () => {
    const token = await sessionToken();
    const db = new FakeSupabase(
      workspaceTables({
        destinations: [destRow('dest-d1', WS_A, 'fb-d', 5000, 4000, true, 'disconnected')],
      })
    );
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesConnected).toBe(0);
    expect(body.pagesIncluded).toBe(0);
  });

  it('the scan pages in 200-row bounds across 250 rows', async () => {
    const token = await sessionToken();
    const rows = Array.from({ length: 250 }, (_, i) =>
      destRow(`dest-${String(i).padStart(3, '0')}`, WS_A, `fb-${i}`, 1000, 900)
    );
    const db = new FakeSupabase(workspaceTables({ destinations: rows }));
    const res = await handleGetAnalytics(
      request(token),
      'acme',
      db as unknown as SupabaseClient
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesIncluded).toBe(250);
    const destRanges = db.ranges.filter((r) => r.table === 'destinations');
    expect(destRanges).toEqual([
      { table: 'destinations', from: 0, to: 199 },
      { table: 'destinations', from: 200, to: 399 },
    ]);
  });
});
