-- Sellers (reseller) system: referral-only, no seller coupons.
--
-- Sellers are `users` rows with role 'seller' (the role enum already
-- allows it). A seller account is never also a user account: no
-- workspace row is created for sellers, and they see only the
-- seller view.
--
-- Attribution is referral-only and immutable: the link active at
-- signup is stored on the new account (referred_by_seller_id +
-- referred_by_code) and never updated afterwards. The columns
-- carry NO foreign key on purpose: deleting a seller must never
-- destroy attribution history, and commission rows must survive
-- seller deletion for payout audit. The same applies to
-- seller_commissions.seller_id (plain uuid, no FK).
--
-- Referral codes: stored uppercase. The unique index covers ALL
-- rows ever (current + superseded), so a code is never reusable
-- by anyone. Past codes stay valid forever: resolution accepts
-- any code row for the seller, current or superseded.
--
-- Commission lifecycle: pending -> payable once BOTH 10 days
-- have passed from plan start AND no unresolved refund request
-- exists on that payment (the payable transition is computed
-- server-side; see lib/billing/sellers.ts). One commission row
-- per payment (unique index on payment_id) makes approval and
-- webhook redelivery idempotent.
--
-- RLS is enabled with no permissive policies, matching the other
-- server-only tables (e.g. subscription_payments). Only the
-- service role used by the web server reaches these tables.
--
-- SHIPPED UNAPPLIED: apply manually on the owner's tap after merge.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS referred_by_seller_id uuid,
  ADD COLUMN IF NOT EXISTS referred_by_code text;

CREATE TABLE IF NOT EXISTS public.seller_settings (
  user_id uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  rate integer NOT NULL CHECK (rate >= 1 AND rate <= 100),
  scope text NOT NULL CHECK (scope IN ('one-time', 'every')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

-- Global ever-uniqueness: current, superseded, every seller.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code_unique
  ON public.referral_codes (code);

CREATE INDEX IF NOT EXISTS idx_referral_codes_seller_created
  ON public.referral_codes (seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.seller_payout_details (
  seller_id uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('easypaisa', 'nayapay', 'ubl', 'binance')),
  account_label text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.seller_payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL,
  total_pkr integer NOT NULL CHECK (total_pkr >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'rejected')),
  seller_name_snapshot text,
  seller_email_snapshot text NOT NULL,
  payout_method_snapshot text
    CHECK (payout_method_snapshot IS NULL OR payout_method_snapshot IN ('easypaisa', 'nayapay', 'ubl', 'binance')),
  payout_account_snapshot text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_payout_requests_seller_status
  ON public.seller_payout_requests (seller_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_requests_status_requested
  ON public.seller_payout_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.seller_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.subscription_payments (id) ON DELETE RESTRICT,
  period_id uuid REFERENCES public.subscription_periods (id) ON DELETE SET NULL,
  period_starts_at timestamptz NOT NULL,
  rate_snapshot integer NOT NULL CHECK (rate_snapshot >= 1 AND rate_snapshot <= 100),
  scope_snapshot text NOT NULL CHECK (scope_snapshot IN ('one-time', 'every')),
  amount_pkr integer NOT NULL CHECK (amount_pkr >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'payable', 'requested', 'paid', 'cancelled')),
  payout_request_id uuid REFERENCES public.seller_payout_requests (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One commission per payment: approval and webhook redelivery are
-- idempotent by construction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_commissions_payment_unique
  ON public.seller_commissions (payment_id);

CREATE INDEX IF NOT EXISTS idx_seller_commissions_seller_status
  ON public.seller_commissions (seller_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_commissions_user_created
  ON public.seller_commissions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_commissions_payout_request
  ON public.seller_commissions (payout_request_id)
  WHERE payout_request_id IS NOT NULL;

ALTER TABLE public.seller_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_payout_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_payout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_commissions ENABLE ROW LEVEL SECURITY;
