-- Auto Download/Upload (ADU) — new tables linked to unified destinations.
--
-- Adaptation of the old fbuploadpro ADU (pages / reels / adu_posting_jobs)
-- to the new app's one data model:
-- - NO parallel `pages` table: an adu_config links to one existing
--   destinations row (a Facebook Page) and adds source + schedule +
--   sync state. Destination name, avatar, account and token stay on
--   destinations / social_accounts only.
-- - NO token gate (old tokens_balance >= 60) and NO global pause switch:
--   neither exists in the new app.
-- - Posting times are HH:mm in the config's own timezone (old app
--   stored UTC); the user-visible schedule is identical.
-- - RLS is enabled with no permissive policies, matching other
--   server-only tables (e.g. idempotency_keys): only the service role
--   used by the web server and the worker reaches these tables.
-- - This migration is NOT applied by the branch that creates it; it is
--   applied separately on the owner's tap.

CREATE TABLE IF NOT EXISTS public.adu_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES public.destinations(id) ON DELETE CASCADE,
  source_platform text NOT NULL CHECK (source_platform IN ('instagram', 'youtube', 'tiktok', 'facebook')),
  source_username text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Karachi',
  posts_per_day integer NOT NULL DEFAULT 1 CHECK (posts_per_day >= 0 AND posts_per_day <= 12),
  schedule_type text NOT NULL DEFAULT 'dailyrandom' CHECK (schedule_type IN ('dailyrandom', 'fixed')),
  posting_times text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'completed', 'fb_verification_required', 'invalid_token', 'fb_rate_limited', 'page_not_accessible', 'invalid_username', 'creator_suspended', '2fa_required_on_BM', 'check_developer_app', 'account_suspended')),
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'browser_pending', 'processing', 'synced', 'error')),
  followers_count integer NOT NULL DEFAULT 0,
  followers_gained integer NOT NULL DEFAULT 0,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adu_configs_destination_unique
  ON public.adu_configs (destination_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adu_configs_workspace_source_unique
  ON public.adu_configs (workspace_id, source_platform, lower(source_username));
CREATE INDEX IF NOT EXISTS idx_adu_configs_workspace_created
  ON public.adu_configs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.adu_reels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES public.adu_configs(id) ON DELETE CASCADE,
  source_reel_id text NOT NULL,
  caption text,
  media_url text,
  media_object_key text,
  media_sha256 text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'downloaded', 'download_failed', 'posted', 'skipped')),
  download_retries integer NOT NULL DEFAULT 0,
  downloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adu_reels_config_source_unique
  ON public.adu_reels (config_id, source_reel_id);
CREATE INDEX IF NOT EXISTS idx_adu_reels_config_status_downloaded
  ON public.adu_reels (config_id, status, downloaded_at DESC);

CREATE TABLE IF NOT EXISTS public.adu_posting_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES public.adu_configs(id) ON DELETE CASCADE,
  reel_id uuid NOT NULL REFERENCES public.adu_reels(id) ON DELETE CASCADE,
  schedule_slot_at timestamptz,
  status text NOT NULL DEFAULT 'pending_publish' CHECK (status IN ('pending_publish', 'publishing', 'published', 'failed_to_publish', 'publish_error', 'integrity_error')),
  publish_retries integer NOT NULL DEFAULT 0,
  graph_post_id text,
  last_error_code text,
  last_error_message text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adu_jobs_config_slot_unique
  ON public.adu_posting_jobs (config_id, schedule_slot_at) WHERE schedule_slot_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_adu_jobs_status_created
  ON public.adu_posting_jobs (status, created_at ASC);

ALTER TABLE public.adu_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adu_reels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adu_posting_jobs ENABLE ROW LEVEL SECURITY;
