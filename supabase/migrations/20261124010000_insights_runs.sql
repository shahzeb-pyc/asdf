-- Insights runs: the run record for the chunked insights cycle (spec 240).
--
-- Why two tables instead of the old module-level boolean guard: the
-- manual endpoint and the 03:00 cron run on different Cloudflare
-- isolates, so a per-isolate flag could never guard across them —
-- and a cancelled ctx.waitUntil() could leave it stuck at 409
-- (verification SEND BACK on PR #330's first build). The run record
-- IS the guard: at most one row may hold status = 'running'
-- (partial unique index below), on every isolate. A second start
-- while one is live fails the insert and gets 409 (manual) or skips
-- with a log line (cron).
--
-- Lifecycle of a run:
--   running  — chunks are being consumed (or waiting in the queue).
--   finished — every chunk is terminal (done or failed); exactly one
--              consumer invocation logs the finished line with the
--              run totals (finisher election: the conditional finish
--              UPDATE matches only while status = 'running').
--   failed   — the run never started properly (enqueue threw); the
--              handler marks it failed instead of returning a 202
--              for work that never started.
--   stale    — superseded by a later start after the 2h staleness
--              threshold; a run that never finishes is visible and
--              self-clearing, never a permanent 409.
-- A chunk's status moves pending -> processing -> done, or
-- pending/processing -> failed via the DLQ consumer. Chunk
-- completion is a conditional update (only from pending/processing),
-- so a queue redelivery counts once. The header counters are written
-- by the finisher from the chunk rows, never incremented in place —
-- concurrent completions cannot lose a count.
--
-- This migration creates ONLY the tables and indexes. It is fully
-- idempotent (IF NOT EXISTS throughout), so re-applying is a safe
-- no-op. RLS is enabled with no permissive policies, matching the
-- other server-only tables (e.g. mirror_check_jobs): only the service
-- role used by the worker reaches these tables.
--
-- NOT APPLIED to any database by the branch author: migrations stay
-- manual. The worker version that consumes these tables must NOT
-- deploy before this migration is applied — without them the first
-- run fails loudly (missing table -> 500/503), never silently.

CREATE TABLE IF NOT EXISTS public.insights_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('manual', 'cron')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'finished', 'failed', 'stale')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  chunks_total int NOT NULL,
  chunks_done int NOT NULL DEFAULT 0,
  chunks_failed int NOT NULL DEFAULT 0,
  scanned int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  adu_updated int NOT NULL DEFAULT 0,
  mirrors_updated int NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.insights_runs IS
  'Run record for the chunked insights cycle (spec 240): one row per manual/cron run; the row IS the in-flight guard (at most one running).';

-- Partial unique index: at most one LIVE run. Terminal rows
-- (finished/failed/stale) never block a future run.
CREATE UNIQUE INDEX IF NOT EXISTS insights_runs_live_idx
  ON public.insights_runs ((1))
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS insights_runs_started_at_idx
  ON public.insights_runs (started_at);

CREATE TABLE IF NOT EXISTS public.insights_run_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.insights_runs(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  "offset" int NOT NULL,
  "limit" int NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  scanned int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  adu_updated int NOT NULL DEFAULT 0,
  mirrors_updated int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.insights_run_chunks IS
  'One row per chunk (200-row offset page) of an insights run: its own status and counters, so completion is provable per chunk.';

CREATE UNIQUE INDEX IF NOT EXISTS insights_run_chunks_run_chunk_idx
  ON public.insights_run_chunks (run_id, chunk_index);

CREATE INDEX IF NOT EXISTS insights_run_chunks_run_status_idx
  ON public.insights_run_chunks (run_id, status);

ALTER TABLE public.insights_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insights_run_chunks ENABLE ROW LEVEL SECURITY;
