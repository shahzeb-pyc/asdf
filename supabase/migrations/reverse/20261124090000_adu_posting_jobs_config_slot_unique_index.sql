-- Reverse migration for 20261124090000_adu_posting_jobs_config_slot_unique_index.sql (spec 245).
-- Drops the (config_id, schedule_slot_at) unique index. Rolling back
-- re-opens the double-mint hole: two ticks covering the same slot can
-- insert twice, and the 23505 branch stops firing — rolling back is a
-- deliberate stop, not a degraded mode.
DROP INDEX IF EXISTS public.idx_adu_jobs_config_slot_unique;
