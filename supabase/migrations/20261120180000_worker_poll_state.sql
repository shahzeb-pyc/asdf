-- =============================================================================
-- Migration: 20261120180000_worker_poll_state.sql
-- Spec: 212 Polling backoff when idle
-- Purpose:
--   1. Create worker_poll_state — a singleton row (id = 1) the worker's
--      per-minute tick uses to back off while idle: last_full_tick_at
--      (when the last full sub-tick block ran), last_activity_at
--      (when a full tick last found work), and current_interval_seconds
--      (the backoff interval: 60s, doubled after each full tick that
--      finds nothing, up to the 240s hard cap, reset to 60s on
--      activity). The gate runs a full tick whenever the interval has
--      elapsed, on recovery minutes, or when no state exists yet.
--   2. The web internal health tier reads last_full_tick_at to prove
--      the gate is still running full ticks (stale if > 300s old), so
--      a stuck gate is loud instead of hiding behind the per-minute
--      heartbeat.
--   3. RLS enabled with NO public policies: only the service role (which
--      bypasses RLS) may read or write. Anon/authenticated get nothing.
--      Same pattern as worker_heartbeats (20261022000000).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.worker_poll_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_full_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Current backoff interval in seconds. Doubled after each full tick
  -- that finds nothing (60 → 120 → 240), reset to 60 when a tick
  -- finds work. Stored, not derived: deriving it from idle time makes
  -- the interval a moving target that the elapsed time can never
  -- catch (the 60s/120s steps would never fire and every idle gap
  -- would be the 240s cap from the start). Bounded by the CHECK to the
  -- hard cap — 240s, strictly below the 5-minute slot window.
  current_interval_seconds INT NOT NULL DEFAULT 60
    CHECK (current_interval_seconds >= 60 AND current_interval_seconds <= 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.worker_poll_state ENABLE ROW LEVEL SECURITY;

-- No policies are created on purpose: with RLS enabled and zero policies,
-- anon and authenticated roles are denied all access. The worker and the
-- web internal health check both use the service-role client.
REVOKE ALL ON TABLE public.worker_poll_state FROM anon, authenticated;
GRANT ALL ON TABLE public.worker_poll_state TO service_role;

DROP TRIGGER IF EXISTS trg_worker_poll_state_updated_at ON public.worker_poll_state;
CREATE TRIGGER trg_worker_poll_state_updated_at
  BEFORE UPDATE ON public.worker_poll_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
