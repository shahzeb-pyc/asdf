-- Spec 180 — Publish Now no-DB-save: delete the publish_now destination rows
-- and tighten the destinations section CHECK to the three live sections.
--
-- Owner decision 2026-11-13: Publish Now persists nothing. The import route
-- (spec 174 PR 1B) was the sole writer of section = 'publish_now' rows; it is
-- deleted in the same PR, so no code path can recreate them. The live gate
-- (2026-11-13, new production) confirmed 67 publish_now rows, all Facebook,
-- all active, created 2026-11-13 18:27-19:02 PKT, with zero child rows on
-- those ids (queue_items, posting_slots, posting_slot_claims, adu_configs,
-- publish_logs, subscription_usage). The migration deletes ALL publish_now
-- rows, whatever the count: 67 on production, 0 on a fresh database — the
-- count is a snapshot, not a precondition (a count assertion would fail
-- every non-production database; fixed after the SQL Rigs failure on
-- PR #252, which applies migrations to a fresh DB).
--
-- IRREVERSIBLE: the rows carry encrypted page tokens and follower baselines
-- (metadata starting_followers / current_followers) that cannot be
-- faithfully reconstructed. No down-migration and no reverse/ file.
--
-- The subscription_usage CHECK is intentionally NOT touched: historical
-- usage rows keep section 'publish_now' (migration 20261113050000).

do $$
declare
  v_children integer;
  v_remaining integer;
begin
  -- 1. No child rows may exist on publish_now destinations. Deleting a
  -- destination cascades to queue_items / posting_slots /
  -- posting_slot_claims / adu_configs / publish_logs, so a non-zero
  -- count here must fail the migration instead of silently dropping
  -- a user's queued post or config.
  select count(*) into v_children
  from public.destinations d
  where d.section = 'publish_now'
    and (
      exists (select 1 from public.queue_items qi where qi.destination_id = d.id)
      or exists (select 1 from public.posting_slots ps where ps.destination_id = d.id)
      or exists (select 1 from public.posting_slot_claims c where c.destination_id = d.id)
      or exists (select 1 from public.adu_configs a where a.destination_id = d.id)
      or exists (select 1 from public.publish_logs pl where pl.destination_id = d.id)
      or exists (select 1 from public.subscription_usage su where su.destination_id = d.id)
    );
  if v_children <> 0 then
    raise exception 'spec-180: % publish_now destination(s) still have child rows; refusing to delete', v_children;
  end if;

  -- 2. Delete every publish_now row, whatever the count (67 on
  -- production per the gate, 0 on a fresh database). The platform
  -- belt must not change the production count (all 67 are Facebook,
  -- verified by the gate).
  delete from public.destinations
  where section = 'publish_now'
    and platform = 'facebook';

  -- 3. Assert zero remain.
  select count(*) into v_remaining
  from public.destinations
  where section = 'publish_now';
  if v_remaining <> 0 then
    raise exception 'spec-180: % publish_now destinations remain after delete', v_remaining;
  end if;

  -- 4. Tighten the live CHECK to the three live sections (the DB twin
  -- of DestinationSectionSchema after spec 180). Safe only after
  -- step 3: no row can violate the new CHECK.
  alter table public.destinations drop constraint destinations_section_check;
  alter table public.destinations
    add constraint destinations_section_check
    check (section in ('schedule', 'adu', 'mirror'));
end $$;
