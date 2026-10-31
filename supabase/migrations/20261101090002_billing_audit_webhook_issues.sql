-- Billing audit fixes 2026-11-01 (fixes 8 + 22): webhook actuals
-- and the admin-visible webhook-issues list.
--
-- UNAPPLIED: apply manually on the owner's tap, like every migration.
--
-- (8) The crypto webhook persists the IPN's actual paid amounts
-- on the payment row. Payments stay PKR-stored — no new currency
-- policy: the actual USDT figure and its network sit ALONGSIDE
-- amount_pkr, never converted. Refund math prefers the persisted
-- actual USDT when present and falls back to the checkout
-- estimate otherwise. The webhook code tolerates these columns
-- being absent (logs, never fails) until this migration is
-- applied.
--
-- (22) Unknown, mismatched, underpaid, and refunded webhooks land
-- in subscription_webhook_issues for the admin to see, instead of
-- being swallowed. The partial unique index keeps one open issue
-- per (provider, provider payment id, reason): a repeat insert
-- for the same open issue is a no-op, never a duplicate row.
-- Dismissing an issue (dismissed_at set) frees the slot, so a
-- later event for the same key can raise a fresh issue.

ALTER TABLE public.subscription_payments
  ADD COLUMN IF NOT EXISTS nowpayments_actual_paid double precision,
  ADD COLUMN IF NOT EXISTS nowpayments_actual_currency text;

CREATE TABLE IF NOT EXISTS public.subscription_webhook_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  payment_id uuid REFERENCES public.subscription_payments (id),
  reason text NOT NULL
    CHECK (reason IN ('unknown_payment', 'amount_mismatch', 'currency_mismatch', 'underpaid', 'coupon_released_before_finish', 'refunded')),
  detail text,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_webhook_issues_one_open
  ON public.subscription_webhook_issues (provider, provider_payment_id, reason)
  WHERE dismissed_at IS NULL;

ALTER TABLE public.subscription_webhook_issues ENABLE ROW LEVEL SECURITY;

-- Admin-only via the service-role admin client (same pattern as
-- the other subscription admin tables: no anon/authenticated
-- grants; the admin API reads through the service-role client).
-- No GRANT statements: the default (no PUBLIC access beyond the
-- table owner) is the locked state, and the service-role client
-- bypasses RLS.
