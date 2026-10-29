-- Queue-item idempotency key (Create Posts duplicate fix, 2026-10-29).
--
-- WRITTEN BUT NOT APPLIED TO PROD. The web code works before this
-- migration is applied, with one deliberate limit: inserts fall back
-- to inserting without the column, and the heal lookup returns null
-- ONLY for missing-column errors (Postgres 42703, PostgREST PGRST204,
-- or a message naming idempotency_key) — every other heal error
-- still throws and the route 500s before executing, so a failed heal
-- never silently proceeds to a fresh insert. Until this migration is
-- applied, the heal cannot find a row by key (there is no column to
-- find it by), so the key-column duplicate protection only takes
-- full effect once this migration is applied. Apply it manually
-- after merge; there is no broken-composer window either way.
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
