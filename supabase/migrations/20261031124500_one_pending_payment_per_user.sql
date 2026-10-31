-- One pending payment per user at a time.
--
-- The app-level pending check in the bank and crypto checkout routes
-- is the immediate protection; this partial unique index is the
-- race-proof backstop, so two submissions that both pass the check
-- cannot both insert. Only status 'pending' is constrained —
-- approved, rejected, paid, failed, and expired rows never block a
-- new submission.
--
-- APPLY WITH CARE: if the live table already holds a user with two
-- or more pending rows (the bug this index closes), CREATE UNIQUE
-- INDEX fails for that user. Resolve duplicate pendings first
-- (decide all but one per user), then apply. The app-level check
-- protects new submissions whether or not this index is applied.

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_one_pending_per_user
  ON public.subscription_payments (user_id)
  WHERE status = 'pending';
