-- ADU optimization (Stream A, F9/F10) — status-filtered hub indexes
-- on adu_configs.
--
-- The hub list/stats RPCs (adu_hub_list / adu_hub_stats, Facebook and
-- Threads clones) filter by (workspace_id, status) and sort by either
-- created_at DESC (Newest First, the default) or current_followers
-- (Most/Least Followers). The only workspace-scoped index that
-- existed was (workspace_id, created_at DESC)
-- (idx_adu_configs_workspace_created, 20261030120001_adu.sql), so a
-- status-filtered load scanned the whole workspace's configs and
-- filtered, and a followers sort sorted on every load.
--
-- These two indexes make both shapes index-range scans:
--   (workspace_id, status, created_at DESC) — status-filtered lists
--     and stats, in the default sort order;
--   (workspace_id, status, current_followers DESC) — the followers
--     sorts under a status filter.
-- Unfiltered loads (status 'All Statuses' passes NULL, so the RPC
-- skips the status predicate) keep using the existing
-- (workspace_id, created_at DESC) index for the default sort.
--
-- Safety: plain CREATE INDEX (no CONCURRENTLY — migrations run in a
-- transaction), IF NOT EXISTS so a re-apply is a no-op. No SECURITY
-- DEFINER, no function or RLS change, no destinations index
-- (split-sensitive, out of scope for this stream).
CREATE INDEX IF NOT EXISTS idx_adu_configs_workspace_status_created
  ON public.adu_configs (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adu_configs_workspace_status_followers
  ON public.adu_configs (workspace_id, status, current_followers DESC);
