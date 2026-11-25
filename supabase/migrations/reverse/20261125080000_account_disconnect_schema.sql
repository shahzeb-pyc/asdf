-- Reverse migration for 20261125080000_account_disconnect_schema.sql (spec 248).
-- Restores the 4-value account status CHECK and the token NOT NULL.
-- Only clean BEFORE any account has been disconnected: SET NOT NULL fails
-- loudly while any row carries a NULL token, and the 4-value CHECK fails
-- loudly while any row carries status 'disconnected'. Rolling back after
-- a real disconnect is a deliberate stop, not a degraded mode.
ALTER TABLE public.social_accounts DROP CONSTRAINT social_accounts_status_check;
ALTER TABLE public.social_accounts ADD CONSTRAINT social_accounts_status_check
  CHECK (status IN ('active', 'expired', 'revoked', 'error'));
ALTER TABLE public.social_accounts ALTER COLUMN encrypted_access_token SET NOT NULL;
