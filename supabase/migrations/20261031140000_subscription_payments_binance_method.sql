-- Allow 'binance' as a manual payment method on subscription_payments.
--
-- Binance follows the same manual flow as Easypaisa, Nayapay, and UBL:
-- the customer pays the shown Binance ID, attaches a proof
-- screenshot, and the payment waits for admin approval. It is NOT an
-- automatic crypto checkout (that is the separate NOWPayments flow).
--
-- The original CHECK constraint was created without an explicit name,
-- so Postgres named it subscription_payments_bank_method_check.
-- DROP IF EXISTS + ADD keeps this migration re-runnable.
--
-- APPLY WITH CARE: this only widens the allowed set; it changes no
-- existing rows. The app-level BankMethodSchema already accepts
-- 'binance', so until this migration is applied, a Binance payment
-- insert fails on the CHECK constraint while the UI offers it — apply
-- it together with the code change, on the owner's tap.

ALTER TABLE public.subscription_payments DROP CONSTRAINT IF EXISTS subscription_payments_bank_method_check;
ALTER TABLE public.subscription_payments
  ADD CONSTRAINT subscription_payments_bank_method_check
  CHECK (bank_method IS NULL OR bank_method IN ('easypaisa', 'nayapay', 'ubl', 'binance'));
