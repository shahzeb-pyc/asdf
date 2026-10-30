/**
 * Expiry propagation in the worker refresh job (Facebook Accounts
 * audit, BG2/BG4): flipping an account to 'expired' flips its
 * 'active' destinations to 'error' and leaves paused, disconnected,
 * already-'error', and rate_limited destinations alone. The
 * propagation helper itself is exercised here against an in-memory
 * fake of the refresh job's Supabase-shaped client; the database
 * trigger that covers SQL-side flips is guarded by migration-text
 * assertions in the web suite (no Postgres is available in this
 * environment), and its live smoke check belongs in the migration's
 * prod-application step.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InternalError } from '@fbuploadpro/contracts';
import { propagateExpiredDestinations, type RefreshDbClient } from './refresh.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

type DestinationRow = { id: string; account_id: string; status: string };

function makeClient(rows: DestinationRow[]): RefreshDbClient {
  return {
    from: (table: string) => {
      if (table !== 'destinations') throw new InternalError(`unexpected table ${table}`);
      let accountId: unknown;
      let status: unknown;
      const builder: Record<string, unknown> = {};
      builder.update = () => builder;
      builder.eq = (column: string, value: unknown) => {
        if (column === 'account_id') accountId = value;
        if (column === 'status') status = value;
        return builder;
      };
      builder.select = () => {
        // Apply the same predicate the real helper sends: account
        // match AND status='active' — the fake enforces nothing the
        // helper did not ask for.
        const flipped = rows.filter(
          (row) => row.account_id === accountId && row.status === status
        );
        for (const row of flipped) row.status = 'error';
        return Promise.resolve({
          data: flipped.map((row) => ({ id: row.id })),
          error: null,
        });
      };
      return builder as never;
    },
  };
}

describe('propagateExpiredDestinations', () => {
  it('flips active destinations to error and leaves every other status alone', async () => {
    const rows: DestinationRow[] = [
      { id: 'd-active', account_id: ACCOUNT_ID, status: 'active' },
      // Paused pages are stored as disconnected + marker; the helper
      // sees only the status, and disconnected is untouched.
      { id: 'd-paused', account_id: ACCOUNT_ID, status: 'disconnected' },
      { id: 'd-disconnected', account_id: ACCOUNT_ID, status: 'disconnected' },
      { id: 'd-error', account_id: ACCOUNT_ID, status: 'error' },
      { id: 'd-rate-limited', account_id: ACCOUNT_ID, status: 'rate_limited' },
      { id: 'd-other', account_id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', status: 'active' },
    ];
    const count = await propagateExpiredDestinations(makeClient(rows), ACCOUNT_ID);
    expect(count).toBe(1);
    expect(rows.find((r) => r.id === 'd-active')?.status).toBe('error');
    expect(rows.find((r) => r.id === 'd-paused')?.status).toBe('disconnected');
    expect(rows.find((r) => r.id === 'd-disconnected')?.status).toBe('disconnected');
    expect(rows.find((r) => r.id === 'd-error')?.status).toBe('error');
    expect(rows.find((r) => r.id === 'd-rate-limited')?.status).toBe('rate_limited');
    expect(rows.find((r) => r.id === 'd-other')?.status).toBe('active');
    // Idempotent: a second run flips nothing.
    expect(await propagateExpiredDestinations(makeClient(rows), ACCOUNT_ID)).toBe(0);
  });

  it('throws on a database error instead of reporting success', async () => {
    const failing = {
      from: () => {
        const builder: Record<string, unknown> = {};
        builder.update = () => builder;
        builder.eq = () => builder;
        builder.select = () =>
          Promise.resolve({ data: null, error: new Error('boom') });
        return builder as never;
      },
    } as RefreshDbClient;
    await expect(
      propagateExpiredDestinations(failing, ACCOUNT_ID)
    ).rejects.toThrow('boom');
  });
});

describe('slot-claim RPCs exclude propagated pages', () => {
  it('the slot SQL only considers active destinations', () => {
    const candidates = [
      join(process.cwd(), '..', '..'),
      process.cwd(),
      join(process.cwd(), '..'),
    ];
    const found = candidates.find((root) =>
      existsSync(
        join(root, 'supabase', 'migrations', '20261027130000_publisher_driven_posting_times.sql')
      )
    );
    if (!found) throw new InternalError('slot-claim migration not found');
    const sql = readFileSync(
      join(found, 'supabase', 'migrations', '20261027130000_publisher_driven_posting_times.sql'),
      'utf8'
    );
    expect(sql).toContain("d.status = 'active'");
  });
});
