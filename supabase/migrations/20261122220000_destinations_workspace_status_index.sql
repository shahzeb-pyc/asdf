-- Page-status lookup index (spec 233, DB optimisation plan item 9).
--
-- The entitlement check (`apps/web/src/lib/billing/entitlement.ts`)
-- lists disconnected pages per workspace with
--   workspace_id IN (...) AND status = 'disconnected'
-- but the only workspace index is `idx_destinations_workspace_id`
-- on (workspace_id) alone, so the status is filtered by hand
-- afterwards. The new index (workspace_id, status) serves the
-- equality pair directly.
--
-- Index-only: no code changes, no grants change. The related
-- metadata query (pages filtered by a `metadata` field) is NOT
-- served by this index and is out of scope (an expression index on
-- metadata was excluded in the plan as not worth it).
create index if not exists idx_destinations_workspace_status
  on public.destinations (workspace_id, status);
