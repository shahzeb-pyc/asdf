import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for the ADU hide-disconnected migration: every hub RPC
 * redefinition must carry the Pages-section rule — a destination with
 * status 'disconnected' is excluded, except a paused page (disconnected
 * + metadata fb_status 'paused'), which stays listed — and the reverse
 * migration must restore the 1B definitions without it. This cannot
 * catch a wrong redefinition — the live test
 * (supabase/migrations/tests/adu-hide-disconnected-migration.test.sh)
 * does that, on a fresh local database — but it pins the migration's
 * shape so a later edit cannot silently drop the predicate from one
 * function.
 *
 * Path resolution is anchored to this file (import.meta.url), not to the
 * process working directory, so it runs the same under Vitest from
 * packages/contracts and in CI.
 */
const MIGRATION_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261113150000_adu_hub_hide_disconnected.sql',
    import.meta.url
  )
);
const REVERSE_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/reverse/20261113150000_adu_hub_hide_disconnected.sql',
    import.meta.url
  )
);

const HUB_FUNCTIONS = [
  'adu_hub_list',
  'adu_hub_stats',
  'threads_adu_hub_list',
  'threads_adu_hub_stats',
  'instagram_adu_hub_list',
  'instagram_adu_hub_stats',
] as const;

// The Pages rule, verbatim as written in the migration (and in the
// Pages list route): disconnected is excluded, paused stays.
const DISCONNECTED_PREDICATE =
  "(d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')";

describe('ADU hub hide-disconnected migration', () => {
  it('redefines all six hub RPCs with the disconnected predicate', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    for (const fn of HUB_FUNCTIONS) {
      expect(sql).toContain(`FUNCTION public.${fn}(`);
    }
    // One predicate per function, in the WHERE clause next to the
    // section predicate (fail-closed, same as the 1B predicate).
    expect(sql.split(DISCONNECTED_PREDICATE).length - 1).toBe(6);
    expect(sql).toContain("d.section = 'adu'");
  });

  it('reverse migration restores the 1B definitions without the predicate', () => {
    const sql = readFileSync(REVERSE_PATH, 'utf8');
    // The reverse restores the 1B bodies verbatim (uppercase) and the
    // 20261113130000 IG bodies verbatim (lowercase), so match the
    // function names case-insensitively.
    const lowered = sql.toLowerCase();
    for (const fn of HUB_FUNCTIONS) {
      expect(lowered).toContain(`function public.${fn}(`);
    }
    expect(sql).not.toContain(DISCONNECTED_PREDICATE);
    expect(sql).not.toContain("d.status <> 'disconnected'");
    expect(sql).toContain("d.section = 'adu'");
  });
});
