import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the PR #78 SEND BACK: the coupon migration
 * shipped `coupon_redemptions` without `coupon_kind` and
 * `balance_restored`, while `coupons.ts` inserts/selects both on
 * every hold — so every hold failed at insert, and approve/reject
 * (which unconditionally select the held redemptions) failed for
 * ANY payment. The mock-based coupon suites cannot catch this:
 * their fake Supabase client accepts any column. This test reads
 * the real migration file and asserts the schema the code needs
 * actually exists in it.
 *
 * Path resolution is anchored to this file (import.meta.url), not
 * to the process working directory, so it runs the same under
 * Vitest from apps/web and in CI.
 */
const MIGRATION_PATH = fileURLToPath(
  new URL('../../../../../supabase/migrations/20261031180000_coupons.sql', import.meta.url)
);

// Mirrors REDEMPTION_COLUMNS in coupons.ts (every held/applied/
// release select, and the admin redemptions route select).
const REDEMPTION_COLUMNS = [
  'id',
  'coupon_id',
  'coupon_kind',
  'user_id',
  'payment_id',
  'period_id',
  'amount_pkr',
  'status',
  'balance_restored',
  'created_at',
  'updated_at',
];

// Mirrors COUPON_COLUMNS in coupons.ts.
const COUPON_COLUMNS = [
  'id',
  'code',
  'kind',
  'percent',
  'initial_balance_pkr',
  'remaining_balance_pkr',
  'consumed_at',
  'status',
  'created_by',
  'created_at',
  'updated_at',
];

function tableBlock(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

function assertColumnDefined(block: string, column: string): void {
  expect(block).toMatch(new RegExp(`^\\s*${column}\\s+`, 'm'));
}

describe('coupons migration schema/code match', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('defines coupon_kind and balance_restored on coupon_redemptions', () => {
    const block = tableBlock(sql, 'coupon_redemptions');
    expect(block).toMatch(
      /^\s*coupon_kind\s+text\s+NOT NULL\s+CHECK\s*\(coupon_kind\s+IN\s*\('percent_once',\s*'percent_multi',\s*'balance'\)\)/m
    );
    expect(block).toMatch(/^\s*balance_restored\s+boolean\s+NOT NULL\s+DEFAULT\s+false/m);
  });

  it('defines every column coupons.ts selects/inserts on coupon_redemptions', () => {
    const block = tableBlock(sql, 'coupon_redemptions');
    for (const column of REDEMPTION_COLUMNS) {
      assertColumnDefined(block, column);
    }
  });

  it('defines every column coupons.ts selects/writes on coupons', () => {
    const block = tableBlock(sql, 'coupons');
    for (const column of COUPON_COLUMNS) {
      assertColumnDefined(block, column);
    }
  });

  it('adds coupon_code and discount_pkr to subscription_payments', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS coupon_code\s+text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS discount_pkr\s+integer\s+NOT NULL\s+DEFAULT 0/);
  });
});
