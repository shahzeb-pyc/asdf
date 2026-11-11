-- Spec 166 (PR A) — destinations table split, step 1: backfill.
--
-- Copies every `destinations` row into the section table(s) it belongs
-- to (spec.md §7.2). No child rows are re-pointed here; no code reads
-- the new tables yet; the old table stays the live table.
--
-- Rules (§7.2):
--   1. Schedule copy for every old row with Schedule data
--      (`posting_slots` OR `queue_items` OR `publish_logs` OR
--      `posting_slot_claims` referencing it), PLUS every old row with
--      NO membership anywhere (no FK child in any section table and
--      no `mirrors` target — a connected page never added anywhere;
--      Schedule is its default home, spec §5). An ADU-only or
--      mirror-only page therefore gets NO Schedule copy: it was added
--      somewhere, so the default arm does not apply.
--   2. ADU copy for every old row referenced by `adu_configs`.
--   3. Mirror copy for every old row that is a mirror target (a
--      `mirrors` row with matching workspace_id, target_platform =
--      platform, target_external_id = external_destination_id).
--      `mirrors.target_platform` is TEXT (20261029160000), so the
--      platform comparison casts the enum to text.
--   4. Each copy: NEW id, all columns copied byte-for-byte INCLUDING
--      `encrypted_destination_token` (ciphertext copied, NEVER
--      decrypted and re-encrypted), status copied as it stands,
--      `source_destination_id` = old id.
--
-- Idempotency: every INSERT is `ON CONFLICT (account_id,
-- external_destination_id) DO NOTHING`, so re-running this migration
-- is a no-op (a second run inserts 0 rows and the assertions below
-- still hold).
--
-- Fail loud: the §7.2 invariants are asserted IN this migration
-- (DO blocks raising an exception — the whole migration rolls back,
-- never silently continues):
--   A. every old row has >= 1 copy;
--   B. every old row with children has a copy in that child's section
--      (Schedule / ADU / mirror-target);
--   C. per-section backfill copy counts reconcile exactly with the
--      backfill predicates (counted over provenance copies only, so a
--      post-split copy with NULL provenance cannot mask a gap);
--   D. no backfill copy has a NULL provenance;
--   E. token ciphertext is identical between each copy and its source
--      row (checked by value, never decrypted).

-- -----------------------------------------------------------------------------
-- 1. Schedule copies
-- -----------------------------------------------------------------------------
INSERT INTO public.schedule_destinations (
  id, workspace_id, account_id, platform, external_destination_id,
  name, handle, avatar_url, timezone, status,
  encrypted_destination_token, next_allowed_publish_at, rate_usage_pct,
  metadata, created_at, updated_at, source_destination_id
)
SELECT
  gen_random_uuid(),
  d.workspace_id, d.account_id, d.platform, d.external_destination_id,
  d.name, d.handle, d.avatar_url, d.timezone, d.status,
  d.encrypted_destination_token, d.next_allowed_publish_at, d.rate_usage_pct,
  d.metadata, d.created_at, d.updated_at, d.id
FROM public.destinations d
WHERE EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id)
   OR EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id)
   OR EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id)
   OR EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)
   OR (
     NOT EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.mirrors m
       WHERE m.workspace_id = d.workspace_id
         AND m.target_platform = d.platform::text
         AND m.target_external_id = d.external_destination_id
     )
   )
