-- =============================================================================
-- Migration: 20261030120000_download_jobs_cloudflare_checkpoint.sql
-- (spec 149, Cloudflare backend revision §6.3)
--
-- Purpose: ADDITIVE ONLY — extend media_download_jobs with the columns
-- the Cloudflare Queue consumer needs for checkpoint/resume and for
-- the deterministic-media-id idempotency fix. The earlier migration
-- 20261025120000 (claim lease, attempts, resolving state, heartbeat
-- table, claim_download_jobs RPC) is NOT edited; this file only adds.
--
--   pending_media_id    — media id fixed at claim time, before any
--                          byte streams, so a retried job can never
--                          create a second library row (ON CONFLICT
--                          DO NOTHING on media_items.id).
--   r2_upload_id        — R2 multipart upload id, or NULL if not started.
--   checkpoint_parts    — [{ partNumber, etag }] for completed parts.
--   checkpoint_bytes    — bytes already uploaded for the checkpoint.
--   checkpoint_stream_url — resolved media URL the checkpoint belongs
--                          to, revalidated before reuse on resume.
--   last_progress_at    — liveness signal for the 30-minute stale
--                          reclaim (Cron) and for consumer health.
--
-- This migration is WRITTEN here and NOT applied by the PR author:
-- it is applied to dev first for verification, and to prod only
-- after merge, each with a separate go-ahead.
-- =============================================================================

ALTER TABLE public.media_download_jobs
  ADD COLUMN IF NOT EXISTS pending_media_id UUID NULL,
  ADD COLUMN IF NOT EXISTS r2_upload_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS checkpoint_parts JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS checkpoint_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkpoint_stream_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ NULL;

-- Cron sweeper input: queued jobs, oldest first.
CREATE INDEX IF NOT EXISTS idx_media_download_jobs_cf_sweep
  ON public.media_download_jobs (status, created_at ASC)
  WHERE status = 'queued';

-- Stale reclaim input: active jobs by last progress update.
CREATE INDEX IF NOT EXISTS idx_media_download_jobs_cf_stale
  ON public.media_download_jobs (status, last_progress_at ASC)
  WHERE status IN ('resolving', 'downloading');
