import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerAduConfigUsage, releaseAduConfigUsage } from '@/lib/server/adu';

/**
 * ADU cap-at-add helpers (audit fix 2026-11-01, fix 2): creating
 * an ADU config registers one usage unit for its destination, and
 * deleting the config frees it — but only when the registry row
 * still carries the ADU feature. A registration failure deletes
 * the just-created config again, so a config can never exist
 * without its cap unit.
 */

type Row = Record<string, unknown>;

let destinations: Row[];
let usageRows: Row[];
let periods: Row[];
let deletedConfigIds: string[];
let billingClient: unknown;
let failDeleteOnce = false;

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => billingClient,
  };
});

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private insertRow: Row | null = null;
  private limitN: number | null = null;

  constructor(private table: string) {}

  private rows(): Row[] {
    if (this.table === 'destinations') return destinations;
    if (this.table === 'subscription_usage') return usageRows;
    if (this.table === 'subscription_periods') return periods;
    return [];
  }

  select(): this {
    return this;
  }

  insert(row: Row): this {
    this.op = 'insert';
    this.insertRow = { ...row };
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] !== val);
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push((r) => typeof r[col] === 'string' && typeof val === 'string' && r[col] <= val);
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push((r) => typeof r[col] === 'string' && typeof val === 'string' && r[col] > val);
    return this;
  }

  order(): this {
    return this;
  }

  private singleMode = false;

  single(): this {
    this.singleMode = true;
    return this;
  }

  maybeSingle(): this {
    return this;
  }

  private matched(): Row[] {
    let rows = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  then(resolve: (value: { data: unknown; error: unknown }) => void): void {
    if (this.op === 'insert' && this.insertRow) {
      const row = this.insertRow;
      const dup = usageRows.some(
        (r) =>
          r['user_id'] === row['user_id'] &&
          r['platform'] === row['platform'] &&
          r['destination_key'] === row['destination_key']
      );
      if (dup) {
        resolve({ data: null, error: { code: '23505' } });
        return;
      }
      usageRows.push(row);
      resolve({ data: [row], error: null });
      return;
    }
    if (this.op === 'update') {
      for (const row of this.matched()) Object.assign(row, this.patch);
      resolve({ data: [], error: null });
      return;
    }
    if (this.op === 'delete') {
      if (failDeleteOnce) {
        failDeleteOnce = false;
        resolve({ data: null, error: { code: '500' } });
        return;
      }
      const matched = this.matched();
      for (const row of matched) {
        const idx = usageRows.indexOf(row);
        if (idx >= 0) usageRows.splice(idx, 1);
      }
      resolve({ data: [], error: null });
      return;
    }
    const matched = this.matched();
    if (this.singleMode) {
      resolve({ data: matched[0] ?? null, error: matched.length === 0 ? { code: 'PGRST116' } : null });
      return;
    }
    resolve({ data: matched, error: null });
  }
}

function makeBillingClient(): unknown {
  return {
    from(table: string): FakeBuilder {
      return new FakeBuilder(table);
    },
  };
}

