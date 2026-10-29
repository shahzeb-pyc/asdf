-- TikTok mirrors: one TikTok username feeding one Facebook page.
--
-- A mirror posts every reel from a public TikTok account to its
-- linked Facebook page as a Facebook Reel, caption verbatim. The
-- same username may feed several pages (one mirror row per pair),
-- but the exact pair (username + page) may exist only once, or
-- every reel would post twice to that page.
--
-- Dedup: tiktok_mirror_posts has a unique (mirror_id,
-- tiktok_video_id) constraint and the row is inserted BEFORE
-- calling Facebook, so overlapping hourly ticks can never
-- double-post. Mirror posts bypass queue/slots entirely, and
-- mirrors carry no timezone or posting times.
--
-- RLS is enabled with no permissive policies, matching the other
-- server-only tables (e.g. idempotency_keys): only the service
-- role used by the web server and the worker reaches these tables.
--
-- NOT applied automatically: migrations stay manual and are applied
-- after merge (see the repo workflow).

CREATE TABLE IF NOT EXISTS public.tiktok_mirrors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES public.destinations(id) ON DELETE CASCADE,
  tiktok_username text NOT NULL,
  tiktok_display_name text NULL,
  tiktok_avatar_url text NULL,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error')),
  last_posted_video_id text NULL,
  last_posted_create_time bigint NULL,
  last_checked_at timestamptz NULL,
  next_check_at timestamptz NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tiktok_mirrors_destination_username
  ON public.tiktok_mirrors (destination_id, tiktok_username);

CREATE INDEX IF NOT EXISTS idx_tiktok_mirrors_workspace
  ON public.tiktok_mirrors (workspace_id);

CREATE TABLE IF NOT EXISTS public.tiktok_mirror_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mirror_id uuid NOT NULL REFERENCES public.tiktok_mirrors(id) ON DELETE CASCADE,
  tiktok_video_id text NOT NULL,
  caption text NOT NULL DEFAULT '',
  video_url text NULL,
  cover_url text NULL,
  tiktok_created_at timestamptz NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('posted', 'failed', 'skipped', 'pending')),
  facebook_post_id text NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tiktok_mirror_posts_mirror_video
  ON public.tiktok_mirror_posts (mirror_id, tiktok_video_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_mirror_posts_mirror
  ON public.tiktok_mirror_posts (mirror_id, created_at DESC);

ALTER TABLE public.tiktok_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tiktok_mirror_posts ENABLE ROW LEVEL SECURITY;
