-- =============================================================================
-- Migration: 20261025120000_download_jobs_worker_claim.sql (spec 149)
-- Purpose:
--   Extend the pre-existing media_download_jobs table (20261017000000) for
--   the VPS download worker. This is NOT a second jobs table: the table
--   already exists and is the one jobs model; this migration only adds
--   what server-side claiming needs.
--   1. `resolving` state (claim → resolve → download).
--   2. Rename the legacy `completed` label to `done` (the spec-149 wire
--      status). Rows already marked `completed` are relabelled by the
--      rename itself; `processing` rows are left untouched and the API
--      maps them to `downloading` for display.
--   3. Claim lease columns (attempts / claimed_at / claimed_by).
--   4. Worker heartbeat table (fail loud when the worker dies).
--   5. Atomic per-user capped claim RPC (race-safe, service_role only).
-- =============================================================================

-- 1. New `resolving` enum value. A value added inside a transaction
-- cannot be used until after commit, and this file never uses it in
-- the same transaction, so the DO-block guard is safe here.
DO $$ BEGIN
  ALTER TYPE public.media_download_job_status ADD VALUE 'resolving';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. `completed` → `done`.
ALTER TYPE public.media_download_job_status RENAME VALUE 'completed' TO 'done';

-- 3. Claim lease columns.
ALTER TABLE public.media_download_jobs
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT NULL;

-- Worker polling index: users with queued work, oldest first.
CREATE INDEX IF NOT EXISTS idx_media_download_jobs_worker_poll
  ON public.media_download_jobs (status, created_at ASC)
  WHERE status = 'queued';

-- 4. Worker heartbeat. Service-role only: RLS is enabled with no
-- policies, and service_role bypasses RLS by design, so anon and
-- authenticated callers cannot read or forge heartbeats.
CREATE TABLE IF NOT EXISTS public.download_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.download_worker_heartbeats ENABLE ROW LEVEL SECURITY;

-- 5. Atomic claim. The advisory transaction lock serializes claims for
-- one user across concurrent workers, so the per-user cap (3 active)
-- cannot be overshot by a race; SKIP LOCKED additionally protects
-- against two workers grabbing the same row. The claim moves jobs to
-- `resolving` and stamps the lease; the worker advances them to
-- `downloading` once bytes start flowing.
CREATE OR REPLACE FUNCTION public.claim_download_jobs(
  p_worker_id TEXT,
  p_user_id UUID,
  p_limit INT DEFAULT 3
)
RETURNS SETOF public.media_download_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active INT;
  v_slots INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  SELECT count(*)::INT INTO v_active
  FROM public.media_download_jobs
  WHERE user_id = p_user_id
    AND status IN ('resolving', 'downloading', 'processing');

  v_slots := GREATEST(0, p_limit - v_active);
  IF v_slots = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.media_download_jobs j
    WHERE j.user_id = p_user_id
      AND j.status = 'queued'
    ORDER BY j.created_at ASC, j.id ASC
    LIMIT v_slots
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.media_download_jobs j
  SET status = 'resolving',
      claimed_at = now(),
      claimed_by = p_worker_id,
      attempts = j.attempts + 1,
      updated_at = now()
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_download_jobs(TEXT, UUID, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_download_jobs(TEXT, UUID, INT)
  TO service_role;
