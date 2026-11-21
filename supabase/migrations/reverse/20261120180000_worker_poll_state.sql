-- Reverse migration for 20261120180000_worker_poll_state.sql (spec 212).
-- Drops the poll-gate state table. The worker treats a missing table as
-- "no state": it runs the full tick every minute (fail-open), so
-- rolling back the table never stalls publishing.
DROP TABLE IF EXISTS public.worker_poll_state;
