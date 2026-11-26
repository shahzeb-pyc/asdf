-- Downgrade check index (spec 232, DB optimisation plan item 8).
--
-- The worker's downgrade tick (apps/worker/src/downgrade-tick.ts)
-- runs one global scan per minute for scheduled downgrades:
--   status = 'approved' AND period_id IS NULL
--   AND is_downgrade AND scheduled_starts_at <= now()
--   ORDER BY scheduled_starts_at ASC LIMIT 100
-- The existing index idx_subscription_payments_status_created is on
-- (status, created_at): it serves the status equality but not the
-- ORDER BY scheduled_starts_at, so the scan still sorts. This index
-- puts the due date third, so the scan reads due downgrades in
-- order with no sort step.
--
-- Index-only: no code changes, no grants change. Conditional item:
-- the index ships only because the rig test proves the scan uses
-- it (see supabase/migrations/tests/downgrade-check-index-migration.test.sh);
-- if the planner had ignored it, the item would have been dropped.
create index if not exists idx_subscription_payments_status_downgrade_starts
  on public.subscription_payments (status, is_downgrade, scheduled_starts_at);
