-- Subscription: Free (Prompt Library only) and Paid (per-page/account,
-- 70 PKR each per month, monthly, 30 days from approval).
--
-- One data model, server-only tables: RLS is enabled with no
-- permissive policies, matching the other server-only tables (e.g.
-- idempotency_keys). Only the service role used by the web server
-- reaches these tables; every read/write goes through an API route
-- that checks the session and, for admin routes, the admin role.
--
-- Counts are explicit columns per platform so the cap is queryable
-- without decoding a blob: Facebook counts PAGES, every other
-- platform counts ACCOUNTS. The cap is across a platform's features:
-- subscription_usage holds one row per distinct destination a user
-- has used in a feature, per platform. Connecting an account/page
-- never writes here; using it in a feature does.

CREATE TABLE IF NOT EXISTS public.subscription_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid,
  payment_id uuid,
  facebook_count integer NOT NULL DEFAULT 0 CHECK (facebook_count >= 0),
  instagram_count integer NOT NULL DEFAULT 0 CHECK (instagram_count >= 0),
  threads_count integer NOT NULL DEFAULT 0 CHECK (threads_count >= 0),
  x_count integer NOT NULL DEFAULT 0 CHECK (x_count >= 0),
  tiktok_count integer NOT NULL DEFAULT 0 CHECK (tiktok_count >= 0),
  youtube_count integer NOT NULL DEFAULT 0 CHECK (youtube_count >= 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_subscription_periods_user_active
  ON public.subscription_periods (user_id, ends_at)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS public.subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid,
  method text NOT NULL CHECK (method IN ('bank', 'nowpayments')),
  bank_method text CHECK (bank_method IS NULL OR bank_method IN ('easypaisa', 'nayapay', 'ubl')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'paid', 'failed', 'expired')),
  facebook_count integer NOT NULL DEFAULT 0 CHECK (facebook_count >= 0),
  instagram_count integer NOT NULL DEFAULT 0 CHECK (instagram_count >= 0),
  threads_count integer NOT NULL DEFAULT 0 CHECK (threads_count >= 0),
  x_count integer NOT NULL DEFAULT 0 CHECK (x_count >= 0),
  tiktok_count integer NOT NULL DEFAULT 0 CHECK (tiktok_count >= 0),
  youtube_count integer NOT NULL DEFAULT 0 CHECK (youtube_count >= 0),
  amount_pkr integer NOT NULL CHECK (amount_pkr >= 0),
  is_upgrade boolean NOT NULL DEFAULT false,
  screenshot_storage_key text,
  nowpayments_payment_id text,
  nowpayments_pay_address text,
  nowpayments_pay_amount numeric,
  nowpayments_network text CHECK (nowpayments_network IS NULL OR nowpayments_network IN ('trc20', 'bep20')),
  period_id uuid REFERENCES public.subscription_periods (id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_nowpayments_unique
  ON public.subscription_payments (nowpayments_payment_id)
  WHERE nowpayments_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscription_payments_user_created
  ON public.subscription_payments (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_status_created
  ON public.subscription_payments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.subscription_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  platform text NOT NULL
    CHECK (platform IN ('facebook', 'instagram', 'threads', 'x', 'tiktok', 'youtube')),
  destination_key text NOT NULL,
  feature text NOT NULL,
  destination_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_usage_user_platform_destination
  ON public.subscription_usage (user_id, platform, destination_key);

CREATE INDEX IF NOT EXISTS idx_subscription_usage_user_platform
  ON public.subscription_usage (user_id, platform);

CREATE TABLE IF NOT EXISTS public.subscription_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'nowpayments',
  event_key text NOT NULL,
  payment_id text NOT NULL,
  status text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_webhook_events_provider_key
  ON public.subscription_webhook_events (provider, event_key);

ALTER TABLE public.subscription_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_webhook_events ENABLE ROW LEVEL SECURITY;
