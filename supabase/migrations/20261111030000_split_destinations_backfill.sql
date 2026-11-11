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
-- One DO block, not three copies of the same INSERT and the same
-- assertions: the three section predicates share one column list and
-- one SELECT, and the per-section assertions loop over the table
-- names. The predicates are variables so the backfill and its own
-- count reconciliation can never drift apart.
--
-- Fail loud: the §7.2 invariants are asserted IN this migration
-- (RAISE EXCEPTION — the whole migration rolls back, never silently
-- continues):
--   A. every old row has >= 1 copy;
--   B. every old row with children has a copy in that child's section
--      (Schedule / ADU / mirror-target);
--   C. per-section backfill copy counts reconcile exactly with the
--      backfill predicates (counted over provenance copies only, so a
--      post-split copy with NULL provenance cannot mask a gap);
--   D. no backfill copy has a NULL provenance;
--   E. token ciphertext is identical between each copy and its source
--      row (checked by value, never decrypted).

DO $$
DECLARE
  -- Shared INSERT shape: one column list, one SELECT, three predicates.
  v_cols text := 'id, workspace_id, account_id, platform, external_destination_id, '
    || 'name, handle, avatar_url, timezone, status, encrypted_destination_token, '
    || 'rate_usage_pct, metadata, created_at, updated_at, '
    || 'refresh_lease_owner, refresh_lease_expires_at, source_destination_id';
  v_select text := 'SELECT gen_random_uuid(), d.workspace_id, d.account_id, d.platform, '
    || 'd.external_destination_id, d.name, d.handle, d.avatar_url, d.timezone, d.status, '
    || 'd.encrypted_destination_token, d.rate_usage_pct, d.metadata, d.created_at, d.updated_at, '
    || 'd.refresh_lease_owner, d.refresh_lease_expires_at, d.id FROM public.destinations d';
  -- Section-membership predicates (each is a WHERE fragment over alias d).
  v_sched_children text := 'EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id) '
    || 'OR EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id) '
    || 'OR EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id) '
    || 'OR EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)';
  v_no_membership text := 'NOT EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id) '
    || 'AND NOT EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id) '
    || 'AND NOT EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id) '
    || 'AND NOT EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id) '
    || 'AND NOT EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id) '
    || 'AND NOT EXISTS (SELECT 1 FROM public.mirrors m WHERE m.workspace_id = d.workspace_id '
    || 'AND m.target_platform = d.platform::text AND m.target_external_id = d.external_destination_id)';
  v_sched text := '(' || v_sched_children || ') OR (' || v_no_membership || ')';
  v_adu text := 'EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id)';
  v_mirror text := 'EXISTS (SELECT 1 FROM public.mirrors m WHERE m.workspace_id = d.workspace_id '
    || 'AND m.target_platform = d.platform::text AND m.target_external_id = d.external_destination_id)';
  v_child_pred text;
  v_expected int;
  v_actual int;
  v_missing int;
  v_mismatch int;
  t text;
BEGIN
  -- 1–3. The three backfill INSERTs (same shape, one predicate each).
  EXECUTE 'INSERT INTO public.schedule_destinations (' || v_cols || ') ' || v_select
    || ' WHERE ' || v_sched || ' ON CONFLICT (account_id, external_destination_id) DO NOTHING';
  EXECUTE 'INSERT INTO public.adu_destinations (' || v_cols || ') ' || v_select
    || ' WHERE ' || v_adu || ' ON CONFLICT (account_id, external_destination_id) DO NOTHING';
  EXECUTE 'INSERT INTO public.mirror_destinations (' || v_cols || ') ' || v_select
    || ' WHERE ' || v_mirror || ' ON CONFLICT (account_id, external_destination_id) DO NOTHING';

  -- A. Every old row has >= 1 copy (provenance join).
  SELECT count(*) INTO v_missing
  FROM public.destinations d
  WHERE NOT EXISTS (SELECT 1 FROM public.schedule_destinations sd WHERE sd.source_destination_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM public.adu_destinations ad WHERE ad.source_destination_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM public.mirror_destinations md WHERE md.source_destination_id = d.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'spec 166 backfill invariant A violated: % destinations row(s) have no section copy', v_missing;
  END IF;

  -- B/C/D/E, per section table — one loop, the table name and its child
  -- predicate are the only things that vary.
  FOREACH t IN ARRAY ARRAY['schedule_destinations', 'adu_destinations', 'mirror_destinations'] LOOP
    v_child_pred := CASE t
      WHEN 'schedule_destinations' THEN v_sched_children
      WHEN 'adu_destinations' THEN v_adu
      ELSE v_mirror
    END;

    -- B. Every old row with children in this section has a copy here.
    EXECUTE 'SELECT count(*) FROM public.destinations d WHERE (' || v_child_pred || ') '
      || 'AND NOT EXISTS (SELECT 1 FROM public.' || t || ' c WHERE c.source_destination_id = d.id)'
      INTO v_missing;
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'spec 166 backfill invariant B violated: % destinations row(s) with children have no % copy', v_missing, t;
    END IF;

    -- C. Backfill copy count reconciles with the backfill predicate.
    --    (Schedule uses the full predicate incl. the default arm.)
    EXECUTE 'SELECT count(*) FROM public.destinations d WHERE ' ||
      CASE t WHEN 'schedule_destinations' THEN v_sched ELSE v_child_pred END
      INTO v_expected;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE source_destination_id IS NOT NULL', t)
      INTO v_actual;
    IF v_actual <> v_expected THEN
      RAISE EXCEPTION 'spec 166 backfill invariant C violated: % provenance copies % <> expected %', t, v_actual, v_expected;
    END IF;

    -- D. No backfill copy has a NULL provenance.
    EXECUTE format('SELECT count(*) FROM public.%I WHERE source_destination_id IS NULL', t)
      INTO v_missing;
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'spec 166 backfill invariant D violated: % % row(s) have NULL source_destination_id', v_missing, t;
    END IF;

    -- E. Token ciphertext identical per copy (value comparison, never decrypted).
    EXECUTE format('SELECT count(*) FROM public.%I c JOIN public.destinations d ON d.id = c.source_destination_id '
      || 'WHERE c.encrypted_destination_token IS DISTINCT FROM d.encrypted_destination_token', t)
      INTO v_mismatch;
    IF v_mismatch > 0 THEN
      RAISE EXCEPTION 'spec 166 backfill invariant E violated: % % copie(s) have a token differing from their source row', v_mismatch, t;
    END IF;
  END LOOP;
END $$;
