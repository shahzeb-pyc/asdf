-- Reverse migration for 20261124010000_insights_runs.sql (spec 240).
-- Drops the insights run tables. Chunks go first (foreign key to
-- the header); the header drop cascades anything left. A missing
-- run table makes the manual endpoint and the insights cron fail
-- loudly (500/503), never silently — rolling back is a deliberate
-- stop, not a degraded mode.
DROP TABLE IF EXISTS public.insights_run_chunks;
DROP TABLE IF EXISTS public.insights_runs;
