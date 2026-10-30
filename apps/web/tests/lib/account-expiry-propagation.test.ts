/**
 * @file account-expiry-propagation.test.ts
 * @description Account-expiry propagation (Facebook Accounts audit,
 * BG1/BG2/BG4): an account flipping to 'expired' flips its 'active'
 * destinations to 'error' and leaves every other destination status
 * alone; the destination-queue gate rejects queueing to an expired
 * account; and the SQL surfaces that cannot run in this environment
 * (the trigger, the slot-claim RPCs) are guarded by assertions on
 * their migration text so an edit that drops the active-only
 * predicate fails here instead of silently in production.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isAccountExpiredForEnqueue,
  type DestinationForEnqueue,
} from '@/lib/publishing/destination-enqueue';
import { propagateExpiredAccountDestinations } from '@/lib/publishing/account-expiry-propagation';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function baseDestination(
  overrides: Partial<DestinationForEnqueue> = {}
): DestinationForEnqueue {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    platform: 'facebook',
    timezone: 'UTC',
    status: 'active',
    metadata: null,
    accountId: ACCOUNT_ID,
    accountStatus: 'active',
    accountTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isAccountExpiredForEnqueue', () => {
  it('rejects a stored expired status', () => {
    expect(
      isAccountExpiredForEnqueue(baseDestination({ accountStatus: 'expired' }))
    ).toBe(true);
  });

  it('rejects a lapsed token even while the stored status is still active', () => {
    expect(
      isAccountExpiredForEnqueue(
        baseDestination({
          accountStatus: 'active',
          accountTokenExpiresAt: '2020-01-01T00:00:00.000Z',
        })
      )
    ).toBe(true);
  });

  it('allows an active account with a future token expiry', () => {
    expect(isAccountExpiredForEnqueue(baseDestination())).toBe(false);
  });

  it('allows an active account with no token expiry recorded', () => {
    expect(
      isAccountExpiredForEnqueue(
        baseDestination({ accountTokenExpiresAt: null })
      )
    ).toBe(false);
  });

  it('does not trust a destination whose account row cannot be seen', () => {
    expect(
      isAccountExpiredForEnqueue(baseDestination({ accountId: '' }))
    ).toBe(true);
  });
});

describe('propagateExpiredAccountDestinations (legacy SQL path)', () => {
  it('flips active destinations to error and nothing else', async () => {
    type Row = { id: string; account_id: string; status: string };
    const rows: Row[] = [
      { id: 'd-active', account_id: ACCOUNT_ID, status: 'active' },
      { id: 'd-paused', account_id: ACCOUNT_ID, status: 'disconnected' },
      { id: 'd-plain-disconnected', account_id: ACCOUNT_ID, status: 'disconnected' },
      { id: 'd-error', account_id: ACCOUNT_ID, status: 'error' },
      { id: 'd-rate-limited', account_id: ACCOUNT_ID, status: 'rate_limited' },
      { id: 'd-other-account', account_id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', status: 'active' },
    ];
    const seen: string[] = [];
    const legacy = {
      query: async (sql: string, params: unknown[]) => {
        seen.push(sql);
        // Simulate the UPDATE predicate, not just the call: only
        // rows matching account_id AND status='active' flip.
        const flipped: Array<{ id: string }> = [];
        for (const row of rows) {
          if (row.account_id === params[0] && row.status === 'active') {
            row.status = 'error';
            flipped.push({ id: row.id });
          }
        }
        return flipped;
      },
    };
    const count = await propagateExpiredAccountDestinations(
      legacy as never,
      ACCOUNT_ID
    );
    expect(count).toBe(1);
    expect(rows.find((r) => r.id === 'd-active')?.status).toBe('error');
    expect(rows.find((r) => r.id === 'd-paused')?.status).toBe('disconnected');
    expect(rows.find((r) => r.id === 'd-plain-disconnected')?.status).toBe('disconnected');
    expect(rows.find((r) => r.id === 'd-error')?.status).toBe('error');
    expect(rows.find((r) => r.id === 'd-rate-limited')?.status).toBe('rate_limited');
    expect(rows.find((r) => r.id === 'd-other-account')?.status).toBe('active');
    expect(seen.join('\n')).toContain("status = 'active'");
    expect(seen.join('\n')).toContain("status = 'error'");
    // Re-running is a no-op: the flipped row is no longer active.
    expect(
      await propagateExpiredAccountDestinations(legacy as never, ACCOUNT_ID)
    ).toBe(0);
  });
});

describe('propagateExpiredAccountDestinations (Supabase path)', () => {
  it('updates only active destinations for the account', async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const supabase = {
      from: (table: string) => {
        const filters: Array<[string, unknown]> = [];
        calls.push({ table, filters });
        const builder: Record<string, unknown> = {};
        builder.update = () => builder;
        builder.eq = (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        };
        builder.select = () =>
          Promise.resolve({ data: [{ id: 'd-active' }], error: null });
        return builder;
      },
    };
    const count = await propagateExpiredAccountDestinations(
      supabase as never,
      ACCOUNT_ID
    );
    expect(count).toBe(1);
    expect(calls[0]?.table).toBe('destinations');
    expect(calls[0]?.filters).toContainEqual(['account_id', ACCOUNT_ID]);
    expect(calls[0]?.filters).toContainEqual(['status', 'active']);
  });

  it('throws on a database error instead of silently succeeding', async () => {
    const supabase = {
      from: () => {
        const builder: Record<string, unknown> = {};
        builder.update = () => builder;
        builder.eq = () => builder;
        builder.select = () =>
          Promise.resolve({ data: null, error: new Error('boom') });
        return builder;
      },
    };
    await expect(
      propagateExpiredAccountDestinations(supabase as never, ACCOUNT_ID)
    ).rejects.toThrow('boom');
  });
});

describe('SQL surfaces that cannot run in this environment', () => {
  // No Postgres is available in the test environment, so the trigger
  // and slot-claim RPCs cannot be executed here. These assertions
  // guard their migration text instead: an edit that drops the
  // active-only predicate, or the account scoping, fails this test.
  // A live smoke check of the trigger belongs in the migration's
  // prod-application step, not in this suite.
  // Web tests run with cwd = apps/web (two levels below the repo
  // root); fall back to other plausible cwds so the guard still
  // runs when the suite is launched from the repo root.
  const candidates = [
    join(process.cwd(), '..', '..'),
    process.cwd(),
    join(process.cwd(), '..'),
  ];
  const readMigration = (name: string) => {
    const found = candidates.find((root) =>
      existsSync(join(root, 'supabase', 'migrations', name))
    );
    if (!found) throw new Error(`migration not found: ${name}`);
    return readFileSync(join(found, 'supabase', 'migrations', name), 'utf8');
  };

  it('the expiry trigger flips only active destinations of the flipped account', () => {
    const sql = readMigration(
      '20261030120000_account_expiry_propagation_trigger.sql'
    );
    expect(sql).toContain("NEW.status = 'expired'");
    expect(sql).toContain('WHERE account_id = NEW.id');
    expect(sql).toContain("AND status = 'active'");
    expect(sql).toContain("SET status = 'error'");
    expect(sql).toContain('ON public.social_accounts');
  });

  it('the slot-claim RPCs only consider active destinations, so a propagated page cannot claim a slot', () => {
    const sql = readMigration(
      '20261027130000_publisher_driven_posting_times.sql'
    );
    expect(sql).toContain("d.status = 'active'");
  });
});
