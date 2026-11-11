/**
 * @file can-publish-for-migration.test.ts
 * @description S2: count enforcement in the worker.
 * Verifies the migration file:
 * 1. Ships as ONE new forward migration named
 *    20261110130000_can_publish_for.sql, sorting after the latest
 *    migration on main (20261110120000), and drops nothing.
 * 2. Defines can_publish_for(p_workspace_id uuid, p_platform
 *    text, p_destination_key text, p_at timestamptz DEFAULT
 *    now()) — read-only, STABLE, SECURITY DEFINER, SET
 *    search_path = public, service-role-only grants — calling the
 *    C4 workspace_has_active_period function for the period half
 *    (no second active-period predicate), with the admin
 *    exemption, the already-registered branch, and the usage <
 *    counts branch counted exactly as get_entitlement counts it
 *    (publish-now features excluded, disconnected destinations
 *    excluded with the d.platform::text = u.platform cast).
 * 3. Redefines exactly the two counted claim RPCs
 *    (claim_due_queue_items, claim_posting_slot_item) via CREATE
 *    OR REPLACE with unchanged signatures and unchanged
 *    REVOKE/GRANT lines — and replaces no other function.
 * 4. Each redefined RPC body calls can_publish_for. The due claim
 *    carries the marked publish-now exemption — marked rows are
 *    judged by the period predicate only
 *    (workspace_has_active_period), NOT exempt from it: the two
 *    marked-row calls in the due body are the only
 *    workspace_has_active_period calls outside can_publish_for
 *    itself. The slot claim passes p_now through.
 * 5. claim_publish_now_items does not appear in the migration
 *    at all (Publish Now stays uncapped, PR #77).
 * Behavioural parity against a real Postgres (at-cap
 * unregistered claims zero rows, registered/admin/marked claim
 * normally, slot p_now inside/outside the window, publish-now
 * at cap claims normally) is run as a PR-stage live check and
 * recorded in the PR description.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');
const allFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const migrationFile = allFiles.find((f) => f.includes('can_publish_for'));

const sql = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf-8')
  : '';

describe('S2: can_publish_for migration', () => {
  it('ships as the single forward migration 20261110130000, after the latest on main', () => {
    expect(migrationFile).toBe('20261110130000_can_publish_for.sql');
    expect(allFiles).toContain('20261110120000_drop_adu_source_unique_index.sql');
    expect(
      (migrationFile as string) > '20261110120000_drop_adu_source_unique_index.sql',
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

  it('defines the shared function with the count-predicate shape', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.can_publish_for\(\s+p_workspace_id uuid,\s+p_platform text,\s+p_destination_key text,\s+p_at timestamptz DEFAULT now\(\)\s+\)/,
    );
    expect(sql).toMatch(/RETURNS boolean/);
    expect(sql).toMatch(/LANGUAGE sql/);
    expect(sql).toMatch(/STABLE/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.can_publish_for\(uuid, text, text, timestamptz\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.can_publish_for\(uuid, text, text, timestamptz\)\s+TO service_role;/,
    );
    // The period half is a call to the C4 function, not a second predicate.
    expect(sql).toMatch(/public\.workspace_has_active_period\(p_workspace_id, p_at\)/);
    // Three calls in the file: one inside can_publish_for itself, plus
    // the two marked-row calls in the due claim (the marked exemption
    // is from the count half only — a marked row for an expired owner
    // must still claim nothing, PR #211 SEND BACK fix).
    expect(sql.match(/public\.workspace_has_active_period\(/g)).toHaveLength(3);
    expect(
      sql.match(/public\.workspace_has_active_period\(d\.workspace_id\)/g),
    ).toHaveLength(2);
    // Admin exemption, same shape as the C4 function.
    expect(sql).toMatch(/u\.role = 'admin'/);
    // The active period row carries the counts (get_entitlement shape).
    expect(sql).toMatch(/superseded_at IS NULL/);
    expect(sql).toMatch(/starts_at <= p_at/);
    expect(sql).toMatch(/ends_at > p_at/);
    // Already-registered branch: isDestinationUsed semantics.
    expect(sql).toMatch(/u\.destination_key = p_destination_key/);
    // Publish-now features excluded from both branches.
    expect(sql).toMatch(/u\.feature NOT IN \('publish-now', 'instagram-publish-now', 'threads-publish-now'\)/);
    // Disconnected exclusion with the C2 cast (enum vs text).
    expect(sql).toMatch(/d\.platform::text = u\.platform/);
    expect(sql).toMatch(/d\.status = 'disconnected'/);
  });

  it('redefines exactly the two counted claim RPCs, signatures unchanged', () => {
    const replacements = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    expect(replacements).toHaveLength(3);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_due_queue_items\(\s+p_platform public\.platform,\s+p_lane_kind_set TEXT\[\],\s+p_limit INT DEFAULT 500,\s+p_max_per_destination INT DEFAULT 3\s+\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_posting_slot_item\(\s+p_destination_id UUID,\s+p_slot_id UUID,\s+p_claim_date DATE,\s+p_now TIMESTAMPTZ,\s+p_window_minutes INT DEFAULT 5\s+\)/,
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
  });

  it('every redefined RPC calls can_publish_for; the marked-row exemption is period-only', () => {
    const rpcBodies = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_due_queue_items'),
    );
    // Due claim: exactly two call sites (snapshot + ranked), each
    // with the destination key expression and the marked-row exemption.
    expect(
      rpcBodies.match(/public\.can_publish_for\(d\.workspace_id, d\.platform::text, COALESCE\(d\.external_destination_id, d\.id::text\)\)/g),
    ).toHaveLength(2);
    expect(rpcBodies).toMatch(
      /\(qi\.publish_now_requested_at IS NULL AND public\.can_publish_for\(d\.workspace_id, d\.platform::text, COALESCE\(d\.external_destination_id, d\.id::text\)\)\) OR \(qi\.publish_now_requested_at IS NOT NULL AND public\.workspace_has_active_period\(d\.workspace_id\)\)/,
    );
    // Slot claim: one call site, workspace id and key from the
    // destinations select, window evaluated at p_now.
    expect(rpcBodies).toMatch(
      /IF NOT public\.can_publish_for\(v_workspace_id, 'facebook', v_destination_key, p_now\) THEN/,
    );
    expect(rpcBodies).toMatch(
      /COALESCE\(d\.external_destination_id, p_destination_id::text\)/,
    );
    // The ONLY workspace_has_active_period calls in either RPC body
    // are the two marked-row ones in the due claim (default p_at,
    // same as C4): a marked row is judged by the period predicate
    // only — exempt from the count half, NOT from the period half.
    // (The pre-existing comments above the call sites still name
    // the C4 function; the diff-proof keeps them byte-identical,
    // so the assertion is on the call form, not the bare name.)
    expect(
      rpcBodies.match(/public\.workspace_has_active_period\(d\.workspace_id\)/g),
    ).toHaveLength(2);
    expect(rpcBodies).not.toMatch(/workspace_has_active_period\(p_workspace_id/);
  });

  it('claim_publish_now_items does not appear in the migration at all', () => {
    expect(sql).not.toContain('claim_publish_now_items');
  });
});
