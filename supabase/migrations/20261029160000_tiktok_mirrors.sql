-- Mirrors: one source-platform account feeding one target-platform
-- account. Platform-agnostic by design: Facebook + TikTok are simply
-- the first source/target pair. A later platform needs no schema
-- change — source_platform / target_platform are plain text, NOT
-- check-constrained to today's platforms.
--
-- A mirror posts every new item from a public source account to its
-- linked target account, caption verbatim. The same source username
-- may feed several targets (one mirror row per pair), but the exact
-- pair (source platform + username + target platform + target id)
-- may exist only once, or every item would post twice to that
-- target.
--
-- Target resolution is by (target_platform, target_external_id),
-- NOT by a destination-row foreign key: the worker tick resolves
-- the target to its posting token via the normal destination lookup
-- (workspace + platform + external id) at publish time. If the
-- target row is gone, the mirror surfaces an error instead of
-- silently vanishing (there is deliberately no FK cascade here).
--
-- Dedup: mirror_posts has a unique (mirror_id, source_post_id)
-- constraint and the row is inserted BEFORE publishing, so
-- overlapping ticks can never double-post. Mirror posts bypass
-- queue/slots entirely, and mirrors carry no timezone or posting
-- times.
--
-- RLS is enabled with no permissive policies, matching the other
-- server-only tables (e.g. idempotency_keys): only the service
-- role used by the web server and the worker reaches these tables.
--
-- NOT applied automatically: migrations stay manual and are applied
-- after merge (see the repo workflow).

CREATE TABLE IF NOT EXISTS public.mirrors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_platform text NOT NULL,
  source_username text NOT NULL,
  source_display_name text NULL,
  source_avatar_url text NULL,
  target_platform text NOT NULL,
  target_external_id text NOT NULL,
  target_display_name text NOT NULL,
  target_avatar_url text NULL,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error')),
  -- Set on resume (paused -> active) and cleared after the next
  -- tick that successfully checks the feed: that tick is a
  -- catch-up tick and posts only the newest reel (older missed
  -- reels are recorded skipped, never posted later). See the
  -- worker's mirror-tick header for the full rule.
  catch_up_pending boolean NOT NULL DEFAULT false,
  last_posted_source_id text NULL,
  last_posted_create_time bigint NULL,
  last_checked_at timestamptz NULL,
  next_check_at timestamptz NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mirrors_source_target
  ON public.mirrors (source_platform, source_username, target_platform, target_external_id);

CREATE INDEX IF NOT EXISTS idx_mirrors_workspace
  ON public.mirrors (workspace_id);

CREATE TABLE IF NOT EXISTS public.mirror_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mirror_id uuid NOT NULL REFERENCES public.mirrors(id) ON DELETE CASCADE,
  source_post_id text NOT NULL,
  caption text NOT NULL DEFAULT '',
  video_url text NULL,
  cover_url text NULL,
  source_created_at timestamptz NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('posted', 'failed', 'skipped', 'pending')),
  published_post_id text NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mirror_posts_mirror_source
  ON public.mirror_posts (mirror_id, source_post_id);

CREATE INDEX IF NOT EXISTS idx_mirror_posts_mirror
  ON public.mirror_posts (mirror_id, created_at DESC);

ALTER TABLE public.mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mirror_posts ENABLE ROW LEVEL SECURITY;
