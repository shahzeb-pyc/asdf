-- =============================================================================
-- Migration: 20261028150000_exact_prompt_length.sql
-- Prompt Library: exact length, stored exactly as the source states it.
--
-- CREATED here but NOT APPLIED by the builder. The parent (Kafka)
-- reviews and applies it himself afterwards, as with the previous
-- prompt-library migrations.
--
-- Problem: a prompt's length is currently only a bucket
-- (video_length_bucket: under_15s / 15_30s / 30s_plus / 1min_plus),
-- so a source that says exactly "30s" is displayed as "15-30s" —
-- not what it says. The bucket is useful for filtering, but it
-- must not replace the exact length.
--
-- What changes here, exactly:
--   ADDED: video_duration_seconds INTEGER, nullable, >= 0, on
--   prompt_library_prompts. It holds the exact length in seconds
--   as the source states it (e.g. 30 for a source that says 30s).
--   NULL means the exact length is unknown (e.g. the demo prompts,
--   which only ever had a bucket) — the UI then falls back to the
--   bucket label exactly as before.
--   KEPT UNCHANGED: video_length_bucket and its CHECK enum, and
--   every other column and constraint. The bucket stays for
--   filtering; the Length filter still uses the bucket, never
--   this column. Nothing is dropped, renamed, or altered.
--
-- Why integer seconds, not free text: the codebase already stores
-- media durations as integer seconds (prompt_library_media.
-- duration_seconds), and seconds are unambiguous and comparable,
-- whereas a text column would invite inconsistent formats ("30s",
-- "30 sec", "0:30"). The exact rendering rule (30 -> "30s",
-- 75 -> "1 min 15s") lives in the contracts helper
-- formatExactDurationSeconds, so every surface renders it alike.
-- =============================================================================

ALTER TABLE public.prompt_library_prompts
  ADD COLUMN IF NOT EXISTS video_duration_seconds INTEGER
    CHECK (video_duration_seconds >= 0);

COMMENT ON COLUMN public.prompt_library_prompts.video_duration_seconds IS
  'Exact video length in seconds, exactly as the source states it (e.g. 30 for a 30s source). NULL = unknown; the UI falls back to video_length_bucket then. The bucket stays for filtering only and must never replace this value in display.';
