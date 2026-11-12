-- Spec 174 PR 1A — destinations section label + backfill.
--
-- Adds the `section` column to `destinations` (nullable for now; locked to
-- NOT NULL in Phase 4) and backfills it per spec §5:
--   * one section of evidence -> that section, labelled in place;
--   * several sections of evidence -> the row is SPLIT into one row per
--     section (the original keeps the first section in the order
--     schedule -> adu -> mirror; full copies for the other sections,
--     token + followers copied byte-for-byte, never decrypted or
--     re-encrypted; provenance recorded on every copy in
--     metadata.split_from_destination_id);
--   * children re-pointed by section (posting times / queued posts /
--     publish logs / slot claims stay on the Schedule row, i.e. the
--     original; Auto Download configs move to the Auto Download copy);
--   * usage rows re-pointed by feature (destination-queue -> schedule
--     row, auto-download-upload -> adu copy, tiktok-mirror -> mirror copy);
--   * usage rows pointing at deleted destinations are deleted;
--   * the 16 owner-confirmed no-evidence Facebook rows are DELETED
--     (owner order 2026-11-12: no proof which section they belong to,
--     so no label can truthfully be put on them — the one exception to
--     the never-hard-delete rule, limited to exactly these 16 ids);
--   * the 1 Instagram row (shahzeb.pxp) is removed as a correction
--     (it is an account, not a page; the account stays connected).
--
-- COUNTS ARE COMPUTED FROM LIVE EVIDENCE AT APPLY TIME, not from the
-- plan snapshot: the live table grows hourly (7 new ADU rows appeared
-- between the plan census and the build-time re-count), so hardcoded
-- section totals would fail spuriously. The only fixed lists are the
-- 16 + 1 ids above, each guarded by a still-no-evidence assertion:
-- if one of them gained evidence since the census, the migration
-- fails loudly instead of deleting a real page.
--
-- Rows with no evidence that are NOT in the confirmed lists are left
-- alone (NULL section) with a NOTICE — a transient no-evidence row
-- (e.g. an import whose posting times land a second later) must never
-- fail this migration, because the migration auto-applies on merge
-- and a failed migration with the new contracts code deployed would
-- break the worker's destination-row parsing. Such rows are picked up
-- by the daily section check (Phase 3) and the Phase 4 straggler
-- backfill.
--
-- Tokens are never printed or logged. The token check below compares
-- byte-for-byte equality (IS NOT DISTINCT FROM, NULL-safe) between
-- each split copy and its original — no decryption anywhere.
--
-- The reverse migration lives at
-- supabase/migrations/reverse/20261112150000_destinations_section_label.sql
-- (never auto-applied; run manually with a code revert).

-- 1. The label column (nullable at first) + the four-value CHECK.
alter table public.destinations
  add column if not exists section text
    constraint destinations_section_check
    check (section in ('schedule', 'adu', 'mirror', 'publish_now'));

-- 2. Evidence snapshot: one row per destination, computed once so every
--    step and every assertion below reads the same world.
create temp table _dest_evidence_174 as
select
  d.id,
  (exists (select 1 from public.posting_slots ps where ps.destination_id = d.id)
    or exists (select 1 from public.queue_items qi where qi.destination_id = d.id)) as has_sched,
  exists (select 1 from public.adu_configs ac where ac.destination_id = d.id) as has_adu,
  exists (select 1 from public.mirrors m
           where m.workspace_id = d.workspace_id
             and m.target_platform = d.platform::text
             and m.target_external_id = d.external_destination_id) as has_mirror
from public.destinations d;

-- 3. Delete usage rows pointing at destinations that no longer exist.
--    subscription_usage.destination_id has no foreign key (hence the
--    orphans); the rows reference nothing and can never count again.
do $$
declare
  v_deleted integer;
begin
  delete from public.subscription_usage su
  where su.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = su.destination_id);
  get diagnostics v_deleted = row_count;
  raise notice 'spec 174 1A: deleted % orphaned subscription_usage rows', v_deleted;
end $$;

-- 4. Delete the 16 owner-confirmed no-evidence Facebook rows.
--    Exact list: evidence/census-no-evidence-2026-11-12.csv, re-counted
--    fresh at build time (identical set). Fail if any of them gained
--    evidence since the census — that row is a real page now. The
--    post-delete check is absence, not an exact count: on a fresh
--    database (CI rigs, new deploys) the rows never existed, so
--    deleting 0 is correct there; what must hold everywhere is that
--    none of the 16 remain afterwards.
do $$
declare
  v_bad integer;
  v_ids uuid[] := array[
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
    'e820b678-c35b-4bbd-8005-dcd050eb7b95'
  ]::uuid[];
