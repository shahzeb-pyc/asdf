-- Reverse migration for 20261125180600_mirror_consecutive_failure_count.sql (spec 254).
-- Drops the consecutive-failure counter and signature columns.
--
-- Rolling back loses any in-flight failure streaks (they rebuild
-- from future failures — the tick re-counts from 0). Roll back the
-- worker build that writes these columns FIRST: the tick selects
-- them explicitly and fails loudly on a missing column, so running
-- the new worker against a rolled-back database breaks every
-- mirror check instead of degrading quietly.
ALTER TABLE public.mirrors
  DROP CONSTRAINT IF EXISTS mirrors_consecutive_failure_count_nonnegative;
ALTER TABLE public.mirrors DROP COLUMN IF EXISTS last_failure_signature;
ALTER TABLE public.mirrors DROP COLUMN IF EXISTS consecutive_failure_count;
