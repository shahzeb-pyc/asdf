-- Claim index for the first-pending lookup (spec 223).
--
-- The downloader's claim RPCs (`claim_tiktok_buffer_downloads` and
-- `claim_non_tiktok_buffer_downloads`, from
-- 20261117183523_adu_discovery_rank.sql) pick one pending reel per
-- active config with
--   ORDER BY created_at DESC, discovery_rank ASC NULLS LAST, id ASC
-- but the existing index `idx_adu_reels_config_status_rank` is on
-- (config_id, status, discovery_rank): it serves the config_id +
-- status equality but not the ORDER BY created_at DESC, so the
-- lookup scans. With ~700 TikTok configs and a ~389k-row table,
-- each claim call runs that lookup per hungry config.
--
-- Index-only: neither claim RPC is redefined, no grants change.
-- The per-call buffer recount in the RPCs' `page_buffer` CTE is
-- left untouched (a cached count would be a semantic change, not
-- a cheap win) — follow-up, not this migration.
create index if not exists idx_adu_reels_config_status_created_at
  on public.adu_reels (config_id, status, created_at);
