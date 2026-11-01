-- Billing audit fix 2026-11-01 (fix 14b): approval-race backstop.
--
-- UNAPPLIED: apply manually on the owner's tap, like every migration.
--
-- The app-level serialisation in approvePayment (claim-first
-- conditional pending -> approved, conditional period link with
-- orphan supersede) is the primary guard; this partial unique
-- index is the database backstop: at most one non-superseded
-- period per user can exist, so even a race the app guard missed
-- cannot leave two live periods linked to two approvals.
--
-- It depends on the new supersede-all behaviour in
-- createPeriodForPurchase (it supersedes EVERY non-superseded
-- period, not just still-active ones): renewals after expiry and
-- upgrades both supersede the old row before inserting, so the
-- index never blocks a legitimate new period. Pre-existing data
-- with two non-superseded periods for one user would block this
-- index from building — resolve any such rows (supersede all but
-- the latest) before applying.
--
-- Safe to apply at any time: it constrains inserts only, and the
-- app code already supersedes before inserting.

CREATE UNIQUE INDEX IF NOT EXISTS subscription_periods_one_live_per_user
  ON public.subscription_periods (user_id)
  WHERE superseded_at IS NULL;
