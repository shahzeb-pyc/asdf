import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for the spec 174 PR 1A migration: the migration file must
 * contain every element the backfill depends on. This cannot catch a
 * wrong backfill — the live test
 * (supabase/migrations/tests/174-1a-migration.test.sh) does that, on a
 * fresh local database — but it pins the migration's shape so a later
 * edit cannot silently drop a step.
 *
 * Path resolution is anchored to this file (import.meta.url), not to the
 * process working directory, so it runs the same under Vitest from
 * packages/contracts and in CI.
 */
const MIGRATION_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261112150000_destinations_section_label.sql',
    import.meta.url
  )
);
const REVERSE_PATH = fileURLToPath(
  new URL(
    '../../../supabase/migrations/reverse/20261112150000_destinations_section_label.sql',
    import.meta.url
  )
);

// The 16 owner-confirmed no-evidence Facebook ids (spec §5.3, re-counted
// fresh at build time; CSV: specs/174 evidence/census-no-evidence-2026-11-12.csv).
const NO_EVIDENCE_FACEBOOK_IDS = [
  'e3a6a989-eeb3-44e6-a157-4c5ff1b364f8',
  'f78eaf14-94a5-421c-8e54-b81915e17135',
  '6258695c-b29c-44b6-b028-76bd2e940afa',
  'c6a7f476-b0b1-4690-9e3e-4d6cad907ede',
  '63b31526-a956-43d6-b8e3-8c892d6ae010',
  '1ebd7a14-0ce9-4273-b243-147e60763f26',
  '382097bf-292c-45de-9ff9-c087617acfef',
  'bd40cee4-863e-4fc6-ba57-1583b4ca634e',
  'f4699dd3-d83e-4f93-ac61-0fc35a2928c6',
  'db7475a8-c143-49e2-93ee-3823ffb9debf',
  'd7311301-58a9-4ed1-b3e0-65bb87745fe7',
  'e69663b5-04b4-4dcc-8fa1-6276aa7a563e',
  '25384b0d-6bad-49a1-ac8e-82c1653de8dd',
  '24113f75-6e00-41fa-a25e-c6099697139c',
  'a8dc82af-bf5e-4cb6-9441-41cebe1b8406',
  'e820b678-c35b-4bbd-8005-dcd050eb7b95',
];
const INSTAGRAM_CORRECTION_ID = 'a6a8ac7c-a449-4f2c-a959-aefda650f2e1';

describe('spec 174 PR 1A migration file', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('adds the section column with the four-value CHECK', () => {
    expect(sql).toMatch(/add column if not exists section text/i);
    expect(sql).toMatch(
      /check \(section in \('schedule', 'adu', 'mirror', 'publish_now'\)\)/i
    );
  });

  it('deletes exactly the 16 owner-confirmed no-evidence rows, guarded', () => {
    for (const id of NO_EVIDENCE_FACEBOOK_IDS) {
      expect(sql).toContain(id);
    }
    // The delete is guarded by a still-no-evidence assertion: if one of
    // the 16 gained evidence since the census, the migration fails.
    expect(sql).toMatch(/gained evidence; re-count before applying/);
    // …and the post-delete check is absence, not an exact count: on a
    // fresh database the rows never existed, so deleting 0 is correct
    // there. What must hold everywhere is that none of the 16 remain.
    expect(sql).toMatch(/remain after delete/);
  });

  it('removes the shahzeb.pxp Instagram row as a correction', () => {
    expect(sql).toContain(INSTAGRAM_CORRECTION_ID);
    expect(sql).toMatch(/the shahzeb\.pxp row remains after delete/);
  });

  it('deletes orphaned usage rows and splits multi-section rows with provenance', () => {
    expect(sql).toMatch(/delete from public\.subscription_usage su/);
    expect(sql).toMatch(/split_from_destination_id/);
    expect(sql).toMatch(/insert into public\.destinations \(/i);
  });

  it('re-points Auto Download configs and usage rows by feature', () => {
    expect(sql).toMatch(/update public\.adu_configs ac/);
    expect(sql).toMatch(/su\.feature = 'auto-download-upload'/);
    expect(sql).toMatch(/su\.feature = 'tiktok-mirror'/);
  });

  it('swaps the unique key and adds the list-query index', () => {
    expect(sql).toMatch(/drop constraint if exists uq_destinations_account_external/i);
    expect(sql).toMatch(
      /create unique index uq_destinations_account_external_section/i
    );
    expect(sql).toMatch(/idx_destinations_workspace_section_platform/);
  });

  it('asserts section counts, token equality, and zero orphans', () => {
    expect(sql).toMatch(/schedule rows % <> evidence %/);
    expect(sql).toMatch(/adu rows % <> evidence %/);
    expect(sql).toMatch(/mirror rows % <> evidence %/);
    expect(sql).toMatch(/split copies carry a token differing from their original/);
    expect(sql).toMatch(/posting_slots orphaned/);
    expect(sql).toMatch(/subscription_usage rows still point at deleted destinations/);
    expect(sql).toMatch(/usage rows point at a destination of the wrong section/);
  });

  it('never touches the revocation defect (explicitly out of this program)', () => {
    expect(sql.toLowerCase()).not.toContain('revocation');
    expect(sql.toLowerCase()).not.toContain('propagate');
  });
});

describe('spec 174 PR 1A reverse migration file', () => {
  const sql = readFileSync(REVERSE_PATH, 'utf8');

  it('re-points children back before deleting the copies', () => {
    const repoint = sql.indexOf('update public.adu_configs ac');
    const del = sql.indexOf("delete from public.destinations");
    expect(repoint).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(repoint);
  });

  it('restores the old unique key and drops the column', () => {
    expect(sql).toMatch(/add constraint uq_destinations_account_external/);
    expect(sql).toMatch(/drop column if exists section/i);
  });

  it('states the deletes stand (the 16 + 1 are not restored)', () => {
    expect(sql).toMatch(/does NOT restore/);
  });
});
