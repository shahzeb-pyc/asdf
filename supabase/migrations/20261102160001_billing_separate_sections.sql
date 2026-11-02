-- Billing separate sections (owner decisions 2026-11-02).
--
-- UNAPPLIED: apply manually on the owner's tap, like every migration.
-- The app code tolerates these columns being absent: reason /
-- scheduled fields are recorded best-effort and returned in memory
-- for the decision itself, so a missing column degrades to
-- "reason not persisted" rather than breaking approve/reject.
-- Apply before testing downgrade scheduling and rejection reasons
-- end to end, or those fields will not survive a reload.
ALTER TABLE public.subscription_payments
  ADD COLUMN IF NOT EXISTS is_downgrade boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scheduled_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejection_detail text,
  ADD COLUMN IF NOT EXISTS override_reason text,
  ADD COLUMN IF NOT EXISTS decided_by uuid,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz;
