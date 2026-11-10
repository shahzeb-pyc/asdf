/**
 * @file workspace-active-period-migration.test.ts
 * @description C4: one "active period?" in the worker.
 * Verifies the migration file:
 * 1. Ships as ONE new forward migration named
 *    20261110000000_workspace_has_active_period.sql, sorting after
 *    the latest migration on main (20261109170000), and drops
 *    nothing.
 * 2. Defines workspace_has_active_period(p_workspace_id uuid,
 *    p_at timestamptz DEFAULT now()) — read-only, STABLE, SECURITY
 *    DEFINER, SET search_path = public, service-role-only grants —
 *    carrying the claim-RPC entitlement predicate (EXISTS admin
 *    owner OR EXISTS active, non-superseded period window).
 * 3. Redefines the three claim RPCs (claim_due_queue_items,
 *    claim_posting_slot_item, claim_publish_now_items) via
 *    CREATE OR REPLACE with unchanged signatures and unchanged
 *    REVOKE/GRANT lines — and replaces no other function.
 * 4. Each RPC body calls the shared function, and ZERO inline
 *    subscription_periods predicates remain in any RPC body (the
 *    only subscription_periods occurrence in the file is inside
 *    the new function itself).
 * 5. The slot claim passes p_now through, so its window is still
 *    evaluated at the claim time, not wall-clock now(); its
 *    v_owner_role lookup is gone.
 * Behavioural parity against a real Postgres (unpaid claims zero
 * rows, paid/admin claim normally, slot p_now inside/outside the
 * window) is run as a PR-stage live check and recorded in the
 * PR description.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');
const allFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const migrationFile = allFiles.find((f) => f.includes('workspace_has_active_period'));

const sql = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf-8')
  : '';

describe('C4: workspace_has_active_period migration', () => {
  it('ships as the single forward migration 20261110000000, after the latest on main', () => {
    expect(migrationFile).toBe('20261110000000_workspace_has_active_period.sql');
    expect(allFiles).toContain('20261109170000_apply_destination_fb_status_marker.sql');
    expect(
      (migrationFile as string) >
        '20261109170000_apply_destination_fb_status_marker.sql',
    ).toBe(true);
  });

  it('drops nothing (the temp snapshot drop inside claim_due is pre-existing)', () => {
    // The claim_due body re-carries the spec-138 temp snapshot:
    // DROP TABLE IF EXISTS pg_temp.claim138_rule_usage is a
    // transaction-local temp table, dropped on commit — not a
    // schema drop. Anything else dropping is a failure.
    expect(sql).not.toMatch(/DROP TABLE(?! IF EXISTS pg_temp\.claim138_rule_usage)/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
    expect(sql).not.toMatch(/DROP COLUMN/);
  });

  it('defines the shared function with the claim-RPC predicate shape', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.workspace_has_active_period\(\s+p_workspace_id uuid,\s+p_at timestamptz DEFAULT now\(\)\s+\)/,
    );
    expect(sql).toMatch(/RETURNS boolean/);
    expect(sql).toMatch(/LANGUAGE sql/);
    expect(sql).toMatch(/STABLE/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.workspace_has_active_period\(uuid, timestamptz\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.workspace_has_active_period\(uuid, timestamptz\)\s+TO service_role;/,
    );
    // The predicate itself: admin owner OR active window at p_at.
    expect(sql).toMatch(/u\.role = 'admin'/);
    expect(sql).toMatch(/sp\.superseded_at IS NULL/);
    expect(sql).toMatch(/sp\.starts_at <= p_at/);
    expect(sql).toMatch(/sp\.ends_at > p_at/);
  });

  it('redefines exactly the three claim RPCs, signatures unchanged', () => {
    const replacements = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    expect(replacements).toHaveLength(4);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_due_queue_items\(\s+p_platform public\.platform,\s+p_lane_kind_set TEXT\[\],\s+p_limit INT DEFAULT 500,\s+p_max_per_destination INT DEFAULT 3\s+\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_posting_slot_item\(\s+p_destination_id UUID,\s+p_slot_id UUID,\s+p_claim_date DATE,\s+p_now TIMESTAMPTZ,\s+p_window_minutes INT DEFAULT 5\s+\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_publish_now_items\(\s+p_limit INT DEFAULT 100\s+\)/,
    );
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.claim_due_queue_items\(public\.platform, TEXT\[\], INT, INT\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_due_queue_items\(public\.platform, TEXT\[\], INT, INT\) TO service_role;/,
    );
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.claim_posting_slot_item\(UUID, UUID, DATE, TIMESTAMPTZ, INT\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_posting_slot_item\(UUID, UUID, DATE, TIMESTAMPTZ, INT\) TO service_role;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_publish_now_items\(INT\) FROM PUBLIC;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_publish_now_items\(INT\) TO service_role;/,
    );
  });

  it('every RPC calls the shared function; no inline predicate survives in any RPC body', () => {
    const rpcBodies = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_due_queue_items'),
    );
    expect(rpcBodies).toMatch(
      /AND public\.workspace_has_active_period\(d\.workspace_id\)/g,
    );
    expect(
      rpcBodies.match(/AND public\.workspace_has_active_period\(d\.workspace_id\)/g),
    ).toHaveLength(3);
    expect(rpcBodies).toMatch(
      /IF NOT public\.workspace_has_active_period\(\s+\(SELECT workspace_id FROM public\.destinations WHERE public\.destinations\.id = p_destination_id\),\s+p_now\s+\) THEN/,
    );
    expect(rpcBodies).not.toContain('subscription_periods');
    expect(rpcBodies).not.toContain('v_owner_role');
    // The only subscription_periods occurrence in the whole file
    // is the predicate inside the new function itself.
    expect(sql.match(/subscription_periods/g)).toHaveLength(1);
  });
});
