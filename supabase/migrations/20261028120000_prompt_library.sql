-- =============================================================================
-- Migration: 20261028120000_prompt_library.sql
-- Prompt Library backend (admin-only catalogue).
--
-- DECISION (Shahzeb, 2026-10-28): prompts are NEVER uploaded by users.
-- Every new prompt is added by US via the backend admin API only.
-- There is no user submission flow in this migration, no user-owned
-- prompt column, and no public create path — writes are enforced in
-- the API by session.role = 'admin' (403 otherwise).
--
-- This file is CREATED here but NOT APPLIED by the builder. The parent
-- (Kafka) reviews and applies it himself afterwards. No seed data:
-- the catalogue starts empty — no fake prompts, no fake counts.
-- Enums in CHECK constraints must match
-- packages/contracts/src/domain/prompt-library.ts exactly.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. prompt_library_prompts — one row per prompt
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prompt_library_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  short_description text NOT NULL,
  master_prompt text NOT NULL,
  tool text NOT NULL CHECK (tool IN ('dola_ai', 'veo3', 'google_flow')),
  category text NOT NULL CHECK (category IN ('animals', 'comedy', 'cinematic', 'ugc', 'tutorial', 'unboxing')),
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ur', 'hi')),
  video_length_bucket text NOT NULL CHECK (video_length_bucket IN ('under_15s', '15_30s', '30s_plus', '1min_plus')),
  format text NOT NULL CHECK (format IN ('vertical_reel', 'horizontal_video')),
  aspect_ratio text NOT NULL CHECK (aspect_ratio IN ('9:16', '16:9')),
  preview_media_type text NOT NULL CHECK (preview_media_type IN ('image', 'video')),
  preview_storage_key text NOT NULL CHECK (preview_storage_key LIKE 'prompts/%'),
  preview_poster_key text CHECK (preview_poster_key IS NULL OR preview_poster_key LIKE 'prompts/%'),
  duration_seconds numeric CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  copied_count integer NOT NULL DEFAULT 0 CHECK (copied_count >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_library_prompts_format_aspect CHECK (
    (format = 'vertical_reel' AND aspect_ratio = '9:16') OR
    (format = 'horizontal_video' AND aspect_ratio = '16:9')
  ),
  CONSTRAINT prompt_library_prompts_video_poster CHECK (
    preview_media_type <> 'video' OR preview_poster_key IS NOT NULL
  )
);

COMMENT ON TABLE public.prompt_library_prompts IS
  'Admin-only prompt catalogue. Preview media lives in R2 under prompts/{prompt_id}/; this table stores only storage keys, never bytes. copied_count is incremented only by the increment_prompt_copy RPC — never written by clients.';

CREATE INDEX IF NOT EXISTS idx_prompt_library_prompts_status_created
  ON public.prompt_library_prompts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_library_prompts_category
  ON public.prompt_library_prompts (category);
CREATE INDEX IF NOT EXISTS idx_prompt_library_prompts_tool
  ON public.prompt_library_prompts (tool);
CREATE INDEX IF NOT EXISTS idx_prompt_library_prompts_language
  ON public.prompt_library_prompts (language);
CREATE INDEX IF NOT EXISTS idx_prompt_library_prompts_length
  ON public.prompt_library_prompts (video_length_bucket);
CREATE INDEX IF NOT EXISTS idx_prompt_library_prompts_format
  ON public.prompt_library_prompts (format);
CREATE INDEX IF NOT EXISTS idx_prompt_library_prompts_copied
  ON public.prompt_library_prompts (copied_count DESC);

DROP TRIGGER IF EXISTS trg_prompt_library_prompts_updated_at
  ON public.prompt_library_prompts;
CREATE TRIGGER trg_prompt_library_prompts_updated_at
  BEFORE UPDATE ON public.prompt_library_prompts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. prompt_library_how_to_steps — ordered steps, not a jsonb blob
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prompt_library_how_to_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES public.prompt_library_prompts (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 1),
  title text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_prompt_library_how_to_steps_prompt_position UNIQUE (prompt_id, position)
);

CREATE INDEX IF NOT EXISTS idx_prompt_library_how_to_steps_prompt
  ON public.prompt_library_how_to_steps (prompt_id, position);

-- ---------------------------------------------------------------------------
-- 3. prompt_library_favourites — one favourite per user per prompt
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prompt_library_favourites (
  user_id uuid NOT NULL,
  prompt_id uuid NOT NULL REFERENCES public.prompt_library_prompts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_prompt_library_favourites PRIMARY KEY (user_id, prompt_id)
);

CREATE INDEX IF NOT EXISTS idx_prompt_library_favourites_user
  ON public.prompt_library_favourites (user_id);

-- ---------------------------------------------------------------------------
-- 4. prompt_library_copy_events — audit trail for the copied counter
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prompt_library_copy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES public.prompt_library_prompts (id) ON DELETE CASCADE,
  user_id uuid,
  copied_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prompt_library_copy_events_prompt
  ON public.prompt_library_copy_events (prompt_id, copied_at DESC);

-- ---------------------------------------------------------------------------
-- 5. RPC: increment_prompt_copy — counter + event in ONE transaction
-- Only published prompts can be copied. Returns the new copied_count.
-- The browser never writes copied_count directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_prompt_copy(
  p_prompt_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_count integer;
BEGIN
  UPDATE public.prompt_library_prompts
  SET copied_count = copied_count + 1
  WHERE id = p_prompt_id AND status = 'published'
  RETURNING copied_count INTO v_new_count;

  IF v_new_count IS NULL THEN
    RAISE EXCEPTION 'prompt_not_found_or_not_published' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.prompt_library_copy_events (prompt_id, user_id)
  VALUES (p_prompt_id, p_user_id);

  RETURN v_new_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_prompt_copy(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_prompt_copy(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security (defence in depth — the API also enforces these
-- rules with session auth; service_role, used by the API, bypasses RLS)
-- ---------------------------------------------------------------------------
ALTER TABLE public.prompt_library_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_library_how_to_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_library_favourites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_library_copy_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prompt_library_prompts_read_published ON public.prompt_library_prompts;
CREATE POLICY prompt_library_prompts_read_published
  ON public.prompt_library_prompts FOR SELECT TO authenticated
  USING (status = 'published');

DROP POLICY IF EXISTS prompt_library_how_to_steps_read_published ON public.prompt_library_how_to_steps;
CREATE POLICY prompt_library_how_to_steps_read_published
  ON public.prompt_library_how_to_steps FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prompt_library_prompts p
    WHERE p.id = prompt_library_how_to_steps.prompt_id AND p.status = 'published'
  ));

DROP POLICY IF EXISTS prompt_library_favourites_own_rows ON public.prompt_library_favourites;
CREATE POLICY prompt_library_favourites_own_rows
  ON public.prompt_library_favourites FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Copy events: no direct client access at all (insert-only via the RPC,
-- which runs SECURITY DEFINER). No policies = deny for anon/authenticated.
-- Draft prompts are readable only through the service-role API by admins;
-- no RLS policy grants draft reads to authenticated users, by design.
