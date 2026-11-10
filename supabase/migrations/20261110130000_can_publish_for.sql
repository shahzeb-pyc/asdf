-- S2: count enforcement in the worker (plan-check optimisation).
--
-- can_publish_for is the single count-aware publish predicate: the
-- owning workspace's owner may publish to a destination when an
-- admin owns the workspace, or when the owner holds an active,
-- non-superseded period (via the C4 workspace_has_active_period
-- function -- the period question is never re-implemented here)
-- AND the destination is already registered in subscription_usage
-- OR the owner's counted usage for the platform is still under
-- the active period's *_count cap. Usage is counted exactly as
-- get_entitlement counts it (C2): publish-now features excluded,
-- rows linked to a 'disconnected' destination in the owner's own
-- workspaces on the same platform excluded (d.platform::text =
-- u.platform -- destinations.platform is enum, subscription_usage
-- .platform is text). Counts come from the active period row's
-- *_count columns, COALESCE 0; an unknown platform fails closed.
-- The destination key is external_destination_id ?? id, the same
-- expression every web register site passes.
--
-- The two claim RPCs below are redefined with their C4
-- workspace_has_active_period calls replaced by can_publish_for
-- calls, signatures unchanged. The publish-now claim is NOT
-- redefined: Publish Now is uncapped by owner decision (PR #77).
-- Marked publish-now rows are exempt from the count half in the
-- due claim (see the predicate formula). The slot claim passes
-- p_now through, so its window is still evaluated at the claim
-- time, not wall-clock now().
--
-- Read-only, STABLE, SECURITY DEFINER, service-role only -- the
-- same pattern as workspace_has_active_period and get_entitlement.
-- The function never activates a due downgrade: a workspace whose
-- only live plan is a due schedule reads false until the tick (C3
-- downgrade-tick) or the TS helper backstop activates it.

CREATE OR REPLACE FUNCTION public.can_publish_for(
  p_workspace_id uuid,
  p_platform text,
  p_destination_key text,
  p_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH owner AS (
    SELECT w.owner_id
    FROM public.workspaces w
    WHERE w.id = p_workspace_id
  ),
  active_period AS (
    SELECT
      p.facebook_count,
      p.instagram_count,
      p.threads_count,
      p.x_count,
      p.tiktok_count,
      p.youtube_count
    FROM public.subscription_periods p
    WHERE p.user_id = (SELECT owner_id FROM owner)
      AND p.superseded_at IS NULL
      AND p.starts_at <= p_at
      AND p.ends_at > p_at
    ORDER BY p.ends_at DESC
    LIMIT 1
  ),
  disconnected AS (
    SELECT d.id, d.platform
    FROM public.destinations d
    JOIN public.workspaces w ON w.id = d.workspace_id
    WHERE w.owner_id = (SELECT owner_id FROM owner)
      AND d.status = 'disconnected'
  ),
  usage_count AS (
    SELECT count(*) AS n
    FROM public.subscription_usage u
    WHERE u.user_id = (SELECT owner_id FROM owner)
      AND u.platform = p_platform
      AND u.feature NOT IN ('publish-now', 'instagram-publish-now', 'threads-publish-now')
      AND NOT EXISTS (
        SELECT 1
        FROM disconnected d
        WHERE d.id = u.destination_id
          AND d.platform::text = u.platform
      )
  )
  SELECT COALESCE(
    EXISTS (
      SELECT 1
      FROM public.workspaces w
      JOIN public.users u ON u.id = w.owner_id
      WHERE w.id = p_workspace_id
        AND u.role = 'admin'
    )
    OR (
      public.workspace_has_active_period(p_workspace_id, p_at)
      AND (
        EXISTS (
          SELECT 1
          FROM public.subscription_usage u
          WHERE u.user_id = (SELECT owner_id FROM owner)
            AND u.platform = p_platform
            AND u.destination_key = p_destination_key
            AND u.feature NOT IN ('publish-now', 'instagram-publish-now', 'threads-publish-now')
        )
        OR (SELECT n FROM usage_count) < CASE p_platform
          WHEN 'facebook' THEN COALESCE((SELECT facebook_count FROM active_period), 0)
          WHEN 'instagram' THEN COALESCE((SELECT instagram_count FROM active_period), 0)
          WHEN 'threads' THEN COALESCE((SELECT threads_count FROM active_period), 0)
          WHEN 'x' THEN COALESCE((SELECT x_count FROM active_period), 0)
          WHEN 'tiktok' THEN COALESCE((SELECT tiktok_count FROM active_period), 0)
          WHEN 'youtube' THEN COALESCE((SELECT youtube_count FROM active_period), 0)
          ELSE NULL
        END
      )
    ),
    false
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_publish_for(uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_publish_for(uuid, text, text, timestamptz)
  TO service_role;



CREATE OR REPLACE FUNCTION public.claim_due_queue_items(
  p_platform public.platform,
  p_lane_kind_set TEXT[],
  p_limit INT DEFAULT 500,
  p_max_per_destination INT DEFAULT 3
)
RETURNS TABLE (
  id UUID,
  workspace_id UUID,
  destination_id UUID,
  account_id UUID,
  media_item_id UUID,
  kind TEXT,
  platform_format TEXT,
  link_url TEXT,
  caption TEXT,
  title TEXT,
  first_comment TEXT,
  platform_options JSONB,
  scheduled_time TIMESTAMPTZ,
  status VARCHAR,
  claimed_at TIMESTAMPTZ,
  retry_count INT,
  max_retries INT,
  external_post_id VARCHAR,
  external_comment_id VARCHAR,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  external_destination_id VARCHAR,
  encrypted_access_token TEXT,
  encrypted_destination_token TEXT,
  destination_name VARCHAR,
  media_type VARCHAR,
  media_url TEXT,
  media_storage_key VARCHAR
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      AND ((qi.publish_now_requested_at IS NULL AND public.can_publish_for(d.workspace_id, d.platform::text, COALESCE(d.external_destination_id, d.id::text))) OR (qi.publish_now_requested_at IS NOT NULL AND public.workspace_has_active_period(d.workspace_id)))
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
      AND ((qi.publish_now_requested_at IS NULL AND public.can_publish_for(d.workspace_id, d.platform::text, COALESCE(d.external_destination_id, d.id::text))) OR (qi.publish_now_requested_at IS NOT NULL AND public.workspace_has_active_period(d.workspace_id)))
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
  SELECT
    c.id,
    c.workspace_id,
    c.destination_id,
    d.account_id,
    c.media_item_id,
    c.kind::TEXT,
    c.platform_format::TEXT,
    c.link_url,
    c.caption,
    c.title,
    c.first_comment,
    c.platform_options,
    c.scheduled_time,
    c.status::VARCHAR,
    c.claimed_at,
    c.retry_count::INT,
    c.max_retries::INT,
    c.external_post_id::VARCHAR,
    c.external_comment_id::VARCHAR,
    c.created_at,
    c.updated_at,
    d.external_destination_id::VARCHAR,
    sa.encrypted_access_token,
    d.encrypted_destination_token,
    d.name::VARCHAR,
    mi.media_type::VARCHAR,
    COALESCE(c.media_url, mi.url) AS media_url,
    COALESCE(c.media_storage_key, mi.storage_key::VARCHAR) AS media_storage_key
  FROM claimed c
  INNER JOIN public.destinations d
    ON d.id = c.destination_id
  INNER JOIN public.social_accounts sa
    ON sa.id = d.account_id
  LEFT JOIN public.media_items mi
    ON mi.id = c.media_item_id
  ORDER BY c.scheduled_time ASC, c.id ASC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_queue_items(public.platform, TEXT[], INT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_posting_slot_item(
  p_destination_id UUID,
  p_slot_id UUID,
  p_claim_date DATE,
  p_now TIMESTAMPTZ,
  p_window_minutes INT DEFAULT 5
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
  WHERE d.id = p_destination_id AND d.platform = 'facebook';

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
  IF NOT public.can_publish_for(v_workspace_id, 'facebook', v_destination_key, p_now) THEN
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
$$;

REVOKE EXECUTE ON FUNCTION public.claim_posting_slot_item(UUID, UUID, DATE, TIMESTAMPTZ, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_posting_slot_item(UUID, UUID, DATE, TIMESTAMPTZ, INT) TO service_role;
