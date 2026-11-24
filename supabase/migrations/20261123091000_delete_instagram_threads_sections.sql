-- Spec 237 — delete the Instagram and Threads feature sections completely.
--
-- Owner order 2026-11-23: "For Instagram and threads remove all sections
-- except accounts" / "delete them completely" / existing content "remove
-- and stop". Accounts stay (social_accounts + platform_credentials are
-- NEVER touched by this migration), Facebook rows stay, media stays.
--
-- What this deletes (live-prod inventory 2026-11-23 ~14:10 PKT, newdb
-- chbtrophjeavksryvglv — counts are a SNAPSHOT, not a precondition; the
-- migration deletes whatever IG/Threads rows exist, 0 on a fresh DB):
--   destinations            platform instagram/threads ......... 0 rows
--   adu_configs             via destination (CASCADE) .......... 0 rows
--   adu_reels               via config (CASCADE) ............... 0 rows
--   adu_posting_jobs        via config (CASCADE) ............... 0 rows
--   mirrors                 target_platform instagram/threads .. 0 rows
--   mirror_posts            via mirror (CASCADE) ............... 0 rows
--   mirror_check_jobs       via mirror (CASCADE) ............... 0 rows
--   posting_slots           via destination (CASCADE) .......... 0 rows
--   posting_slot_claims     via destination (CASCADE) .......... 0 rows
--   queue_items             platform column (direct delete) .... 0 rows
--   publish_logs            via destination (CASCADE) .......... 0 rows
--   subscription_usage      platform instagram/threads ......... 0 rows
--   destination_claim_limits platform instagram/threads ........ 3 rows
--     (instagram calls 1, instagram published 1, threads published 1;
--      the x published 1 row stays)
-- Only destination_claim_limits holds rows in production: three global
-- rate-limit configs for sections that no longer exist. Everything
-- else is already empty — the deletes below still run so a row created
-- between the inventory and this migration is removed, not left behind.
--
-- Code-side, the same PR deletes the IG/Threads section routes, the
-- sidebar leaves, the section components, the IG/Threads publishers
-- (registry-driven claiming stops), and the IG mirror arms, so no code
-- path can recreate any of these rows after this migration lands.
-- The platform enum itself is NOT touched: social_accounts,
-- platform_credentials, subscription_usage's CHECK and the billing
-- fixtures still use instagram/threads for Accounts.
--
-- IRREVERSIBLE: the rows carry encrypted tokens and follower baselines
-- that cannot be faithfully reconstructed. No down-migration and no
-- reverse/ file. A fresh pg_dump of production was taken before this
-- migration was merged (see the PR description).
--
-- The subscription_usage delete is explicit, not a cascade: that
-- table's destination_id carries NO foreign key (migration
-- 20261030120003), so deleting the destination would orphan its rows.

do $$
declare
  v_deleted integer;
  v_remaining integer;
  v_orphans integer;
