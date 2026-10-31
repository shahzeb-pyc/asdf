-- Coupons: three kinds, server-only tables.
--
-- Kinds (owner-decided 2026-10-31):
--   percent_once  — percent off, redeemable ONCE globally; the first
--                   applier consumes it (consumed_at), then it is dead.
--   percent_multi — percent off, usable by anyone any number of times
--                   until the admin pauses or deletes it. No balance.
--   balance       — fixed PKR value, a shared pool: any user draws,
--                   each use deducts min(balance, amount due), remainder
--                   stays usable until the balance hits 0.
-- Anyone can use any coupon; codes are not tied to a user.
-- Redemptions are the audit trail: held at submission, applied on
-- approval/finalisation, released on rejection/expiry. Balance and
-- consumed_at are only ever moved by single-statement conditional
-- updates (see apps/web/src/lib/billing/coupons.ts), never from
-- client input, so concurrent applications cannot overdraw.
--
-- RLS is enabled with no permissive policies, matching the other
-- server-only tables (e.g. subscription_payments). Only the service
-- role used by the web server reaches these tables.

CREATE TABLE IF NOT EXISTS public.coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent_once', 'percent_multi', 'balance')),
  percent integer CHECK (percent IS NULL OR (percent >= 1 AND percent <= 100)),
  initial_balance_pkr integer CHECK (initial_balance_pkr IS NULL OR initial_balance_pkr > 0),
  remaining_balance_pkr integer CHECK (remaining_balance_pkr IS NULL OR remaining_balance_pkr >= 0),
  consumed_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'deleted')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind IN ('percent_once', 'percent_multi') AND percent IS NOT NULL
      AND initial_balance_pkr IS NULL AND remaining_balance_pkr IS NULL)
    OR
    (kind = 'balance' AND percent IS NULL
      AND initial_balance_pkr IS NOT NULL AND remaining_balance_pkr IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code_unique
  ON public.coupons (code);

CREATE INDEX IF NOT EXISTS idx_coupons_status_created
  ON public.coupons (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES public.coupons (id) ON DELETE RESTRICT,
  coupon_kind text NOT NULL CHECK (coupon_kind IN ('percent_once', 'percent_multi', 'balance')),
  user_id uuid NOT NULL,
  payment_id uuid REFERENCES public.subscription_payments (id) ON DELETE SET NULL,
  period_id uuid REFERENCES public.subscription_periods (id) ON DELETE SET NULL,
  amount_pkr integer NOT NULL CHECK (amount_pkr >= 0),
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'applied', 'released')),
  balance_restored boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_created
  ON public.coupon_redemptions (coupon_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_payment
  ON public.coupon_redemptions (payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user_created
  ON public.coupon_redemptions (user_id, created_at DESC);

-- Payment rows record the coupon that reduced them, so the user
-- history and the admin approvals view can show the discount
-- without joining redemptions. amount_pkr on the row is always the
-- REDUCED amount actually due.
ALTER TABLE public.subscription_payments
  ADD COLUMN IF NOT EXISTS coupon_code text,
  ADD COLUMN IF NOT EXISTS discount_pkr integer NOT NULL DEFAULT 0
    CHECK (discount_pkr >= 0);

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;
