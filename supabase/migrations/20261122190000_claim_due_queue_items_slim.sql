-- Spec 224: slim claim_due_queue_items (index join keys / slim the LATERAL).
--
-- Disk IO investigation, 2026-11-22: claim_due_queue_items runs 12 times
-- per worker tick at ~1.1-1.6s per call. The cost is not the projection
-- (spec 211 already narrowed it to (id, destination_id)) but the
-- per-row entitlement gate: the pre-224 body evaluated
-- can_publish_for / workspace_has_active_period once per due
-- queue_items ROW, in TWO passes (the D5 snapshot's due predicate and
-- the ranked selection's), although the gate's inputs are
-- destination-scoped — the same destination's rows re-ran the same
-- gate work over and over. EXPLAIN (ANALYZE, BUFFERS) on the spec 138
-- rig's scale seed proved it: the due predicate runs in ~38ms without
-- the gate and ~2.6s with it, per pass; auto_explain on a full claim
-- call attributes ~15.5s to the snapshot pass and ~15.2s to the ranked
-- pass (cold, logging overhead included) — the two due-predicate
-- passes are essentially the whole call.
--
-- This migration re-creates ONLY claim_due_queue_items (CREATE OR
-- REPLACE — the return shape is unchanged, so no DROP is needed):
--   1. The entitlement gate is evaluated ONCE per due destination, in
--      a pg_temp.claim224_gate snapshot built before the D5 snapshot:
--      can_publish_for runs only for destinations with unmarked due
--      items, workspace_has_active_period only for destinations with
--      marked due items. The D5 snapshot reads its due set from the
--      gate table, and the ranked selection reads the stored booleans
--      instead of calling the gate functions a second time. Same due
--      set, same order, same claimed rows — only the cost changes.
--   2. The per-(destination x rule) LATERAL over
--      d.metadata -> 'claim_limits' becomes a once-per-destination
--      overrides CTE (first matching override per metric + window, in
--      array order — the pre-224 LATERAL's semantics, unchanged).
-- The 3-day rate_limited flip, the D5 snapshot, the deferral and the
-- ranked selection are the 20261121135516 (spec 216) body verbatim.
-- SECURITY DEFINER posture and service-role-only ACLs are unchanged.
-- claim_publish_now_items and claim_posting_slot_item are NOT touched.
--
-- Indexes checked, none added: the RPC's join keys are already served
-- (queue_items (platform, status, scheduled_time) and
-- (destination_id, status); publish_logs (destination_id) and
-- (destination_id, result, created_at); destinations / social_accounts /
-- media_items PKs; destination_claim_limits PK). Candidate covering
-- indexes — publish_logs (destination_id, created_at) INCLUDE (result)
-- and queue_items (platform, status, scheduled_time, kind) INCLUDE
-- (destination_id, media_item_id, media_url, publish_now_requested_at)
-- — were built on the rig's scale seed and the plans did not use
-- either (identical plan shape and cost with and without them), so
-- neither is added: the cost is the gate calls, not the joins.
-- Do NOT merge before the Supabase move completes: this migration must
-- land on the new database (newdb), not the source being frozen.

CREATE OR REPLACE FUNCTION public.claim_due_queue_items(p_platform platform, p_lane_kind_set text[], p_limit integer DEFAULT 500, p_max_per_destination integer DEFAULT 3)
 RETURNS TABLE(id uuid, destination_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INT := LEAST(GREATEST(1, COALESCE(p_limit, 500)), 1000);
BEGIN
  -- (a) 3-day rate_limited flip (migration 20261102160000, spec 216):
  -- ANY destination whose 3-day window has elapsed returns to 'active'
  -- with the anchor cleared, in this same transaction — queue or no
  -- queue. Previously the flip required a due queued item for this
  -- platform, so a rate_limited page with an empty queue stayed
  -- rate_limited forever. There is no cooldown column anymore: the
  -- anchor is metadata.rate_limited_at, with updated_at as the
  -- legacy-only fallback. Nothing recovers a page early.
  UPDATE public.destinations d
  SET status = 'active',
      metadata = d.metadata - 'rate_limited_at',
      updated_at = now()
  WHERE d.status = 'rate_limited'
    AND d.platform = p_platform
    AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days';

  -- (gate) Spec 224: per-destination entitlement gate, evaluated ONCE
  -- per due destination and reused by the snapshot below and by pass
  -- (c). The gate's inputs are destination-scoped (workspace, platform,
  -- destination key, section) plus the per-item publish-now flag, so
  -- evaluating it once per queue_items row — as the pre-224 body did in
  -- both the snapshot and the ranked selection — re-ran the same
  -- can_publish_for / workspace_has_active_period work for every due
  -- item of a destination, in two full passes over the due set. Here
  -- each gate function runs once per destination, and only for the
  -- branch the destination actually has items in: can_publish_for only
  -- when it has unmarked due items, workspace_has_active_period only
  -- when it has marked due items. A destination enters the gate table
  -- iff at least one of its due items passes its branch — exactly the
  -- per-row predicate of the pre-224 body, factored by destination.
  -- The gate is stable across this transaction: the flip in step (a)
  -- touches only destinations.status (rate_limited -> active, never
  -- 'disconnected', which is all the gate reads of destinations), and
  -- the deferral in step (b) touches only queue_items.scheduled_time
  -- (never read by the gate) — so pass (c) reading these stored
  -- booleans sees the same answers as re-evaluating per row.
  -- ON COMMIT DROP leaves nothing behind; the drop-guard makes
  -- repeated calls inside one transaction safe.
  DROP TABLE IF EXISTS pg_temp.claim224_gate;
  CREATE TEMP TABLE pg_temp.claim224_gate ON COMMIT DROP AS
  WITH due_candidates AS (
    SELECT
      qi.destination_id,
      BOOL_OR(qi.publish_now_requested_at IS NULL) AS has_unmarked,
      BOOL_OR(qi.publish_now_requested_at IS NOT NULL) AS has_marked
    FROM public.queue_items qi
    INNER JOIN public.destinations d
      ON d.id = qi.destination_id
    INNER JOIN public.social_accounts sa
      ON sa.id = d.account_id
    LEFT JOIN public.media_items mi
      ON mi.id = qi.media_item_id
    WHERE qi.status = 'queued'
      AND qi.scheduled_time <= now()
      AND qi.platform = p_platform
      AND (p_lane_kind_set IS NULL OR cardinality(p_lane_kind_set) = 0 OR qi.kind = ANY (p_lane_kind_set))
      AND sa.status = 'active'
      -- Audit BG4 remainder: a Facebook token whose expiry date has
      -- passed is lapsed even if the refresh job has not flipped the
      -- account status yet. Do not claim such rows at all (they stay
      -- queued until reconnect + slot claim); other platforms keep
      -- the status-only rule because their tokens may be refreshable.
      AND (p_platform <> 'facebook' OR sa.token_expires_at IS NULL OR sa.token_expires_at > now())
      AND (
        d.status = 'active'
        OR (d.status = 'rate_limited' AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days')
      )
      AND (
        qi.kind = 'text'
        OR qi.media_url IS NOT NULL
        OR (qi.media_item_id IS NOT NULL AND mi.id IS NOT NULL)
      )
    GROUP BY qi.destination_id
  ),
  gate_unmarked AS (
    SELECT
      dc.destination_id,
      public.can_publish_for(d.workspace_id, d.platform::text, COALESCE(d.external_destination_id, d.id::text), now(), d.section) AS can_publish
    FROM due_candidates dc
    INNER JOIN public.destinations d
      ON d.id = dc.destination_id
    WHERE dc.has_unmarked
  ),
  gate_marked AS (
    SELECT
      dc.destination_id,
      public.workspace_has_active_period(d.workspace_id) AS has_active_period
    FROM due_candidates dc
    INNER JOIN public.destinations d
      ON d.id = dc.destination_id
    WHERE dc.has_marked
  )
  SELECT
    dc.destination_id,
    COALESCE(gu.can_publish, FALSE) AS can_publish,
    COALESCE(gm.has_active_period, FALSE) AS has_active_period
  FROM due_candidates dc
  LEFT JOIN gate_unmarked gu
    ON gu.destination_id = dc.destination_id
  LEFT JOIN gate_marked gm
    ON gm.destination_id = dc.destination_id
  WHERE (dc.has_unmarked AND COALESCE(gu.can_publish, FALSE))
     OR (dc.has_marked AND COALESCE(gm.has_active_period, FALSE));

  -- (snapshot) Per-call D5 usage snapshot: one row per (due destination
  -- x applicable rule), computed ONCE here and read by both pass (b) and
  -- pass (c) below. The drop-guard makes repeated calls inside one
  -- transaction safe; ON COMMIT DROP leaves nothing behind. Referenced
  -- as pg_temp.… because the function sets search_path = public.
  DROP TABLE IF EXISTS pg_temp.claim138_rule_usage;
  CREATE TEMP TABLE pg_temp.claim138_rule_usage ON COMMIT DROP AS
  WITH due_destinations AS (
    -- One row per due destination, from the spec 224 gate table above.
    -- (Qualified: the function's RETURNS TABLE declares an OUT
    -- parameter named destination_id, so a bare reference here is
    -- ambiguous in PL/pgSQL.)
    SELECT gate.destination_id
    FROM pg_temp.claim224_gate gate
  ),
  overrides AS (
    -- Spec 224: per-destination claim-limit overrides, computed ONCE
    -- per destination instead of once per (destination x rule) via the
    -- LATERAL in the pre-224 rules CTE. First matching override per
    -- (metric, window_seconds) wins, in claim_limits array order
    -- (ROW_NUMBER over the array ordinality); the validation guards
    -- (array shape, numeric window_seconds/cap, cap > 0) are the
    -- pre-224 LATERAL's, unchanged.
    SELECT o.destination_id, o.metric, o.window_seconds, o.override_cap
    FROM (
      SELECT
        dd.destination_id,
        elem ->> 'metric' AS metric,
        (elem ->> 'window_seconds')::INT AS window_seconds,
        (elem ->> 'cap')::INT AS override_cap,
        ROW_NUMBER() OVER (
          PARTITION BY dd.destination_id, elem ->> 'metric', (elem ->> 'window_seconds')::INT
          ORDER BY elem_ord
        ) AS rn
      FROM due_destinations dd
      INNER JOIN public.destinations d
        ON d.id = dd.destination_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.metadata -> 'claim_limits') = 'array'
             THEN d.metadata -> 'claim_limits'
             ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS elem(elem, elem_ord)
      WHERE (elem ->> 'metric') IS NOT NULL
        AND (elem ->> 'window_seconds') ~ '^[0-9]+$'
        AND (elem ->> 'cap') ~ '^[0-9]+$'
        AND (elem ->> 'cap')::INT > 0
    ) o
    WHERE o.rn = 1
  ),
  rules AS (
    SELECT
      dd.destination_id,
      lr.metric,
      lr.window_seconds,
      COALESCE(ov.override_cap, lr.cap) AS cap
    FROM due_destinations dd
    INNER JOIN public.destination_claim_limits lr
      ON lr.platform = p_platform
    LEFT JOIN overrides ov
      ON ov.destination_id = dd.destination_id
     AND ov.metric = lr.metric
     AND ov.window_seconds = lr.window_seconds
  ),
  log_usage AS (
    -- ONE grouped pass over publish_logs. The counted set is defined per
    -- rule — the window length and the metric filter are properties of
    -- the rule row — so both are per-row join predicates and the grouped
    -- result is the counted set by definition: 'calls' counts ALL
    -- publish_logs rows in the window, 'published' only result =
    -- 'success' rows.
    SELECT
      r.destination_id,
      r.metric,
      r.window_seconds,
      COUNT(*) AS log_count,
      MIN(pl.created_at) AS oldest_log_at
    FROM rules r
    INNER JOIN public.publish_logs pl
      ON pl.destination_id = r.destination_id
     AND pl.created_at > now() - make_interval(secs => r.window_seconds)
     AND (r.metric = 'calls' OR pl.result = 'success')
    GROUP BY r.destination_id, r.metric, r.window_seconds
  ),
  inflight_usage AS (
    -- ONE grouped pass over in-flight queue_items, grouped by
    -- destination only (the values are rule-independent: in-flight rows
    -- count into EVERY rule's total, with NO window filter — an
    -- in-flight item counts however old its claim is).
    SELECT
      q.destination_id,
      COUNT(*) AS inflight_count,
      MIN(COALESCE(q.claimed_at, q.updated_at)) AS oldest_inflight_at
    FROM public.queue_items q
    INNER JOIN due_destinations dd ON dd.destination_id = q.destination_id
    WHERE q.status = 'publishing'
    GROUP BY q.destination_id
  )
  SELECT
    r.destination_id,
    r.metric,
    r.window_seconds,
    r.cap,
    COALESCE(lu.log_count, 0) AS log_count,
    COALESCE(iu.inflight_count, 0) AS inflight_count,
    lu.oldest_log_at,
    iu.oldest_inflight_at
  FROM rules r
  LEFT JOIN log_usage lu
    ON lu.destination_id = r.destination_id
   AND lu.metric = r.metric
   AND lu.window_seconds = r.window_seconds
  LEFT JOIN inflight_usage iu
    ON iu.destination_id = r.destination_id;

  -- (b) D5 deferral: destinations at cap for any configured rule have
  -- their due queued items rescheduled to the window end — once per
  -- destination per call, before claim selection, inside this
  -- transaction. Usage values are read from the snapshot; every formula
  -- below is the spec 121 formula verbatim.
  WITH binding AS (
    SELECT
      ru.destination_id,
      GREATEST(
        COALESCE(
          LEAST(ru.oldest_log_at, ru.oldest_inflight_at),
          ru.oldest_log_at,
          ru.oldest_inflight_at,
          now()
        ) + make_interval(secs => ru.window_seconds),
        now() + INTERVAL '1 minute'
      ) AS release_at
    FROM pg_temp.claim138_rule_usage ru
    WHERE ru.log_count + ru.inflight_count >= ru.cap
  ),
  release AS (
    SELECT b.destination_id, MAX(b.release_at) AS release_at
    FROM binding b
    GROUP BY b.destination_id
  ),
  targets AS (
    SELECT qi.id, qi.destination_id
    FROM public.queue_items qi
    INNER JOIN release r
      ON r.destination_id = qi.destination_id
    WHERE qi.status = 'queued'
      AND qi.scheduled_time <= now()
      AND qi.platform = p_platform
      AND (p_lane_kind_set IS NULL OR cardinality(p_lane_kind_set) = 0 OR qi.kind = ANY (p_lane_kind_set))
    FOR UPDATE OF qi SKIP LOCKED
  )
  UPDATE public.queue_items qi
  SET scheduled_time = r.release_at,
      updated_at = now()
  FROM targets t
  INNER JOIN release r
    ON r.destination_id = t.destination_id
  WHERE qi.id = t.id;

  -- (c) Claim selection: the spec 120 ranked selection, unchanged except
  -- that the per-destination rank cap is additionally bounded by the
  -- destination's smallest remaining D5 headroom (no headroom row = no
  -- configured cap = unbounded), with counted_total read from the
  -- snapshot. At-cap destinations were deferred in step (b), so their
  -- items are no longer due here.
  RETURN QUERY
  WITH ranked_due AS (
    SELECT
      qi.id AS queue_id,
      qi.destination_id AS destination_id,
      ROW_NUMBER() OVER (
        PARTITION BY qi.destination_id
        ORDER BY qi.scheduled_time ASC, qi.id ASC
      ) AS destination_rank,
      qi.scheduled_time AS item_scheduled_time
    FROM public.queue_items qi
    INNER JOIN public.destinations d
      ON d.id = qi.destination_id
    INNER JOIN public.social_accounts sa
      ON sa.id = d.account_id
    LEFT JOIN public.media_items mi
      ON mi.id = qi.media_item_id
    -- Spec 224: the entitlement gate is read from the
    -- pg_temp.claim224_gate snapshot (one row per due destination)
    -- instead of re-evaluating can_publish_for /
    -- workspace_has_active_period per due row — same answers, same
    -- transaction (see the gate comment above), no second pass of
    -- gate calls.
    INNER JOIN pg_temp.claim224_gate g
      ON g.destination_id = qi.destination_id
    WHERE qi.status = 'queued'
      AND qi.scheduled_time <= now()
      AND qi.platform = p_platform
      AND (p_lane_kind_set IS NULL OR cardinality(p_lane_kind_set) = 0 OR qi.kind = ANY (p_lane_kind_set))
      AND sa.status = 'active'
      -- Audit BG4 remainder: a Facebook token whose expiry date has
      -- passed is lapsed even if the refresh job has not flipped the
      -- account status yet. Do not claim such rows at all (they stay
      -- queued until reconnect + slot claim); other platforms keep
      -- the status-only rule because their tokens may be refreshable.
      AND (p_platform <> 'facebook' OR sa.token_expires_at IS NULL OR sa.token_expires_at > now())
      AND (
        d.status = 'active'
        OR (d.status = 'rate_limited' AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days')
      )
      -- Entitlement pause (audit fix 2026-11-01; C4): the per-item
      -- branch of the gate, read from the spec 224 snapshot — an
      -- unmarked row needs the destination's can_publish answer, a
      -- marked publish-now row needs its workspace's active period.
      -- Same predicate as the pre-224 body, with the gate functions
      -- evaluated once per destination in the snapshot instead of
      -- once per due row here.
      AND ((qi.publish_now_requested_at IS NULL AND g.can_publish) OR (qi.publish_now_requested_at IS NOT NULL AND g.has_active_period))
      AND (
        qi.kind = 'text'
        OR qi.media_url IS NOT NULL
        OR (qi.media_item_id IS NOT NULL AND mi.id IS NOT NULL)
      )
  ),
  rule_usage AS (
    SELECT
      snap.destination_id,
      snap.cap,
      (snap.log_count + snap.inflight_count) AS counted_total
    FROM pg_temp.claim138_rule_usage snap
    WHERE snap.destination_id IN (SELECT DISTINCT rd0.destination_id FROM ranked_due rd0)
  ),
  headroom AS (
    SELECT
      ru.destination_id,
      MIN(ru.cap - ru.counted_total)::INT AS headroom
    FROM rule_usage ru
    GROUP BY ru.destination_id
  ),
  candidate_ids AS (
    SELECT q.id
    FROM public.queue_items q
    INNER JOIN ranked_due rd ON rd.queue_id = q.id
    LEFT JOIN headroom h ON h.destination_id = rd.destination_id
    WHERE rd.destination_rank <= LEAST(
            GREATEST(1, p_max_per_destination),
            COALESCE(h.headroom, GREATEST(1, p_max_per_destination))
          )
      AND q.status = 'queued'
    ORDER BY rd.item_scheduled_time ASC, q.id ASC
    LIMIT v_limit
    FOR UPDATE OF q SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.queue_items qi
    SET status = 'publishing',
        claimed_at = now(),
        updated_at = now()
    FROM candidate_ids c
    WHERE qi.id = c.id
    RETURNING qi.*
  )
  SELECT c.id, c.destination_id
  FROM claimed c
  ORDER BY c.scheduled_time ASC, c.id ASC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) TO service_role;
