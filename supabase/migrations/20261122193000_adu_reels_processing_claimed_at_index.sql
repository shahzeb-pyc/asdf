-- Stale-download reset index (spec 228, DB optimisation plan item 4).
--
-- `reset_stale_adu_reel_downloads` (from 20261030130000_adu_claim_rpc.sql)
-- runs ~19,442 times over four days (7.1% of all database time) and finds
-- downloads claimed more than 40 minutes ago and still stuck:
--   WHERE status = 'processing'
--     AND download_claimed_at IS NOT NULL
--     AND download_claimed_at < now() - make_interval(mins => p_stale_minutes)
--     AND download_retries < 3
-- No existing index serves that filter: every adu_reels index leads with
-- config_id, which this query never filters on, so every call scans.
--
-- Partial index, as the plan specifies: the stuck set is small (only
-- rows currently being downloaded), so the index stays tiny and cheap
-- to maintain.
--
-- Index-only: the reset routine is NOT redefined, the 40-minute
-- window and the retry guard are untouched.
create index if not exists idx_adu_reels_processing_claimed_at
  on public.adu_reels (download_claimed_at)
  where status = 'processing';