begin
  -- 1. Queue items by their own platform column. This covers orphaned
  -- rows (destination already gone) as well as linked rows; linked
  -- rows would cascade from step 4 anyway.
  delete from public.queue_items
  where platform in ('instagram', 'threads');
  get diagnostics v_deleted = row_count;
  raise notice 'spec-237: deleted % queue_items (platform instagram/threads)', v_deleted;

  -- 2. Historical usage ledger for the deleted sections (no FK: the
  -- delete must be explicit, or the rows orphan on destination_id).
  delete from public.subscription_usage
  where platform in ('instagram', 'threads');
  get diagnostics v_deleted = row_count;
  raise notice 'spec-237: deleted % subscription_usage rows (platform instagram/threads)', v_deleted;

  -- 3. Mirrors targeting (or sourcing from) Instagram/Threads.
  -- Cascades to mirror_posts + mirror_check_jobs.
  delete from public.mirrors
  where target_platform in ('instagram', 'threads')
     or source_platform in ('instagram', 'threads');
  get diagnostics v_deleted = row_count;
  raise notice 'spec-237: deleted % mirrors (platform instagram/threads)', v_deleted;

  -- 4. Destinations for Instagram/Threads. Cascades to adu_configs
  -- (then adu_reels, adu_posting_jobs), posting_slots,
  -- posting_slot_claims and publish_logs. Facebook destinations are
  -- untouched: the predicate is platform, never section.
  delete from public.destinations
  where platform in ('instagram', 'threads');
  get diagnostics v_deleted = row_count;
  raise notice 'spec-237: deleted % destinations (platform instagram/threads)', v_deleted;

  -- 5. Global claim-limit configs for the deleted sections.
  delete from public.destination_claim_limits
  where platform in ('instagram', 'threads');
  get diagnostics v_deleted = row_count;
  raise notice 'spec-237: deleted % destination_claim_limits (platform instagram/threads)', v_deleted;

  -- 6. Assert zero remain in every directly-addressable table.
  select count(*) into v_remaining from public.destinations
  where platform in ('instagram', 'threads');
  if v_remaining <> 0 then
    raise exception 'spec-237: % instagram/threads destinations remain after delete', v_remaining;
  end if;

  select count(*) into v_remaining from public.mirrors
  where target_platform in ('instagram', 'threads')
     or source_platform in ('instagram', 'threads');
  if v_remaining <> 0 then
    raise exception 'spec-237: % instagram/threads mirrors remain after delete', v_remaining;
  end if;

  select count(*) into v_remaining from public.queue_items
  where platform in ('instagram', 'threads');
  if v_remaining <> 0 then
    raise exception 'spec-237: % instagram/threads queue_items remain after delete', v_remaining;
  end if;

  select count(*) into v_remaining from public.subscription_usage
  where platform in ('instagram', 'threads');
  if v_remaining <> 0 then
    raise exception 'spec-237: % instagram/threads subscription_usage rows remain after delete', v_remaining;
  end if;

  select count(*) into v_remaining from public.destination_claim_limits
  where platform in ('instagram', 'threads');
  if v_remaining <> 0 then
    raise exception 'spec-237: % instagram/threads destination_claim_limits remain after delete', v_remaining;
  end if;

  -- 7. Assert the cascades left no orphans behind.
  select count(*) into v_orphans from public.adu_configs c
  where not exists (select 1 from public.destinations d where d.id = c.destination_id);
  if v_orphans <> 0 then
    raise exception 'spec-237: % orphaned adu_configs after delete', v_orphans;
  end if;

  select count(*) into v_orphans from public.posting_slots s
  where not exists (select 1 from public.destinations d where d.id = s.destination_id);
  if v_orphans <> 0 then
    raise exception 'spec-237: % orphaned posting_slots after delete', v_orphans;
  end if;

  select count(*) into v_orphans from public.posting_slot_claims c
  where not exists (select 1 from public.destinations d where d.id = c.destination_id);
  if v_orphans <> 0 then
    raise exception 'spec-237: % orphaned posting_slot_claims after delete', v_orphans;
  end if;

  select count(*) into v_orphans from public.publish_logs l
  where not exists (select 1 from public.destinations d where d.id = l.destination_id);
  if v_orphans <> 0 then
    raise exception 'spec-237: % orphaned publish_logs after delete', v_orphans;
  end if;

  select count(*) into v_orphans from public.mirror_posts p
  where not exists (select 1 from public.mirrors m where m.id = p.mirror_id);
  if v_orphans <> 0 then
    raise exception 'spec-237: % orphaned mirror_posts after delete', v_orphans;
  end if;

  select count(*) into v_orphans from public.mirror_check_jobs j
  where not exists (select 1 from public.mirrors m where m.id = j.mirror_id);
  if v_orphans <> 0 then
    raise exception 'spec-237: % orphaned mirror_check_jobs after delete', v_orphans;
  end if;
end $$;
