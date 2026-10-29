-- Queue-item idempotency key (Create Posts duplicate fix, 2026-10-29).
--
-- WRITTEN BUT NOT APPLIED TO PROD. The web code falls back gracefully
-- when this column does not exist yet (insert without it, heal lookup
-- returns null), so applying this migration is safe at any time and
-- only strengthens the duplicate protection.
--
-- Why a second guard when idempotency_keys already exists: the
-- idempotency result is stored AFTER the queue insert. If that store
-- fails (it is deliberately swallowed so a success is never turned
-- into an error), a later retry finds no stored result and would
-- insert a second row. Storing the key ON the queue row itself lets
-- a retry find the original row and return it instead of inserting.
-- The partial unique index keeps one row per (workspace, key) while
-- leaving keyless rows (old rows, keyless callers) untouched.

ALTER TABLE public.queue_items
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_items_workspace_idempotency_key
  ON public.queue_items (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
