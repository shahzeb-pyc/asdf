/**
 * @file claim-slim-projection-migration.test.ts
 * @description Spec 211: claim RPC slim-projection migration.
 * Verifies the migration file:
 * 1. Ships as ONE new forward migration named
 *    20261120134000_claim_due_queue_items_slim_projection.sql, sorting
 *    after the live claim definition
 *    20261113060000_claim_rpc_section.sql, and never drops a table or
 *    a column.
 * 2. Drops + re-creates exactly ONE function:
 *    claim_due_queue_items(platform, TEXT[], INT, INT) — the DROP is
 *    required because the return type narrows (CREATE OR REPLACE
 *    cannot change it) — with the unchanged signature, defaults,
 *    SECURITY DEFINER posture, and the p_limit 1000 hard cap, and
 *    re-asserts the service-role-only ACLs exactly as spec 174 does.
 * 3. Narrows the return to exactly two columns: RETURNS TABLE(id uuid,
 *    destination_id uuid), and the final SELECT returns only
 *    `c.id, c.destination_id` — no destination / account / media join
 *    in the final SELECT, no encrypted tokens, no caption /
 *    platform_options / media columns in the return. The claimer
 *    consumes only `id`; the parity rig (case c6) reads
 *    `destination_id` to assert the per-destination headroom bound —
 *    that is why the projection keeps it.
 * 4. Keeps the claim semantics body-for-body: the 3-day rate_limited
 *    flip, the D5 grouped-usage snapshot (pg_temp.claim138_rule_usage,
 *    drop-guarded, ON COMMIT DROP), the deferral update, and the
 *    ranked per-destination selection are all still present.
 * The claimer consumes only `id` (apps/worker/src/claimer.ts), and the
 * consumers re-load full rows before publishing — so the narrowed
 * return cannot starve a publish.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');
const allFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const migrationFile = allFiles.find((f) => f.includes('claim_due_queue_items_slim_projection'));

const sql = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf-8')
  : '';

// The function body only (header comment excluded): the header names
// the dropped columns in prose, so return-shape assertions must run
// against the body, not the whole file.
const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_due_queue_items(');
const fnEndMarker = 'END;\n$function$;';
const fnEnd = fnStart === -1 ? -1 : sql.indexOf(fnEndMarker, fnStart) + fnEndMarker.length;
const fnBody = fnStart === -1 || fnEnd === -1 ? '' : sql.slice(fnStart, fnEnd);

describe('Spec 211: claim RPC slim-projection migration', () => {
  it('ships as the single forward migration 20261120134000, after spec 174', () => {
    expect(migrationFile).toBe('20261120134000_claim_due_queue_items_slim_projection.sql');
    expect(allFiles).toContain('20261113060000_claim_rpc_section.sql');
    expect(
      (migrationFile as string) > '20261113060000_claim_rpc_section.sql',
    ).toBe(true);
  });

  it('drops nothing but the claim function, and no tables or columns', () => {
    // The D5 snapshot's own guarded temp-table drop is the single
    // allowed DROP TABLE (same exception as the spec 138 test).
    expect(sql).not.toMatch(/DROP TABLE(?! IF EXISTS pg_temp\.claim138_rule_usage)/);
    expect(sql).not.toMatch(/DROP COLUMN/);
    const drops = sql.match(/DROP FUNCTION[^;]*;/g) ?? [];
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain(
      'DROP FUNCTION IF EXISTS public.claim_due_queue_items(public.platform, TEXT[], INT, INT)',
    );
  });

  it('re-creates exactly one function: claim_due_queue_items, signature unchanged', () => {
    const replacements = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    expect(replacements).toHaveLength(1);
    expect(fnBody).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_due_queue_items\(p_platform platform, p_lane_kind_set text\[\], p_limit integer DEFAULT 500, p_max_per_destination integer DEFAULT 3\)/,
    );
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/SET search_path TO 'public'/);
    expect(fnBody).toMatch(/LEAST\(GREATEST\(1, COALESCE\(p_limit, 500\)\), 1000\)/);
  });

  it('keeps the claim RPC service-role-only (spec 174 ACL pattern)', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.claim_due_queue_items\(public\.platform, TEXT\[\], INT, INT\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_due_queue_items\(public\.platform, TEXT\[\], INT, INT\) TO service_role;/,
    );
  });

  it('returns exactly two columns: id, destination_id', () => {
    expect(fnBody).toMatch(/RETURNS TABLE\(id uuid, destination_id uuid\)/);
    expect(fnBody).not.toContain('encrypted_access_token');
    expect(fnBody).not.toContain('encrypted_destination_token');
    expect(fnBody).not.toContain('platform_options');
    expect(fnBody).not.toContain('destination_name');
    expect(fnBody).not.toContain('media_storage_key');
    expect(fnBody).not.toContain('first_comment');
    expect(fnBody).toContain(
      'SELECT c.id, c.destination_id\n  FROM claimed c\n  ORDER BY c.scheduled_time ASC, c.id ASC;',
    );
  });

  it('keeps the claim semantics: rate-limit flip, D5 snapshot, deferral, ranked selection', () => {
    expect(fnBody).toMatch(/DROP TABLE IF EXISTS pg_temp\.claim138_rule_usage;/);
    expect(fnBody).toMatch(
      /CREATE TEMP TABLE pg_temp\.claim138_rule_usage ON COMMIT DROP AS/,
    );
    expect(fnBody).toMatch(/SET scheduled_time = r\.release_at/);
    expect(fnBody).toMatch(/ROW_NUMBER\(\) OVER \(/);
    expect(fnBody).toMatch(/status = 'publishing',\s+claimed_at = now\(\)/);
  });
});
