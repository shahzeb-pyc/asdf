-- Seller code tombstones (owner decision 2026-11-01): deleting a
-- seller tombstones its referral codes instead of deleting them,
-- so a code can never be re-claimed by another seller. The
-- existing globally-unique index on referral_codes.code keeps
-- tombstoned codes reserved forever: the code-clash check still
-- sees them as taken, and the insert 23505 backstop still fires.
-- resolveReferralCode and getCurrentReferralCode exclude
-- tombstoned rows, so a deleted seller's link attributes nobody.
-- Pre-existing rows get NULL (live) from the column default, so
-- no backfill is needed. Safe to apply at any time: it only adds
-- a nullable column, and the app code tolerates its absence
-- only until this migration lands (reads of tombstoned_at would
-- fail on a database without the column — apply promptly).
--
-- UNAPPLIED: apply manually on the owner's tap, like every migration.

ALTER TABLE public.referral_codes
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;

COMMENT ON COLUMN public.referral_codes.tombstoned_at IS
  'Set when the owning seller is deleted. A tombstoned code stays reserved forever: it can never be re-claimed, and it never attributes a signup.';
