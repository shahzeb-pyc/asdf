-- Spec 211 (Supabase egress fix 2 of 4): claim_due_queue_items returns
-- only the item id.
--
-- The claim RPC used to return the full 29-column joined row
-- (queue-item columns + destination/account/media joins, including
-- caption, platform_options, both encrypted tokens and media_url) on
-- every claim call, up to 500 rows per call, up to 12 calls per tick.
-- Its only production consumer is the worker claimer
-- (apps/worker/src/claimer.ts, claimAndEnqueueLane): it reads exactly
-- `row.id`, builds a { itemId, platform, lane } queue message validated
-- by PublishQueueMessageSchema, and never touches another column — the
-- full item/account/destination rows are re-loaded by the consumers
-- before publishing. The slot-claim and publish-now ticks consume
-- claim_posting_slot_item / claim_publish_now_items, not this RPC.
--
-- This migration therefore narrows the return projection to `id` only.
-- The claim/deferral/selection body is the LIVE prod body from
-- 20261113060000_claim_rpc_section.sql, copied verbatim: same signature
-- and defaults, same p_limit 1000 hard cap, same SECURITY DEFINER
-- posture, same service-role-only ACLs, same 3-day rate_limited flip,
-- same D5 grouped-usage snapshot, same deferral and ranked selection.
-- Only the RETURNS TABLE list and the final SELECT change (the
-- destination/account/media joins in the final SELECT existed only to
-- populate the dropped columns). The return-type change forbids CREATE
-- OR REPLACE, so the old signature is DROPped first, as in spec 174.
-- No other function is dropped or redefined here.

DROP FUNCTION IF EXISTS public.claim_due_queue_items(public.platform, TEXT[], INT, INT);

CREATE OR REPLACE FUNCTION public.claim_due_queue_items(p_platform platform, p_lane_kind_set text[], p_limit integer DEFAULT 500, p_max_per_destination integer DEFAULT 3)
 RETURNS TABLE(id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INT := LEAST(GREATEST(1, COALESCE(p_limit, 500)), 1000);
BEGIN
  -- (a) 3-day rate_limited flip (migration 20261102160000): destinations
  -- evaluated by this call (due queued item for this platform) whose
  -- 3-day window has elapsed return to 'active' with the anchor
  -- cleared, in this same transaction. There is no cooldown column
  -- anymore: the anchor is metadata.rate_limited_at, with updated_at
  -- as the legacy-only fallback. Nothing recovers a page early.
  UPDATE public.destinations d
  SET status = 'active',
      metadata = d.metadata - 'rate_limited_at',
      updated_at = now()
  WHERE d.status = 'rate_limited'
    AND d.platform = p_platform
    AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days'
    AND EXISTS (
      SELECT 1
      FROM public.queue_items qi
      WHERE qi.destination_id = d.id
        AND qi.status = 'queued'
        AND qi.scheduled_time <= now()
        AND qi.platform = p_platform
    );

  -- (snapshot) Per-call D5 usage snapshot: one row per (due destination
  -- x applicable rule), computed ONCE here and read by both pass (b) and
  -- pass (c) below. The drop-guard makes repeated calls inside one
  -- transaction safe; ON COMMIT DROP leaves nothing behind. Referenced
  -- as pg_temp.… because the function sets search_path = public.
  DROP TABLE IF EXISTS pg_temp.claim138_rule_usage;
  CREATE TEMP TABLE pg_temp.claim138_rule_usage ON COMMIT DROP AS
  WITH due_destinations AS (
    SELECT DISTINCT qi.destination_id
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
      -- Entitlement pause (audit fix 2026-11-01; C4): one
      -- shared workspace_has_active_period function — the owning
      -- workspace's owner must have an active, non-superseded
      -- period; admin owners are exempt. A workspace with no
      -- resolvable owner fails closed.
      AND ((qi.publish_now_requested_at IS NULL AND public.can_publish_for(d.workspace_id, d.platform::text, COALESCE(d.external_destination_id, d.id::text), now(), d.section)) OR (qi.publish_now_requested_at IS NOT NULL AND public.workspace_has_active_period(d.workspace_id)))
      AND (
        qi.kind = 'text'
        OR qi.media_url IS NOT NULL
        OR (qi.media_item_id IS NOT NULL AND mi.id IS NOT NULL)
      )
  ),
  rules AS (
    SELECT
      dd.destination_id,
      lr.metric,
      lr.window_seconds,
      COALESCE(ov.override_cap, lr.cap) AS cap
    FROM due_destinations dd
    INNER JOIN public.destinations d
      ON d.id = dd.destination_id
    INNER JOIN public.destination_claim_limits lr
      ON lr.platform = p_platform
    LEFT JOIN LATERAL (
      SELECT (elem ->> 'cap')::INT AS override_cap
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.metadata -> 'claim_limits') = 'array'
             THEN d.metadata -> 'claim_limits'
             ELSE '[]'::jsonb
        END
      ) AS elem
      WHERE elem ->> 'metric' = lr.metric
        AND (elem ->> 'window_seconds') ~ '^[0-9]+$'
        AND (elem ->> 'window_seconds')::INT = lr.window_seconds
        AND (elem ->> 'cap') ~ '^[0-9]+$'
        AND (elem ->> 'cap')::INT > 0
      LIMIT 1
    ) ov ON TRUE
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
      -- Entitlement pause (audit fix 2026-11-01; C4): one
      -- shared workspace_has_active_period function — the owning
      -- workspace's owner must have an active, non-superseded
      -- period; admin owners are exempt. A workspace with no
      -- resolvable owner fails closed.
      AND ((qi.publish_now_requested_at IS NULL AND public.can_publish_for(d.workspace_id, d.platform::text, COALESCE(d.external_destination_id, d.id::text), now(), d.section)) OR (qi.publish_now_requested_at IS NOT NULL AND public.workspace_has_active_period(d.workspace_id)))
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
  SELECT c.id
  FROM claimed c
  ORDER BY c.scheduled_time ASC, c.id ASC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) TO service_role;
