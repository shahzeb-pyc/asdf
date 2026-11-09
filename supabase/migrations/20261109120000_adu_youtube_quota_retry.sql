-- ADU YouTube quota auto-retry (spec 156).
--
-- A YouTube quota error parks the source in sync_status 'quota_parked'
-- until the next midnight Pacific Time (quota_retry_at), when the
-- scraper daemon re-queues it as 'pending'. Anything else keeps
-- 'error'. Additive only: one nullable column plus one value in the
-- existing sync_status CHECK (dropped and re-added by its
-- auto-generated name — the only CHECK on the column). No backfill, no
-- SECURITY DEFINER function, no new table.
--
-- Unapplied in the branch. The Supabase GitHub integration
-- auto-applies it on merge to main; after merging, verify the ledger
-- row for 20261109120000 and the column before redeploying the VPS
-- scraper.

alter table public.adu_configs
  add column if not exists quota_retry_at timestamptz;

alter table public.adu_configs
  drop constraint if exists adu_configs_sync_status_check;

alter table public.adu_configs
  add constraint adu_configs_sync_status_check
  check (sync_status in ('pending', 'browser_pending', 'processing', 'synced', 'error', 'quota_parked'));
