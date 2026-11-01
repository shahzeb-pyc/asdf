-- Creator Finder saved creators (auto-save, 2026-10-30).
--
-- Every successful trending, niche, or similar search upserts its
-- creators here, so a creator found once can be viewed later in
-- the Saved tab and exported as CSV. Nothing here contacts or
-- publishes anything: this table is a private record of creators
-- the user has already found.
--
-- The unique constraint is what guarantees at most one row per
-- (workspace, user, handle): re-saving the same creator updates
-- the existing row instead of duplicating it. The web server
-- merges in code so a later source that lacks follower_count or
-- verified never overwrites a value an earlier source supplied.
--
-- RLS is enabled with no permissive policies, matching the other
-- server-only tables (e.g. idempotency_keys): only the service
-- role used by the web server reaches this table, and every query
-- is scoped to workspace_id + user_id in code.
--
-- WRITTEN BUT NOT APPLIED until the owner taps for it. Until this
-- migration is applied, auto-save reports saveFailed (visible in
-- the UI, never silent) and the Saved tab cannot list anything.

CREATE TABLE IF NOT EXISTS public.creator_finder_saved_creators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  handle text NOT NULL,
  display_name text NULL,
  avatar_url text NULL,
  profile_url text NOT NULL,
  follower_count integer NULL,
  verified boolean NULL,
  source text NOT NULL CHECK (source IN ('trending', 'niche', 'similar')),
  search_term text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_finder_saved_unique
  ON public.creator_finder_saved_creators (workspace_id, user_id, handle);

CREATE INDEX IF NOT EXISTS idx_creator_finder_saved_recent
  ON public.creator_finder_saved_creators (workspace_id, user_id, updated_at DESC);

ALTER TABLE public.creator_finder_saved_creators ENABLE ROW LEVEL SECURITY;
