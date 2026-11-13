import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for the ADU F21 migration: the three hub RPC pairs
 * collapse into one platform-parameterised pair, and the collapse
 * must not drop the platform predicate (the FB-direction leak fix)
 * or the hide-disconnected predicate (#246). This cannot catch a
 * wrong definition — the live test
 * (supabase/migrations/tests/adu-opt-f21-migration.test.sh) does
 * that, on a fresh local database — but it pins the migration's
 * shape so a later edit cannot silently drop a predicate from the
 * unified function.
 *
 * Path resolution is anchored to this file (import.meta.url), not to the
 * process working directory, so it runs the same under Vitest from
 * packages/contracts and in CI.
 */
const MIGRATION_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261113170000_adu_hub_platform.sql',
    import.meta.url
  )
);
const REVERSE_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/reverse/20261113170000_adu_hub_platform.sql',
    import.meta.url
  )
);

// The six old functions the forward migration drops (exact old
// signatures — a CREATE OR REPLACE alone would leave them behind as
// overloads once the unified pair changes the argument list).
const OLD_FUNCTIONS = [
  'adu_hub_list(uuid, text, text, text, integer, integer)',
  'adu_hub_stats(uuid, text, text)',
  'threads_adu_hub_list(uuid, text, text, text, integer, integer)',
  'threads_adu_hub_stats(uuid, text, text)',
  'instagram_adu_hub_list(uuid, text, text, text, integer, integer)',
  'instagram_adu_hub_stats(uuid, text, text)',
] as const;

// The platform predicate (the FB-direction leak fix) and the Pages
// rule (hide-disconnected, #246), verbatim as written in the migration.
// destinations.platform is the public.platform ENUM (20261022120000),
// so the predicate casts the enum to text: a plain `= p_platform`
// (text) has no operator against the enum and fails 42883, and a
// cast of p_platform to the enum would ERROR on a bogus value
// instead of returning 0 rows.
const PLATFORM_PREDICATE = "d.platform::text = p_platform";
const DISCONNECTED_PREDICATE =
  "(d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')";

describe('ADU hub platform migration (F21)', () => {
  it('drops the six old functions, then defines the unified pair with a required p_platform', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    for (const fn of OLD_FUNCTIONS) {
      expect(sql).toContain(`DROP FUNCTION IF EXISTS public.${fn};`);
    }
    // The unified pair, with p_platform second and NO default on it.
    expect(sql).toContain(
      'FUNCTION public.adu_hub_list(p_workspace_id uuid, p_platform text,',
    );
    expect(sql).toContain(
      'FUNCTION public.adu_hub_stats(p_workspace_id uuid, p_platform text,',
    );
    expect(sql).not.toContain('p_platform text DEFAULT');
    expect(sql).not.toContain('p_platform text =');
    // Strip -- comments before counting: the header prose names the
    // predicates (and the SECURITY DEFINER absence) in words, so the
    // counts below pin the SQL bodies, not the prose.
    const sqlBody = sql.replace(/^--.*$/gm, '');
    // One platform predicate and one hide predicate per function.
    expect(sqlBody.split(PLATFORM_PREDICATE).length - 1).toBe(2);
    expect(sqlBody.split(DISCONNECTED_PREDICATE).length - 1).toBe(2);
    expect(sql).toContain("d.section = 'adu'");
    // Plain functions with the grant closure on the new signatures.
    expect(sqlBody).not.toContain('SECURITY DEFINER');
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public.adu_hub_list(uuid, text, text, text, text, integer, integer)',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.adu_hub_stats(uuid, text, text, text)',
    );
  });

  it('reverse migration drops the unified pair and restores the six #246 bodies with the hide predicate', () => {
    const sql = readFileSync(REVERSE_PATH, 'utf8');
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS public.adu_hub_list(uuid, text, text, text, text, integer, integer);',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS public.adu_hub_stats(uuid, text, text, text);',
    );
    for (const fn of [
      'adu_hub_list',
      'adu_hub_stats',
      'threads_adu_hub_list',
      'threads_adu_hub_stats',
      'instagram_adu_hub_list',
      'instagram_adu_hub_stats',
    ] as const) {
      expect(sql).toContain(`FUNCTION public.${fn}(`);
    }
    // The restored bodies carry the hide predicate (six functions)
    // and no platform predicate (the reverse restores the pre-F21
    // state, leak included, by design).
    expect(sql.split(DISCONNECTED_PREDICATE).length - 1).toBe(6);
    expect(sql).not.toContain(PLATFORM_PREDICATE);
    expect(sql).toContain("d.section = 'adu'");
  });
});
