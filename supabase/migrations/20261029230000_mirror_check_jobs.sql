-- Mirror-check jobs: the DATABASE queue for scaled TikTok mirror checks.
--
-- Why a database queue instead of Cloudflare Queues: the mirror
-- check already follows the app's Pages-posting pattern (rows +
-- atomic claim + retry counts), and a database queue costs $0
-- extra — the same Supabase project already in use — where
-- Cloudflare Queues would charge per-operation overage at
-- 10,000-mirror scale. No queue-creation deploy step remains:
-- applying this migration is the only deploy requirement, and
-- it uses the normal manual migration process.
--
-- Lifecycle of a job:
--   pending    — dispatched, waiting for its available_at slot
--                (the dispatcher paces jobs ~3/second via
--                available_at, so feed checks land at a steady
--                ~180/minute instead of one 10,000-strong burst).
--   processing — claimed by a minute tick; the claim is a single
--                atomic UPDATE ... FOR UPDATE SKIP LOCKED, so two
--                ticks can never grab the same job.
--   (deleted)  — a finished job is DELETED, like a queue ack:
--                at 10,000 mirrors/hour, keeping finished rows
--                would grow the table by ~7M rows/month.
--   exhausted  — kept as the dead-letter record: a job whose
--                transport/DB failures used all 3 attempts. Its
--                mirror is stamped error at exhaustion time, so
--                the failure is visible instead of silent.
--   A stale processing job (claimed over 30 minutes ago, worker
--   died mid-check) is reclaimed by a later tick when attempts
--   remain; when attempts are used up it is exhausted instead.
--   Per-mirror business failures (feed down, resolve failure,
--   publish rejection) are NOT job failures: the check stamps
--   them as mirror errors itself and the job completes.
--
-- One live job per mirror: the partial unique index below means
-- a re-dispatch (e.g. after a failed next_check_at advance)
-- inserts nothing for a mirror that already holds a live job —
-- enqueue uses ON CONFLICT DO NOTHING against this index.
-- Exhausted rows do NOT block a future job for the same mirror.
--
-- This migration creates ONLY the table, indexes, and two
-- functions. It is fully idempotent (IF NOT EXISTS / OR
-- REPLACE throughout), so re-applying is a safe no-op.
-- RLS is enabled with no permissive policies, matching the
-- other server-only tables (e.g. mirrors): only the service
-- role used by the worker reaches this table.
--
-- NOT APPLIED to any database by the branch author: migrations
-- stay manual. The worker version that consumes this queue
-- must NOT deploy before this migration is applied — without
-- the table and functions, mirror checks cannot run (unlike
-- the tikwmapi pause table, there is no degraded mode here:
-- the queue IS the transport).

CREATE TABLE IF NOT EXISTS public.mirror_check_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mirror_id uuid NOT NULL REFERENCES public.mirrors(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'exhausted')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mirror_check_jobs IS
  'Database queue for scaled TikTok mirror checks: one live job per mirror, atomic claim, 3 attempts, exhausted rows are the dead-letter record. Finished jobs are deleted (queue ack).';

-- Partial unique index: one LIVE job per mirror. Exhausted rows
-- are terminal history and must not block a future job.
CREATE UNIQUE INDEX IF NOT EXISTS mirror_check_jobs_live_mirror_idx
  ON public.mirror_check_jobs (mirror_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS mirror_check_jobs_due_idx
  ON public.mirror_check_jobs (status, available_at, id);

ALTER TABLE public.mirror_check_jobs ENABLE ROW LEVEL SECURITY;

-- Enqueue jobs idempotently: a mirror that already holds a live
-- job is skipped (ON CONFLICT DO NOTHING), never duplicated.
-- Returns the number of newly inserted jobs.
CREATE OR REPLACE FUNCTION public.enqueue_mirror_check_jobs(
  p_jobs JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job JSONB;
  inserted_count INTEGER := 0;
BEGIN
  FOR job IN SELECT * FROM jsonb_array_elements(p_jobs) LOOP
    INSERT INTO public.mirror_check_jobs (mirror_id, available_at)
    VALUES (
      (job ->> 'mirror_id')::UUID,
      (job ->> 'available_at')::TIMESTAMPTZ
    )
    ON CONFLICT (mirror_id) WHERE status IN ('pending', 'processing') DO NOTHING;
    IF FOUND THEN
      inserted_count := inserted_count + 1;
    END IF;
  END LOOP;
  RETURN inserted_count;
END;
$$;

-- Atomically claim due jobs for one consumer tick. A job is
-- claimable when its available_at slot has arrived and it is
-- pending, or when it is a stale processing job (claimed over
-- p_stale_after_seconds ago) with attempts remaining. Stale
-- processing jobs that already used all attempts are exhausted
-- in the same transaction instead of being reclaimed, so a dead
-- worker can never spin a job past its attempt budget.
-- FOR UPDATE SKIP LOCKED makes concurrent ticks disjoint: two
-- ticks claiming at once never receive the same job.
CREATE OR REPLACE FUNCTION public.claim_mirror_check_jobs(
  p_limit INTEGER,
  p_now TIMESTAMPTZ,
  p_stale_after_seconds INTEGER
)
RETURNS SETOF public.mirror_check_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.mirror_check_jobs
  SET status = 'exhausted',
      error = 'Mirror check worker did not report back after the final attempt.',
      updated_at = p_now
  WHERE status = 'processing'
    AND attempts >= 3
    AND claimed_at < p_now - make_interval(secs => p_stale_after_seconds);

  RETURN QUERY
  UPDATE public.mirror_check_jobs
  SET status = 'processing',
      claimed_at = p_now,
      attempts = attempts + 1,
      updated_at = p_now
  WHERE id IN (
    SELECT id
    FROM public.mirror_check_jobs
    WHERE available_at <= p_now
      AND (
        status = 'pending'
        OR (
          status = 'processing'
          AND claimed_at < p_now - make_interval(secs => p_stale_after_seconds)
          AND attempts < 3
        )
      )
    ORDER BY available_at ASC, id ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;