begin
  select count(*) into v_bad
  from _dest_evidence_174 e
  where e.id = any (v_ids)
    and (e.has_sched or e.has_adu or e.has_mirror);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % of the 16 confirmed no-evidence rows gained evidence; re-count before applying', v_bad;
  end if;

  delete from public.destinations where id = any (v_ids);

  select count(*) into v_bad
  from public.destinations
  where id = any (v_ids);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % of the 16 confirmed no-evidence rows remain after delete', v_bad;
  end if;
end $$;

-- 5. Remove the 1 Instagram row (shahzeb.pxp) as a correction: it is an
--    account, not a page. The account row in social_accounts is untouched.
--    Same absence check as above: the row may never have existed.
do $$
declare
  v_bad integer;
  v_ig uuid := 'a6a8ac7c-a449-4f2c-a959-aefda650f2e1'::uuid;
begin
  select count(*) into v_bad
  from _dest_evidence_174 e
  where e.id = v_ig
    and (e.has_sched or e.has_adu or e.has_mirror);
  if v_bad > 0 then
    raise exception 'spec 174 1A: the shahzeb.pxp row gained section evidence; re-count before applying';
  end if;

  delete from public.destinations
  where id = v_ig
    and platform = 'instagram';

  if exists (select 1 from public.destinations where id = v_ig) then
    raise exception 'spec 174 1A: the shahzeb.pxp row remains after delete';
  end if;
end $$;

-- 6. Label every surviving row with its first section of evidence
--    (schedule -> adu -> mirror). Rows with no evidence stay NULL.
update public.destinations d
set section = case
  when e.has_sched then 'schedule'
  when e.has_adu then 'adu'
  when e.has_mirror then 'mirror'
  else null end
from _dest_evidence_174 e
where e.id = d.id;

-- 7. The old identity key blocks the split (one row per account+page),
--    so it goes before the copies are inserted.
alter table public.destinations
  drop constraint if exists uq_destinations_account_external;

-- 8. Split copies: one per section beyond the original's own.
--    ADU copy: has ADU evidence and the original kept 'schedule'.
--    Mirror copy: has mirror evidence and the original kept 'schedule'
--    or 'adu'. Provenance in metadata; token + followers byte-for-byte.
insert into public.destinations (
  workspace_id, account_id, platform, external_destination_id, name,
  handle, avatar_url, timezone, status, encrypted_destination_token,
  rate_usage_pct, metadata, refresh_lease_owner, refresh_lease_expires_at,
  created_at, updated_at, section
)
select
  d.workspace_id, d.account_id, d.platform, d.external_destination_id, d.name,
  d.handle, d.avatar_url, d.timezone, d.status, d.encrypted_destination_token,
  d.rate_usage_pct,
  d.metadata || jsonb_build_object('split_from_destination_id', d.id::text),
  d.refresh_lease_owner, d.refresh_lease_expires_at,
  d.created_at, d.updated_at, 'adu'
from public.destinations d
join _dest_evidence_174 e on e.id = d.id
where e.has_adu and e.has_sched;

insert into public.destinations (
  workspace_id, account_id, platform, external_destination_id, name,
  handle, avatar_url, timezone, status, encrypted_destination_token,
  rate_usage_pct, metadata, refresh_lease_owner, refresh_lease_expires_at,
  created_at, updated_at, section
)
select
  d.workspace_id, d.account_id, d.platform, d.external_destination_id, d.name,
  d.handle, d.avatar_url, d.timezone, d.status, d.encrypted_destination_token,
  d.rate_usage_pct,
  d.metadata || jsonb_build_object('split_from_destination_id', d.id::text),
  d.refresh_lease_owner, d.refresh_lease_expires_at,
  d.created_at, d.updated_at, 'mirror'
from public.destinations d
join _dest_evidence_174 e on e.id = d.id
where e.has_mirror and (e.has_sched or e.has_adu);

-- 9. Re-point children to their section's row.
--    Auto Download configs move to the Auto Download copy (the original
--    kept 'schedule' wherever a config and a schedule both exist).
update public.adu_configs ac
set destination_id = c.id
from public.destinations c
where c.section = 'adu'
  and (c.metadata ->> 'split_from_destination_id')::uuid = ac.destination_id;

--    Usage rows move by feature. destination-queue rows stay: the
--    Schedule row is the original, so they already point at it.
update public.subscription_usage su
set destination_id = c.id
from public.destinations c
where c.section = 'adu'
  and su.feature = 'auto-download-upload'
  and (c.metadata ->> 'split_from_destination_id')::uuid = su.destination_id;

