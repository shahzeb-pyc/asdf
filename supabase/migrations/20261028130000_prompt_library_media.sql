-- =============================================================================
-- Migration: 20261028130000_prompt_library_media.sql
-- Prompt Library: a prompt has MULTIPLE videos and images, not one preview.
--
-- CREATED here but NOT APPLIED by the builder. The parent (Kafka)
-- reviews and applies it himself afterwards. No seed data.
--
-- One data model, no parallel fields: existing single-preview columns
-- are carried over into the new table and then DROPPED from
-- prompt_library_prompts in this same migration. After this file,
-- the old preview_* / duration_seconds columns do not exist.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. prompt_library_media — one row per video/image of a prompt
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prompt_library_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES public.prompt_library_prompts (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 1),
  media_type text NOT NULL CHECK (media_type IN ('image', 'video')),
  storage_key text NOT NULL CHECK (storage_key LIKE 'prompts/%'),
  poster_key text CHECK (poster_key IS NULL OR poster_key LIKE 'prompts/%'),
  duration_seconds numeric CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  is_main boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_library_media_video_poster CHECK (
    media_type <> 'video' OR poster_key IS NOT NULL
  ),
  CONSTRAINT uq_prompt_library_media_prompt_position UNIQUE (prompt_id, position)
);

CREATE INDEX IF NOT EXISTS idx_prompt_library_media_prompt
  ON public.prompt_library_media (prompt_id, position);

-- Exactly one main media item per prompt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_library_media_one_main
  ON public.prompt_library_media (prompt_id)
  WHERE is_main;

ALTER TABLE public.prompt_library_media ENABLE ROW LEVEL SECURITY;

-- Media is readable exactly when its prompt is published, same rule
-- as the how-to steps policy. No direct client writes: all media
-- writes go through the admin API (service_role bypasses RLS).
DROP POLICY IF EXISTS prompt_library_media_read_published ON public.prompt_library_media;
CREATE POLICY prompt_library_media_read_published
  ON public.prompt_library_media FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prompt_library_prompts p
    WHERE p.id = prompt_library_media.prompt_id AND p.status = 'published'
  ));

-- ---------------------------------------------------------------------------
-- 2. Carry over every existing single preview as position 1, main.
--    The 4 demo prompts each have one media, so they keep working.
-- ---------------------------------------------------------------------------
INSERT INTO public.prompt_library_media
  (prompt_id, position, media_type, storage_key, poster_key, duration_seconds, is_main)
SELECT
  id, 1, preview_media_type, preview_storage_key, preview_poster_key,
  duration_seconds, true
FROM public.prompt_library_prompts
WHERE NOT EXISTS (
  SELECT 1 FROM public.prompt_library_media m WHERE m.prompt_id = prompt_library_prompts.id
);

-- ---------------------------------------------------------------------------
-- 3. Drop the old single-preview columns and their constraints.
--    The table-level video/poster constraint references the old
--    columns, so it must go first or the column drops fail.
-- ---------------------------------------------------------------------------
ALTER TABLE public.prompt_library_prompts
  DROP CONSTRAINT IF EXISTS prompt_library_prompts_video_poster;

ALTER TABLE public.prompt_library_prompts
  DROP COLUMN IF EXISTS preview_storage_key,
  DROP COLUMN IF EXISTS preview_poster_key,
  DROP COLUMN IF EXISTS preview_media_type,
  DROP COLUMN IF EXISTS duration_seconds;

COMMENT ON TABLE public.prompt_library_media IS
  'All videos/images of a prompt. Exactly one row per prompt has is_main = true; the card preview uses it and the detail section shows the full gallery. Media lives in R2 under prompts/{prompt_id}/; this table stores only storage keys, never bytes.';
