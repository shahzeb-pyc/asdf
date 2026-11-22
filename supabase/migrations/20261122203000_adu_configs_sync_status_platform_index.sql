-- Source pickup index (spec 230, DB optimisation plan item 6).
--
-- The scraper asks for the next source to sync 36,080 times over four
-- days (2.4% of all database time) via `get_next_pending_adu_config`,
-- plus 14,602 times for the browser-pending variant
-- (`get_next_browser_pending_adu_config`, 20261030130000). Each call
-- picks one source whose sync_status is 'pending' (or
-- 'browser_pending'), optionally filtered by source_platform — and
-- no index leads with sync_status, so every call scans the sources
-- table. The existing adu_configs indexes all lead with
-- workspace_id or destination_id, which these calls never filter
-- on.
--
-- Index-only: neither pickup routine is redefined, no grants
-- change, and no ORDER BY is added — the pick stays deliberately
-- unspecified (the routine promises no order), so which pending
-- source is picked first may change once the index exists.
create index if not exists idx_adu_configs_sync_status_platform
  on public.adu_configs (sync_status, source_platform);
