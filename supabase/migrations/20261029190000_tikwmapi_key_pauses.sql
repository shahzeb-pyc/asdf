-- Paid tikwmapi key pauses (Auto Repost feed rotation).
--
-- The paid feed API is called with a list of keys (TIKWMAPI_KEYS,
-- plus TIKWMAPI_KEY appended). When the API reports a key as spent
-- or invalid (code 10401 invalid key, code 10430 period quota
-- exhausted), that key is paused for 30 days and later calls use
-- the next key in list order. A per-minute throttle (10429) never
-- earns a pause row — it just moves to the next key for that call.
--
-- Pause state must survive serverless invocations and worker
-- ticks, so it lives here, not in memory. Rows are keyed by a
-- one-way SHA-256 hex fingerprint of the key — the key itself is
-- NEVER stored. When a pause expires, the key automatically
-- becomes eligible again in list order; there is no manual
-- unpause step, and expired rows need no cleanup job (an expired
-- pause simply stops matching; a future job may additionally run
--   DELETE FROM public.tikwmapi_key_pauses WHERE paused_until < now();
-- ).
--
-- This migration creates ONLY the table. It is fully idempotent
-- (IF NOT EXISTS throughout), so re-applying is a safe no-op.
-- RLS is enabled with no permissive policies, matching the other
-- server-only tables (e.g. idempotency_keys): only the service
-- role used by the web server and worker reaches this table.
--
-- NOT APPLIED to any database by the branch author: migrations
-- stay manual. If this table does not exist at runtime, feed
-- calls still rotate through keys for the call itself, but
-- pauses cannot be persisted (logged loudly, never silently
-- skipped without a trace).

CREATE TABLE IF NOT EXISTS public.tikwmapi_key_pauses (
  key_fingerprint text PRIMARY KEY,
  paused_until timestamptz NOT NULL,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tikwmapi_key_pauses IS
  'Paid tikwmapi key pauses: SHA-256 fingerprint -> pause expiry. Key values are never stored.';

ALTER TABLE public.tikwmapi_key_pauses ENABLE ROW LEVEL SECURITY;
