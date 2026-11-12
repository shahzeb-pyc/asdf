-- REVERSE migration for 20261112150000_destinations_section_label.sql
-- (spec 174 PR 1A).
--
-- THIS FILE IS NEVER AUTO-APPLIED. The Supabase migration runner only
-- reads top-level *.sql files in supabase/migrations/; this file lives
-- in the reverse/ subdirectory precisely so it is not picked up. Run it
-- manually (psql, as postgres) together with a code revert of PR 1A —
-- code rollback alone after 1A is NOT sufficient, because old code's
-- single-row reads (maybeSingle, first-active-wins) break on split rows.
--
-- What it does:
--   1. Re-points children back to the original rows (Auto Download
--      configs and usage rows move off the split copies). This MUST run
--      before the copies are deleted: the child foreign keys are
--      ON DELETE CASCADE, so deleting a copy first would delete its
--      config instead of moving it.
--   2. Deletes the split copies (identified by
--      metadata.split_from_destination_id).
--   3. Drops the new unique index + the section index, restores the old
--      unique key (account_id, external_destination_id), drops the
--      section column.
--
-- What it does NOT restore (by owner decision, these stand):
--   * the 16 deleted no-evidence Facebook rows;
--   * the 1 removed Instagram row (shahzeb.pxp);
--   * the orphaned subscription_usage rows deleted by the forward
--     migration (they referenced destinations that no longer existed).
-- After apply + reverse, the destinations count equals the
-- pre-migration count MINUS those 17 rows.
--
-- If rows were created after 1A that would violate the old unique key
-- (a second row for the same account+page — e.g. a row created by 1B
-- code, or a NULL-section row for an existing page), restoring the old
-- unique index fails loudly with a duplicate-key error. That is a
-- manual-rollback situation: resolve the conflicting rows first.

-- 1. Re-point children back to the originals.
update public.adu_configs ac
set destination_id = (c.metadata ->> 'split_from_destination_id')::uuid
from public.destinations c
where c.id = ac.destination_id
  and c.metadata ? 'split_from_destination_id';

update public.subscription_usage su
set destination_id = (c.metadata ->> 'split_from_destination_id')::uuid
from public.destinations c
where c.id = su.destination_id
  and c.metadata ? 'split_from_destination_id';

-- 2. Delete the split copies.
delete from public.destinations
where metadata ? 'split_from_destination_id';

-- 3. Drop the new key + index, restore the old key, drop the column.
drop index if exists public.uq_destinations_account_external_section;
drop index if exists public.idx_destinations_workspace_section_platform;

alter table public.destinations
  drop column if exists section;

-- The old key must be unique again at this point; if a duplicate
-- (account_id, external_destination_id) exists (rows created after 1A),
-- this fails loudly instead of silently leaving the table unprotected.
alter table public.destinations
  add constraint uq_destinations_account_external
  unique (account_id, external_destination_id);