ON CONFLICT (account_id, external_destination_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. ADU copies
-- -----------------------------------------------------------------------------
INSERT INTO public.adu_destinations (
  id, workspace_id, account_id, platform, external_destination_id,
  name, handle, avatar_url, timezone, status,
  encrypted_destination_token, next_allowed_publish_at, rate_usage_pct,
  metadata, created_at, updated_at, source_destination_id
)
SELECT
  gen_random_uuid(),
  d.workspace_id, d.account_id, d.platform, d.external_destination_id,
  d.name, d.handle, d.avatar_url, d.timezone, d.status,
  d.encrypted_destination_token, d.next_allowed_publish_at, d.rate_usage_pct,
  d.metadata, d.created_at, d.updated_at, d.id
FROM public.destinations d
WHERE EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id)
ON CONFLICT (account_id, external_destination_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Mirror copies
-- -----------------------------------------------------------------------------
INSERT INTO public.mirror_destinations (
  id, workspace_id, account_id, platform, external_destination_id,
  name, handle, avatar_url, timezone, status,
  encrypted_destination_token, next_allowed_publish_at, rate_usage_pct,
  metadata, created_at, updated_at, source_destination_id
)
SELECT
  gen_random_uuid(),
  d.workspace_id, d.account_id, d.platform, d.external_destination_id,
  d.name, d.handle, d.avatar_url, d.timezone, d.status,
  d.encrypted_destination_token, d.next_allowed_publish_at, d.rate_usage_pct,
  d.metadata, d.created_at, d.updated_at, d.id
FROM public.destinations d
WHERE EXISTS (
  SELECT 1 FROM public.mirrors m
  WHERE m.workspace_id = d.workspace_id
    AND m.target_platform = d.platform::text
    AND m.target_external_id = d.external_destination_id
)
ON CONFLICT (account_id, external_destination_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. §7.2 invariants — fail the migration, never silently continue.
-- -----------------------------------------------------------------------------

-- A. Every old row has >= 1 copy (provenance join).
DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.destinations d
  WHERE NOT EXISTS (SELECT 1 FROM public.schedule_destinations sd WHERE sd.source_destination_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM public.adu_destinations ad WHERE ad.source_destination_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM public.mirror_destinations md WHERE md.source_destination_id = d.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant A violated: % destinations row(s) have no section copy', v_missing;
  END IF;
END $$;

-- B1. Every old row with Schedule children has a Schedule copy.
DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.destinations d
  WHERE (
    EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id)
    OR EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id)
    OR EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id)
    OR EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)
  )
  AND NOT EXISTS (SELECT 1 FROM public.schedule_destinations sd WHERE sd.source_destination_id = d.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant B1 violated: % destinations row(s) with Schedule children have no Schedule copy', v_missing;
  END IF;
END $$;

-- B2. Every old row referenced by adu_configs has an ADU copy.
DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.destinations d
  WHERE EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM public.adu_destinations ad WHERE ad.source_destination_id = d.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant B2 violated: % destinations row(s) with adu_configs have no ADU copy', v_missing;
  END IF;
END $$;

-- B3. Every old row that is a mirror target has a mirror copy.
DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.destinations d
  WHERE EXISTS (
    SELECT 1 FROM public.mirrors m
    WHERE m.workspace_id = d.workspace_id
      AND m.target_platform = d.platform::text
      AND m.target_external_id = d.external_destination_id
  )
  AND NOT EXISTS (SELECT 1 FROM public.mirror_destinations md WHERE md.source_destination_id = d.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant B3 violated: % destinations row(s) that are mirror targets have no mirror copy', v_missing;
  END IF;
END $$;

-- C. Copy counts reconcile with the backfill predicates (provenance
-- copies only). Schedule expectation: Schedule children OR no
-- membership anywhere. ADU: adu_configs. Mirror: mirrors target.
DO $$
DECLARE
  v_expected_schedule int;
  v_actual_schedule int;
  v_expected_adu int;
  v_actual_adu int;
  v_expected_mirror int;
  v_actual_mirror int;
BEGIN
  SELECT count(*) INTO v_expected_schedule
  FROM public.destinations d
  WHERE EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id)
     OR EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id)
     OR EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id)
     OR EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)
     OR (
       NOT EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.mirrors m
         WHERE m.workspace_id = d.workspace_id
           AND m.target_platform = d.platform::text
           AND m.target_external_id = d.external_destination_id
       )
     );
  SELECT count(*) INTO v_actual_schedule
  FROM public.schedule_destinations WHERE source_destination_id IS NOT NULL;

  SELECT count(*) INTO v_expected_adu
  FROM public.destinations d
  WHERE EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id);
  SELECT count(*) INTO v_actual_adu
  FROM public.adu_destinations WHERE source_destination_id IS NOT NULL;

  SELECT count(*) INTO v_expected_mirror
  FROM public.destinations d
  WHERE EXISTS (
    SELECT 1 FROM public.mirrors m
    WHERE m.workspace_id = d.workspace_id
      AND m.target_platform = d.platform::text
      AND m.target_external_id = d.external_destination_id
  );
  SELECT count(*) INTO v_actual_mirror
  FROM public.mirror_destinations WHERE source_destination_id IS NOT NULL;

  IF v_actual_schedule <> v_expected_schedule THEN
    RAISE EXCEPTION 'spec 166 backfill invariant C violated: schedule_destinations provenance copies % <> expected %', v_actual_schedule, v_expected_schedule;
  END IF;
  IF v_actual_adu <> v_expected_adu THEN
    RAISE EXCEPTION 'spec 166 backfill invariant C violated: adu_destinations provenance copies % <> expected %', v_actual_adu, v_expected_adu;
  END IF;
  IF v_actual_mirror <> v_expected_mirror THEN
    RAISE EXCEPTION 'spec 166 backfill invariant C violated: mirror_destinations provenance copies % <> expected %', v_actual_mirror, v_expected_mirror;
  END IF;
END $$;

-- D. No backfill copy has a NULL provenance.
DO $$
DECLARE
  v_nulls int;
BEGIN
  SELECT count(*) INTO v_nulls FROM public.schedule_destinations WHERE source_destination_id IS NULL;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant D violated: % schedule_destinations row(s) have NULL source_destination_id', v_nulls;
  END IF;
  SELECT count(*) INTO v_nulls FROM public.adu_destinations WHERE source_destination_id IS NULL;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant D violated: % adu_destinations row(s) have NULL source_destination_id', v_nulls;
  END IF;
  SELECT count(*) INTO v_nulls FROM public.mirror_destinations WHERE source_destination_id IS NULL;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant D violated: % mirror_destinations row(s) have NULL source_destination_id', v_nulls;
  END IF;
END $$;

-- E. Token ciphertext identical per copy (value comparison, never decrypted).
DO $$
DECLARE
  v_mismatch int;
BEGIN
  SELECT count(*) INTO v_mismatch
  FROM public.schedule_destinations sd
  JOIN public.destinations d ON d.id = sd.source_destination_id
  WHERE sd.encrypted_destination_token IS DISTINCT FROM d.encrypted_destination_token;
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant E violated: % schedule_destinations copie(s) have a token differing from their source row', v_mismatch;
  END IF;
  SELECT count(*) INTO v_mismatch
  FROM public.adu_destinations ad
  JOIN public.destinations d ON d.id = ad.source_destination_id
  WHERE ad.encrypted_destination_token IS DISTINCT FROM d.encrypted_destination_token;
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant E violated: % adu_destinations copie(s) have a token differing from their source row', v_mismatch;
  END IF;
  SELECT count(*) INTO v_mismatch
  FROM public.mirror_destinations md
  JOIN public.destinations d ON d.id = md.source_destination_id
  WHERE md.encrypted_destination_token IS DISTINCT FROM d.encrypted_destination_token;
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant E violated: % mirror_destinations copie(s) have a token differing from their source row', v_mismatch;
  END IF;
END $$;