update public.subscription_usage su
set destination_id = c.id
from public.destinations c
where c.section = 'mirror'
  and su.feature = 'tiktok-mirror'
  and (c.metadata ->> 'split_from_destination_id')::uuid = su.destination_id;

-- 10. The new identity key (section is part of the row's identity) and
--     the list-query index.
create unique index uq_destinations_account_external_section
  on public.destinations (account_id, external_destination_id, section);

create index if not exists idx_destinations_workspace_section_platform
  on public.destinations (workspace_id, section, platform);

-- 11. Assertions — the migration fails loudly if any fails. Expected
--     section counts are computed from the live evidence snapshot, so
--     rows added since the census cannot fail the migration.
do $$
declare
  v_sched integer;
  v_adu integer;
  v_mirror integer;
  v_bad integer;
  v_nulls integer;
begin
  select count(*) into v_sched from _dest_evidence_174 where has_sched;
  select count(*) into v_adu from _dest_evidence_174 where has_adu;
  select count(*) into v_mirror from _dest_evidence_174 where has_mirror;

  -- Section counts match the live evidence.
  select count(*) into v_bad from public.destinations where section = 'schedule';
  if v_bad <> v_sched then
    raise exception 'spec 174 1A: schedule rows % <> evidence %', v_bad, v_sched;
  end if;
  select count(*) into v_bad from public.destinations where section = 'adu';
  if v_bad <> v_adu then
    raise exception 'spec 174 1A: adu rows % <> evidence %', v_bad, v_adu;
  end if;
  select count(*) into v_bad from public.destinations where section = 'mirror';
  if v_bad <> v_mirror then
    raise exception 'spec 174 1A: mirror rows % <> evidence %', v_bad, v_mirror;
  end if;
  select count(*) into v_bad from public.destinations where section = 'publish_now';
  if v_bad <> 0 then
    raise exception 'spec 174 1A: publish_now rows % (expected 0)', v_bad;
  end if;

  -- No NULL sections among rows that had evidence; any NULL left is a
  -- no-evidence row (see the header note) — report it, do not fail.
  select count(*) into v_bad
  from public.destinations d
  join _dest_evidence_174 e on e.id = d.id
  where d.section is null and (e.has_sched or e.has_adu or e.has_mirror);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % rows with evidence left without a section', v_bad;
  end if;
  select count(*) into v_nulls from public.destinations where section is null;
  if v_nulls > 0 then
    raise notice 'spec 174 1A: % rows left with NULL section (no evidence; straggler backfill in Phase 4)', v_nulls;
  end if;

  -- Every split copy's token is byte-for-byte the original's
  -- (NULL-safe comparison; no decryption, nothing printed).
  select count(*) into v_bad
  from public.destinations c
  join public.destinations o
    on o.id = (c.metadata ->> 'split_from_destination_id')::uuid
  where c.encrypted_destination_token is distinct from o.encrypted_destination_token;
  if v_bad > 0 then
    raise exception 'spec 174 1A: % split copies carry a token differing from their original', v_bad;
  end if;

  -- Provenance on every copy points at a live original row.
  select count(*) into v_bad
  from public.destinations c
  where c.metadata ? 'split_from_destination_id'
    and not exists (select 1 from public.destinations o
                     where o.id = (c.metadata ->> 'split_from_destination_id')::uuid);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % split copies point at a missing original', v_bad;
  end if;

  -- Zero orphan children.
  select count(*) into v_bad from public.posting_slots ps
  where ps.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = ps.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % posting_slots orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.queue_items qi
  where qi.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = qi.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % queue_items orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.publish_logs pl
  where pl.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = pl.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % publish_logs orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.posting_slot_claims sc
  where sc.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = sc.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % posting_slot_claims orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.adu_configs ac
  where ac.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = ac.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % adu_configs orphaned', v_bad;
  end if;

  -- Zero usage rows pointing at a deleted destination.
  select count(*) into v_bad from public.subscription_usage su
  where su.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = su.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 1A: % subscription_usage rows still point at deleted destinations', v_bad;
  end if;

  -- Every live usage row's destination carries its feature's section.
  select count(*) into v_bad
  from public.subscription_usage su
  join public.destinations d on d.id = su.destination_id
  where (su.feature = 'auto-download-upload' and d.section <> 'adu')
     or (su.feature = 'destination-queue' and d.section <> 'schedule')
     or (su.feature = 'tiktok-mirror' and d.section <> 'mirror');
  if v_bad > 0 then
    raise exception 'spec 174 1A: % usage rows point at a destination of the wrong section', v_bad;
  end if;

  raise notice 'spec 174 1A: backfill OK (schedule=%, adu=%, mirror=%)', v_sched, v_adu, v_mirror;
end $$;

drop table _dest_evidence_174;
