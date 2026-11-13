-- Spec 174 PR 4A part 2 (lock) — straggler backfill + section SET NOT NULL.
--
-- The lock: after this migration every destinations row carries a section.
-- 'News Expers 99', the last NULL-section row, was deleted 2026-11-13 on
-- the owner's tap ('Delete it'), so the backfill below is a no-op
-- safeguard for any row created without a section between now and apply
-- time. The flag-read removal half of 4A ships separately (PR #245).
--
-- Census recorded at build time (fresh re-count 2026-11-13 ~16:51 PKT,
-- live prod): 870 destinations — adu 681, mirror 36, schedule 153,
-- NULL 0, all Facebook; migration ledger 113 applied, max
-- 20261113140000. The counts are NOT hardcoded as assertions: live
-- imports arrive daily (the census drifted 863 -> 870 in two days), so
-- a hard equality would fail spuriously at apply time — the same reason
-- 1A computed its counts from live evidence. Instead the migration
-- asserts drift-proof internal consistency (step 4), and the census
-- comparison itself is Gate 4A's live re-count after merge. A floor
-- assertion (counts >= build-time counts) was deliberately NOT added:
-- it would false-fail on a legitimate owner-authorized deletion, as
-- 'News Expers 99' proved the day before this migration was written.
--
-- Backfill rules (spec §5 rule 1, single evidence -> that section):
--   * one section of evidence -> labelled in place;
--   * several sections of evidence -> FAIL LOUD (that row needs a split,
--     not a label; splitting re-points children and is out of this PR);
--   * no evidence -> FAIL LOUD (no truthful label exists; the §5.3
--     delete authorization covered only the 16 listed rows, never a new
--     one — a human decides: delete it or name its section).
--
-- No token is printed, logged, or decrypted anywhere in this migration.
--
-- The reverse migration lives at
-- supabase/migrations/reverse/20261113160000_destinations_section_not_null.sql
-- (never auto-applied; run manually with a code revert).

-- 1. Evidence snapshot: one row per destination, computed once so the
--    backfill and every assertion below read the same world (same shape
--    as 1A's _dest_evidence_174).
create temp table _dest_evidence_174_lock as
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

-- 2. Straggler backfill: label single-evidence NULL rows in place.
--    Anything else fails loudly — see the header.
do $$
declare
  v_bad integer;
  v_labelled integer;
begin
  select count(*) into v_bad
  from public.destinations d
  join _dest_evidence_174_lock e on e.id = d.id
  where d.section is null
    and ((e.has_sched)::int + (e.has_adu)::int + (e.has_mirror)::int) > 1;
  if v_bad > 0 then
    raise exception 'spec 174 4A: % NULL-section rows have multi-section evidence; they need a split, not a label — re-count before applying', v_bad;
  end if;

  select count(*) into v_bad
  from public.destinations d
  join _dest_evidence_174_lock e on e.id = d.id
  where d.section is null
    and not (e.has_sched or e.has_adu or e.has_mirror);
  if v_bad > 0 then
    raise exception 'spec 174 4A: % NULL-section rows have no evidence; no truthful label exists — delete them or name their section by owner decision, then re-apply', v_bad;
  end if;

  update public.destinations d
  set section = case
    when e.has_sched then 'schedule'
    when e.has_adu then 'adu'
    when e.has_mirror then 'mirror'
    else null end
  from _dest_evidence_174_lock e
  where e.id = d.id
    and d.section is null;
  get diagnostics v_labelled = row_count;
  raise notice 'spec 174 4A: labelled % straggler rows', v_labelled;
end $$;

-- 3. The lock.
alter table public.destinations
  alter column section set not null;

-- 4. Assertions — the migration fails loudly if any fails. Every expected
--    value is computed from the live evidence snapshot above, so rows
--    added since the build-time census cannot fail the migration.
do $$
declare
  v_sched integer;
  v_adu integer;
  v_mirror integer;
  v_publish_now integer;
  v_bad integer;
begin
  -- Zero NULL sections.
  select count(*) into v_bad from public.destinations where section is null;
  if v_bad > 0 then
    raise exception 'spec 174 4A: % rows left with NULL section', v_bad;
  end if;

  -- Single-evidence rows carry their evidence's section.
  select count(*) into v_bad
  from _dest_evidence_174_lock e
  join public.destinations d on d.id = e.id
  where (e.has_sched and not e.has_adu and not e.has_mirror and d.section <> 'schedule')
     or (e.has_adu and not e.has_sched and not e.has_mirror and d.section <> 'adu')
     or (e.has_mirror and not e.has_sched and not e.has_adu and d.section <> 'mirror');
  if v_bad > 0 then
    raise exception 'spec 174 4A: % single-evidence rows carry the wrong section', v_bad;
  end if;

  -- Zero orphan children.
  select count(*) into v_bad from public.posting_slots ps
  where ps.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = ps.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 4A: % posting_slots orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.queue_items qi
  where qi.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = qi.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 4A: % queue_items orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.publish_logs pl
  where pl.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = pl.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 4A: % publish_logs orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.posting_slot_claims sc
  where sc.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = sc.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 4A: % posting_slot_claims orphaned', v_bad;
  end if;
  select count(*) into v_bad from public.adu_configs ac
  where ac.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = ac.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 4A: % adu_configs orphaned', v_bad;
  end if;

  -- Zero usage rows pointing at a deleted destination.
  select count(*) into v_bad from public.subscription_usage su
  where su.destination_id is not null
    and not exists (select 1 from public.destinations d where d.id = su.destination_id);
  if v_bad > 0 then
    raise exception 'spec 174 4A: % subscription_usage rows still point at deleted destinations', v_bad;
  end if;

  -- Every live usage row's destination carries its feature's section.
  select count(*) into v_bad
  from public.subscription_usage su
  join public.destinations d on d.id = su.destination_id
  where (su.feature = 'auto-download-upload' and d.section <> 'adu')
     or (su.feature = 'destination-queue' and d.section <> 'schedule')
     or (su.feature = 'tiktok-mirror' and d.section <> 'mirror');
  if v_bad > 0 then
    raise exception 'spec 174 4A: % usage rows point at a destination of the wrong section', v_bad;
  end if;

  select count(*) into v_sched from public.destinations where section = 'schedule';
  select count(*) into v_adu from public.destinations where section = 'adu';
  select count(*) into v_mirror from public.destinations where section = 'mirror';
  select count(*) into v_publish_now from public.destinations where section = 'publish_now';
  raise notice 'spec 174 4A: lock OK (schedule=%, adu=%, mirror=%, publish_now=%)', v_sched, v_adu, v_mirror, v_publish_now;
end $$;

drop table _dest_evidence_174_lock;
