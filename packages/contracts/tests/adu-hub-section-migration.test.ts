import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for the spec 174 PR 1B migration: every hub RPC
 * redefinition must match `section = 'adu'` in its destination join,
 * and the reverse migration must restore the pre-1B definitions with no
 * section predicate. This cannot catch a wrong redefinition — the live
 * test (supabase/migrations/tests/174-1b-migration.test.sh) does that,
 * on a fresh local database — but it pins the migration's shape so a
 * later edit cannot silently drop the predicate from one function.
 *
 * Path resolution is anchored to this file (import.meta.url), not to the
 * process working directory, so it runs the same under Vitest from
 * packages/contracts and in CI.
 */
const MIGRATION_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261112180000_adu_hub_section_label.sql',
    import.meta.url
  )
);
const REVERSE_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/reverse/20261112180000_adu_hub_section_label.sql',
    import.meta.url
  )
);

const HUB_FUNCTIONS = [
  'adu_hub_list',
  'adu_hub_stats',
  'threads_adu_hub_list',
  'threads_adu_hub_stats',
] as const;

describe('spec 174 PR 1B hub RPC section predicate', () => {
  it('redefines all four hub RPCs with a section = adu predicate', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    for (const fn of HUB_FUNCTIONS) {
      expect(sql).toContain(`FUNCTION public.${fn}(`);
    }
    // One predicate per function, in the WHERE clause (fail-closed:
    // a config pointing at a non-adu destination is excluded, not
    // shown with blank destination fields).
    expect(sql.match(/d\.section = 'adu'/g)?.length).toBe(4);
    expect(sql.match(/where c\.workspace_id = p_workspace_id\s+and d\.section = 'adu'/g)?.length).toBe(2);
    expect(sql.match(/and d\.platform = 'threads'\s+and d\.section = 'adu'/g)?.length).toBe(2);
  });

  it('reverse migration restores the pre-1B definitions without a section predicate', () => {
    const sql = readFileSync(REVERSE_PATH, 'utf8');
    for (const fn of HUB_FUNCTIONS) {
      expect(sql).toContain(`FUNCTION public.${fn}(`);
    }
    // The only "section" in the reverse file is the migration filename
    // in the header comment — the function bodies carry no predicate.
    expect(sql).not.toContain("d.section = 'adu'");
  });
});
