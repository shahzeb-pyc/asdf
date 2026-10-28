-- Publishing idempotency keys.
--
-- The response-lost hole: a publishing request can succeed on the
-- server while its response never reaches the client, and the
-- client's retry then executes AGAIN — a duplicate queued post for
-- an enqueue. The fix is a client-generated key per logical action,
-- remembered by the server for 24 hours: a retry inside that window
-- returns the stored response without re-executing.
--
-- This migration creates ONLY the table. There is no background
-- cleanup job: expired rows are pruned explicitly, scoped to the
-- calling workspace + user, on every idempotency lookup (see
-- apps/web/src/lib/publishing/idempotency.ts), and a future
-- scheduled job may additionally run
--   DELETE FROM public.idempotency_keys WHERE expires_at < now();
-- The unique constraint is what guarantees at most one stored
-- result per (workspace, user, action, key): the namespace is part
-- of the key, so one user's key can never replay another user's
-- action, and the same key string used for a different action does
-- not cross-talk.
--
-- RLS is enabled with no permissive policies, matching the other
-- server-only tables (e.g. posting_slot_claims): only the service
-- role used by the web server reaches this table.

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL,
  idempotency_key text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_unique_request
  ON public.idempotency_keys (workspace_id, user_id, action, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON public.idempotency_keys (expires_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
