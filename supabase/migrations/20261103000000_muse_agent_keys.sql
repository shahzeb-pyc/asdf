-- Muse agent keys (Media Library only) + agent activity.
--
-- UNAPPLIED: apply manually on the owner's tap, like every migration.
-- Until it is applied, the Muse key/activity routes fail loudly
-- with a plain database error instead of returning fake success,
-- and the Muse page shows that error instead of an empty list.
--
-- A key is stored as a SHA-256 hash only, never in plaintext, and
-- is never revealed after creation. Revocation deletes the row:
-- there is no revoked flag to leak a dead key into a list.
-- Scopes are locked to media read + write by CHECK.
-- Media itself stays per-user (media_items.workspace_id is
-- nullable/unused); agent_activity is per-user too, with an
-- optional workspace-free design: the tenant gate for the Muse
-- page/activity read is a workspace the user owns, checked in code.

CREATE TABLE IF NOT EXISTS public.agent_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) >= 1 AND char_length(name) <= 100),
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['media:read', 'media:write']::text[]
    CHECK (scopes = ARRAY['media:read', 'media:write']::text[]),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_keys_user_id_created_at_idx
  ON public.agent_keys (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_keys_key_hash_idx
  ON public.agent_keys (key_hash);

CREATE TABLE IF NOT EXISTS public.agent_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  agent_key_id uuid REFERENCES public.agent_keys (id) ON DELETE SET NULL,
  media_id uuid NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('video', 'image')),
  folder_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_activity_user_id_created_at_idx
  ON public.agent_activity (user_id, created_at DESC);

ALTER TABLE public.agent_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_activity ENABLE ROW LEVEL SECURITY;
-- Service-role access only, as with worker_heartbeats: no public
-- policies, so no direct PostgREST access; all reads/writes go
-- through the app's service-role client with code-level checks.
