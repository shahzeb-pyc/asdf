-- =============================================================================
-- Spec 139 residue — 30-day retention for publish history (publish_logs +
-- queue_items). Shahzeb ruled 2026-10-24: history is retained 30 DAYS.
-- CTO analysis (spec 139) ceiling #3: these are the two unbounded-growth
-- tables; at certified volume they are the first storage wall.
--
-- This migration adds:
--   1. The two indexes that make the retention predicates index-supported:
--        - idx_publish_logs_created_at (plain, on created_at) — the logs
--          pass scans by age; the existing publish_logs indexes lead with
--          queue_item_id / destination_id and cannot serve an age scan.
--        - idx_queue_items_terminal_updated_at — a PARTIAL index on
--          queue_items (updated_at) covering exactly the terminal
--          statuses, so the items pass never scans live rows.
--      Plain CREATE INDEX (not CONCURRENTLY), following the db-hygiene
--      migration (20261023193000): Supabase migrations run in a
--      transaction, where CONCURRENTLY is impossible; both tables are
--      small today, and the partial index stays small by construction.
--   2. public.cleanup_expired_publish_history(p_cutoff, p_batch_size,
--      p_dry_run) — ONE bounded batch round per call:
--        - publish_logs pass: deletes up to p_batch_size log rows older
--          than p_cutoff whose parent queue item is in a TERMINAL state
--          (published / failed / cancelled). Logs of live items
--          (queued / publishing) are never touched, however old: a live
--          item keeps its full attempt history until it terminates.
--        - queue_items pass: deletes up to p_batch_size TERMINAL items
--          whose updated_at (their terminal timestamp — the row is never
--          written after it settles, and spec 139's settle hardening
--          guards terminal states against re-settling) is older than
--          p_cutoff. Any of their remaining logs cascade
--          (publish_logs.queue_item_id ON DELETE CASCADE).
--      Live rows are excluded by a whitelist of terminal statuses, not
--      by blacklisting live ones, so any future non-terminal status is
--      protected by construction. Each call is its own transaction, so
--      row locks are released between batches; the worker cron loops
--      calls until a short batch comes back or its per-run cap hits
--      (see apps/worker/src/retention.ts). The function is IDEMPOTENT:
--      the predicates only ever match expired rows, so a re-run after a
--      partial run simply continues, and a run with nothing expired
--      deletes 0.
--        - p_dry_run = true: no DELETEs; returns the FULL counts the
--          two predicates match (not batch-limited), for ops
--          verification of what a real run would remove.
--
-- ACLs follow the spec 117/120 RPC pattern: REVOKE EXECUTE from
-- PUBLIC / anon / authenticated, GRANT EXECUTE to service_role only
-- (the worker's cleanup job is the sole caller). search_path pinned.
-- No data changes beyond the cleanup the function performs when called.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Indexes backing the retention predicates.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_publish_logs_created_at
  ON public.publish_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_queue_items_terminal_updated_at
  ON public.queue_items (updated_at)
  WHERE status IN ('published', 'failed', 'cancelled');

-- -----------------------------------------------------------------------------
-- 2. Bounded-batch cleanup function (one batch round per call).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_publish_history(
  p_cutoff TIMESTAMPTZ,
  p_batch_size INT DEFAULT 1000,
  p_dry_run BOOLEAN DEFAULT false
)
RETURNS TABLE (publish_logs_deleted BIGINT, queue_items_deleted BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_size INT := GREATEST(COALESCE(p_batch_size, 1000), 1);
  v_logs BIGINT := 0;
  v_items BIGINT := 0;
BEGIN
  IF p_dry_run THEN
    -- Count-only mode: the full predicate counts (not batch-limited),
    -- so an operator can see exactly what a real run would remove.
    SELECT count(*) INTO v_logs
    FROM public.publish_logs pl
    JOIN public.queue_items qi ON qi.id = pl.queue_item_id
    WHERE pl.created_at < p_cutoff
      AND qi.status IN ('published', 'failed', 'cancelled');

    SELECT count(*) INTO v_items
    FROM public.queue_items qi
    WHERE qi.status IN ('published', 'failed', 'cancelled')
      AND qi.updated_at < p_cutoff;

    RETURN QUERY SELECT v_logs, v_items;
    RETURN;
  END IF;

  -- Pass 1 — publish_logs: expired attempt history of TERMINAL items.
  -- Logs are deleted before items so a same-run item deletion only has
  -- to cascade whatever logs are younger than the cutoff.
  DELETE FROM public.publish_logs pl
  WHERE pl.id IN (
    SELECT pl2.id
    FROM public.publish_logs pl2
    JOIN public.queue_items qi ON qi.id = pl2.queue_item_id
    WHERE pl2.created_at < p_cutoff
      AND qi.status IN ('published', 'failed', 'cancelled')
    ORDER BY pl2.created_at
    LIMIT v_batch_size
  );
  GET DIAGNOSTICS v_logs = ROW_COUNT;

  -- Pass 2 — queue_items: TERMINAL items past the retention window.
  -- The whitelist is the safety property: queued / publishing rows can
  -- never match, at any age.
  DELETE FROM public.queue_items qi
  WHERE qi.id IN (
    SELECT qi2.id
    FROM public.queue_items qi2
    WHERE qi2.status IN ('published', 'failed', 'cancelled')
      AND qi2.updated_at < p_cutoff
    ORDER BY qi2.updated_at
    LIMIT v_batch_size
  );
  GET DIAGNOSTICS v_items = ROW_COUNT;

  RETURN QUERY SELECT v_logs, v_items;
  RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_publish_history(TIMESTAMPTZ, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_publish_history(TIMESTAMPTZ, INT, BOOLEAN) TO service_role;
