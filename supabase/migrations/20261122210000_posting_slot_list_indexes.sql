-- Posting-slot list indexes (spec 231, plan item 7).
--
-- Listing the active Facebook posting slots
-- (`list_active_facebook_posting_slots`, from
-- 20261027130000_publisher_driven_posting_times.sql) filters pages by
-- platform ('facebook') and status ('active'), then joins their
-- posting slots on destination_id where the slot is active. No index
-- on destinations led with platform and status (the existing ones
-- lead with workspace or account, which this routine never filters
-- on), and posting_slots had only a destination_id index, not one
-- that also covers is_active.
--
-- Index-only: the routine is not redefined, no grants change.
create index if not exists idx_destinations_platform_status
  on public.destinations (platform, status);

create index if not exists idx_posting_slots_destination_active
  on public.posting_slots (destination_id, is_active);
