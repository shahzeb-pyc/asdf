-- Spec 216: rate-limit auto-recovery flips even with an empty queue.
--
-- Rate-limited Facebook pages are designed to come back to active after
-- 3 days (FB_RATE_LIMITED_COOLDOWN_DAYS = 3, anchor
-- metadata.rate_limited_at, fallback updated_at). But the flip in the
-- claim functions only fired when the page had a due queued post, so a
-- rate_limited page with an empty queue stayed rate_limited forever
-- (live 2026-11-21: 22 destinations stuck, some since Nov 12).
--
-- This migration drops the due-queued-item condition from the flip in
-- all three claim functions, so any rate_limited page past the 3-day
-- cooldown flips to 'active' on the next claim tick, queue or no queue.
--
-- claim_due_queue_items: body is the spec 211 slim-projection version
-- (PR #299, migration 20261120134000 — RETURNS TABLE(id,
-- destination_id)), copied with only the flip changed. DROP + CREATE
-- because the return shape differs from the pre-211 body.
-- claim_publish_now_items: body from 20261110000000, only the flip changed.
-- claim_posting_slot_item: body from 20261113060000, re-created verbatim —
-- its flip never had a queue condition (scoped to p_destination_id), so
-- there is nothing to drop; it is included so all three claim functions
-- carry the same unconditional flip in one migration.
--
-- MERGE ORDER: this migration must apply AFTER 20261120134000 (PR #299).
-- If PR #299 merges after this PR, its migration re-creates
-- claim_due_queue_items with the old flip and this fix is silently
-- reverted — rebase #299 after this lands.
--
-- Unchanged: the anchor and 3-day cooldown (a page NOT yet past 3 days
-- stays rate_limited); clearing rate_limited_at on flip; the
-- claim-eligibility OR clauses that treat expired rate_limited pages as
-- claimable; the ADU tick; the display rule (evaluatePageHealth); error
-- statuses never auto-recover. SECURITY DEFINER posture and
-- service-role-only ACLs are re-asserted for each function below.

-- Spec 211 (Supabase egress fix 2 of 4): claim_due_queue_items returns
-- only the item id and its destination id.
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
-- before publishing. The claim-RPC parity rig (apps/worker/tests/
-- claim-rpc/parity.ts, case c6) additionally reads `destination_id`
-- from the returned rows to assert the per-destination headroom bound
-- (headroom 2 claims exactly 2 from one destination, 3 from the
-- uncapped one) — that is the only other reader, and it is why the
-- projection keeps `destination_id` alongside `id`: two UUID columns
-- instead of twenty-nine, the same egress saving in practice.
--
-- This migration therefore narrows the return projection to
-- (id, destination_id). The claim/deferral/selection body is the LIVE
-- prod body from 20261113060000_claim_rpc_section.sql, copied verbatim:
-- same signature and defaults, same p_limit 1000 hard cap, same
-- SECURITY DEFINER posture, same service-role-only ACLs, same 3-day
-- rate_limited flip, same D5 grouped-usage snapshot, same deferral and
-- ranked selection. Only the RETURNS TABLE list and the final SELECT
-- change (the destination/account/media joins in the final SELECT
-- existed only to populate the dropped columns). The return-type
-- change forbids CREATE OR REPLACE, so the old signature is DROPped
-- first, as in spec 174. No other function is dropped or redefined here.

DROP FUNCTION IF EXISTS public.claim_due_queue_items(public.platform, TEXT[], INT, INT);

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
  SELECT c.id, c.destination_id
  FROM claimed c
  ORDER BY c.scheduled_time ASC, c.id ASC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_publish_now_items(
  p_limit INT DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  kind VARCHAR,
  platform_format VARCHAR,
  destination_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INT := LEAST(GREATEST(1, COALESCE(p_limit, 100)), 1000);
BEGIN
  -- 3-day rate_limited flip, copied from the due RPC step (a) (spec 216):
  -- a destination whose 3-day window has elapsed returns to 'active'
  -- with the anchor cleared, queue or no queue, so a page the
  -- publish-now route gate already treats as active is claimable
  -- immediately. Previously the flip required a marked queued item,
  -- so a rate_limited page with an empty queue stayed rate_limited
  -- forever. The anchor is metadata.rate_limited_at, with updated_at
  -- as the legacy-only fallback. Nothing recovers a page early.
  UPDATE public.destinations d
  SET status = 'active',
      metadata = d.metadata - 'rate_limited_at',
      updated_at = now()
  WHERE d.status = 'rate_limited'
    AND d.platform = 'facebook'
    AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days';

  -- Atomic claim: oldest publish-now request first. The status
  -- transition to 'publishing' happens here, BEFORE any Facebook
  -- call, so a second tick (or a retry) can never claim the same
  -- row again — claim-before-call, the same discipline as mirror
  -- posts. Rows whose gates fail stay 'queued' with their marker:
  -- they are never slot-claimed (see the exclusion above) and never
  -- silently re-queued as normal items; a re-click re-validates
  -- through the route gate, which refuses with the plain reason.
  RETURN QUERY
  WITH candidate AS (
    SELECT qi.id
    FROM public.queue_items qi
    INNER JOIN public.destinations d
      ON d.id = qi.destination_id
    INNER JOIN public.social_accounts sa
      ON sa.id = d.account_id
    LEFT JOIN public.media_items mi
      ON mi.id = qi.media_item_id
    WHERE qi.status = 'queued'
      AND qi.publish_now_requested_at IS NOT NULL
      AND qi.platform = 'facebook'
      AND d.platform = 'facebook'
      AND (
        d.status = 'active'
        OR (d.status = 'rate_limited' AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days')
      )
      AND sa.status = 'active'
      -- Facebook token-expiry guard (due RPC BG4 rule): a token
      -- whose expiry date has passed is lapsed even if the refresh
      -- job has not flipped the account status yet.
      AND (sa.token_expires_at IS NULL OR sa.token_expires_at > now())
      -- Entitlement pause (audit fix 2026-11-01; C4): same
      -- fail-closed check as the slot and due claims, via the
      -- shared workspace_has_active_period function.
      AND public.workspace_has_active_period(d.workspace_id)
      AND (
        qi.kind = 'text'
        OR qi.media_url IS NOT NULL
        OR (qi.media_item_id IS NOT NULL AND mi.id IS NOT NULL)
      )
    ORDER BY qi.publish_now_requested_at ASC, qi.created_at ASC, qi.id ASC
    LIMIT v_limit
    FOR UPDATE OF qi SKIP LOCKED
  ),
  upd AS (
    UPDATE public.queue_items qi
    SET status = 'publishing',
        claimed_at = now(),
        updated_at = now()
    FROM candidate c
    WHERE qi.id = c.id
    RETURNING qi.id, qi.kind, qi.platform_format, qi.destination_id
  )
  SELECT u.id, u.kind, u.platform_format, u.destination_id FROM upd u;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_publish_now_items(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_publish_now_items(INT) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_posting_slot_item(p_destination_id uuid, p_slot_id uuid, p_claim_date date, p_now timestamp with time zone, p_window_minutes integer DEFAULT 5, p_section text DEFAULT NULL)
 RETURNS TABLE(id uuid, kind character varying, platform_format character varying, destination_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The RETURNS TABLE columns (id, kind, platform_format,
-- destination_id) double as PL/pgSQL OUT variables, so any bare
-- reference to one of them is ambiguous (the ON CONFLICT inference
-- list below cannot be qualified). Resolve every ambiguity toward
-- the column: the body never reads an OUT variable as a value.
#variable_conflict use_column
DECLARE
  v_timezone VARCHAR(50);
  v_status VARCHAR(30);
  v_account_status VARCHAR(30);
  v_slot_time TIME;
  v_slot_kind TEXT[];
  v_workspace_id UUID;
  v_destination_key TEXT;
  v_slot_active BOOLEAN;
  v_occurrence TIMESTAMPTZ;
BEGIN
  -- 3-day rate_limited flip (migration 20261102160000): a destination
  -- whose window has elapsed returns to 'active' with the anchor
  -- cleared before the status check below, so the slot claim sees
  -- it as active. The anchor is metadata.rate_limited_at, with
  -- updated_at as the legacy-only fallback. (Aliased: the function's
  -- RETURNS TABLE declares an OUT parameter named `id`, so a bare
  -- `id` here would be ambiguous in PL/pgSQL.)
  UPDATE public.destinations d
  SET status = 'active',
      metadata = d.metadata - 'rate_limited_at',
      updated_at = now()
  WHERE d.id = p_destination_id
    AND d.status = 'rate_limited'
    AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days';

  SELECT d.timezone, d.status, sa.status, d.workspace_id,
         COALESCE(d.external_destination_id, p_destination_id::text)
    INTO v_timezone, v_status, v_account_status, v_workspace_id, v_destination_key
  FROM public.destinations d
  LEFT JOIN public.social_accounts sa ON sa.id = d.account_id
  WHERE d.id = p_destination_id AND d.platform = 'facebook'
    AND (p_section IS NULL OR d.section = p_section);

  -- Only active pages of active accounts publish. Paused pages are
  -- stored as 'disconnected' + marker, rate-limited as
  -- 'rate_limited', and checkpoint as 'error' — all excluded here by
  -- the status check. A revoked/expired account (or a destination
  -- with no account row at all) claims nothing: IS DISTINCT FROM
  -- 'active' fails closed on NULL as well as on any other status.
  IF NOT FOUND OR v_status <> 'active'
     OR v_account_status IS DISTINCT FROM 'active' THEN
    RETURN;
  END IF;

  -- Entitlement pause (audit fix 2026-11-01; C4): one shared
  -- workspace_has_active_period function — the owning
  -- workspace's owner must have an active, non-superseded
  -- period; admin owners are exempt. A destination whose owner
  -- cannot be resolved fails closed. The window is evaluated
  -- at p_now, the claim time, not wall-clock now().
  IF NOT public.can_publish_for(v_workspace_id, 'facebook', v_destination_key, p_now, p_section) THEN
    RETURN;
  END IF;

  SELECT s.time_of_day, s.kind, s.is_active
  INTO v_slot_time, v_slot_kind, v_slot_active
  FROM public.posting_slots s
  WHERE s.id = p_slot_id AND s.destination_id = p_destination_id;

  IF NOT FOUND OR NOT v_slot_active THEN
    RETURN;
  END IF;

  -- Today's occurrence of this slot in the page timezone.
  v_occurrence := (p_claim_date::timestamp + v_slot_time) AT TIME ZONE v_timezone;

  -- Missed is lost: outside the claim window, claim nothing.
  IF v_occurrence > p_now
     OR v_occurrence <= p_now - make_interval(mins => GREATEST(p_window_minutes, 0)) THEN
    RETURN;
  END IF;

  -- One statement: pick the first queued fitting post (queue order),
  -- insert the claim row (conflict = already fired today, so insert
  -- nothing), and move exactly the claimed row to publishing. A
  -- retry of the same slot+day conflicts on the unique constraint
  -- and publishes nothing — idempotent by construction.
  --
  -- Publish-now exclusion (20261102140000): a marked row is claimed
  -- by the immediate tick only and must never consume a slot.
  RETURN QUERY
  WITH candidate AS (
    SELECT qi.id
    FROM public.queue_items qi
    WHERE qi.destination_id = p_destination_id
      AND qi.status = 'queued'
      AND qi.publish_now_requested_at IS NULL
      -- Retry-delay gate: a deferred/retried row is not due until
      -- its scheduled_time arrives. Facebook queued rows normally
      -- store NULL here and are unaffected.
      AND (qi.scheduled_time IS NULL OR qi.scheduled_time <= p_now)
      AND (
        CASE
          WHEN qi.platform_format IN ('reel', 'text', 'story') THEN qi.platform_format
          WHEN qi.kind = 'image' THEN 'image'
          WHEN qi.kind = 'video' THEN 'video'
          ELSE qi.kind
        END
      ) = ANY (v_slot_kind)
    ORDER BY qi.queue_seq ASC NULLS LAST, qi.created_at ASC, qi.id ASC
    LIMIT 1
    FOR UPDATE OF qi SKIP LOCKED
  ),
  ins AS (
    INSERT INTO public.posting_slot_claims
      (destination_id, slot_id, claim_date, queue_item_id)
    SELECT p_destination_id, p_slot_id, p_claim_date, c.id
    FROM candidate c
    ON CONFLICT (destination_id, slot_id, claim_date) DO NOTHING
    RETURNING queue_item_id
  ),
  upd AS (
    UPDATE public.queue_items qi
    SET status = 'publishing', updated_at = now()
    WHERE qi.id IN (SELECT queue_item_id FROM ins)
    RETURNING qi.id, qi.kind, qi.platform_format, qi.destination_id
  )
  SELECT u.id, u.kind, u.platform_format, u.destination_id FROM upd u;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_posting_slot_item(UUID, UUID, DATE, TIMESTAMPTZ, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_posting_slot_item(UUID, UUID, DATE, TIMESTAMPTZ, INT, TEXT) TO service_role;