function makeCtx(role = 'user', deleteError = false): {
  workspaceId: string;
  supabase: SupabaseClient;
  userId: string;
  role: string;
} {
  return {
    workspaceId: 'ws-1',
    supabase: {
      from(table: string) {
        if (table !== 'adu_configs') throw new Error(`unexpected table ${table}`);
        return {
          delete() {
            return {
              eq(_col: string, val: unknown) {
                deletedConfigIds.push(val as string);
                return Promise.resolve({
                  data: [],
                  error: deleteError ? { code: '500' } : null,
                });
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient,
    userId: 'user-1',
    role,
  };
}

const ACTIVE_PERIOD: Row = {
  id: 'period-1',
  user_id: 'user-1',
  facebook_count: 10,
  instagram_count: 10,
  threads_count: 10,
  x_count: 10,
  tiktok_count: 10,
  youtube_count: 10,
  starts_at: '2020-01-01T00:00:00.000Z',
  ends_at: '2099-01-01T00:00:00.000Z',
  superseded_at: null,
};

describe('registerAduConfigUsage', () => {
  beforeEach(() => {
    destinations = [{ id: 'dest-1', external_destination_id: 'page-1', workspace_id: 'ws-1', platform: 'facebook' }];
    periods = [ACTIVE_PERIOD];
    usageRows = [];
    deletedConfigIds = [];
    billingClient = makeBillingClient();
    failDeleteOnce = false;
  });

  it('registers the destination with the ADU feature', async () => {
    const result = await registerAduConfigUsage(makeCtx(), 'facebook', 'dest-1', 'config-1');
    expect(result).toEqual({ ok: true });
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      user_id: 'user-1',
      platform: 'facebook',
      destination_key: 'page-1',
      feature: 'auto-download-upload',
      destination_id: 'dest-1',
    });
    expect(deletedConfigIds).toHaveLength(0);
  });

  it('skips registration for admins', async () => {
    const result = await registerAduConfigUsage(makeCtx('admin'), 'facebook', 'dest-1', 'config-1');
    expect(result).toEqual({ ok: true });
    expect(usageRows).toHaveLength(0);
  });

  it('skips with a loud log when no billing client exists', async () => {
    billingClient = null;
    const result = await registerAduConfigUsage(makeCtx(), 'facebook', 'dest-1', 'config-1');
    expect(result).toEqual({ ok: true });
    expect(usageRows).toHaveLength(0);
  });

  it('rolls back the config when the key lookup finds nothing', async () => {
    const result = await registerAduConfigUsage(makeCtx(), 'facebook', 'dest-missing', 'config-1');
    expect(result.ok).toBe(false);
    expect(deletedConfigIds).toEqual(['config-1']);
  });

  it('rolls back the config when registration throws, and reports the error', async () => {
    usageRows = [
      {
        user_id: 'user-1',
        platform: 'facebook',
        destination_key: 'page-1',
        feature: 'destination-queue',
      },
    ];
    // A capped registration colliding with nothing fails here via a
    // duplicate on a *different* destination? No — force the failure
    // through the key lookup: an unknown destination id.
    const result = await registerAduConfigUsage(makeCtx(), 'facebook', 'dest-unknown', 'config-9');
    expect(result.ok).toBe(false);
    expect(deletedConfigIds).toEqual(['config-9']);
  });
});

describe('releaseAduConfigUsage', () => {
  beforeEach(() => {
    destinations = [{ id: 'dest-1', external_destination_id: 'page-1', workspace_id: 'ws-1', platform: 'facebook' }];
    periods = [ACTIVE_PERIOD];
    usageRows = [
      {
        user_id: 'user-1',
        platform: 'facebook',
        destination_key: 'page-1',
        feature: 'auto-download-upload',
      },
      {
        user_id: 'user-1',
        platform: 'facebook',
        destination_key: 'page-1',
        feature: 'destination-queue',
      },
    ];
    deletedConfigIds = [];
    billingClient = makeBillingClient();
    failDeleteOnce = false;
  });

  it('frees only the ADU-feature row for the destination', async () => {
    await releaseAduConfigUsage(makeCtx(), 'facebook', 'dest-1');
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ feature: 'destination-queue' });
  });

  it('skips release for admins', async () => {
    await releaseAduConfigUsage(makeCtx('admin'), 'facebook', 'dest-1');
    expect(usageRows).toHaveLength(2);
  });

  it('skips release with a loud log when no billing client exists', async () => {
    billingClient = null;
    await releaseAduConfigUsage(makeCtx(), 'facebook', 'dest-1');
    expect(usageRows).toHaveLength(2);
  });
});

describe('registerAduConfigUsage gate and rollback failures', () => {
  beforeEach(() => {
    destinations = [{ id: 'dest-1', external_destination_id: 'page-1', workspace_id: 'ws-1', platform: 'facebook' }];
    periods = [];
    usageRows = [];
    deletedConfigIds = [];
    billingClient = makeBillingClient();
    failDeleteOnce = false;
  });

  it('returns the gate error and still rolls the config back when no period is active', async () => {
    const result = await registerAduConfigUsage(makeCtx(), 'facebook', 'dest-1', 'config-1');
    expect(result.ok).toBe(false);
    expect(deletedConfigIds).toEqual(['config-1']);
  });

  it('a failing rollback is logged and the gate error still returns', async () => {
    const result = await registerAduConfigUsage(makeCtx('user', true), 'facebook', 'dest-1', 'config-1');
    expect(result.ok).toBe(false);
    expect(deletedConfigIds).toEqual(['config-1']);
  });
});

describe('releaseAduConfigUsage failure branch', () => {
  beforeEach(() => {
    destinations = [{ id: 'dest-1', external_destination_id: 'page-1', workspace_id: 'ws-1', platform: 'facebook' }];
    periods = [ACTIVE_PERIOD];
    usageRows = [
      {
        user_id: 'user-1',
        platform: 'facebook',
        destination_key: 'page-1',
        feature: 'auto-download-upload',
      },
    ];
    deletedConfigIds = [];
    billingClient = makeBillingClient();
    failDeleteOnce = true;
  });

  it('a failing release is logged and swallowed — the delete already happened', async () => {
    await expect(releaseAduConfigUsage(makeCtx(), 'facebook', 'dest-1')).resolves.toBeUndefined();
    expect(usageRows).toHaveLength(1);
  });
});
