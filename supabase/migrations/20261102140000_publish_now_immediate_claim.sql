-- Publish Now immediate dispatch (2026-11-02): a Publish Now click
-- sends the post out EXTRA, on top of scheduled posts — it must never
-- consume a posting slot.
--
-- 1. Explicit marker: queue_items.publish_now_requested_at, set by
--    both publish-now routes at dispatch time. NULL = never
--    publish-now'd (existing behavior, untouched). scheduled_time
--    alone provably does not carry the marker: publish-now rows
--    already set scheduled_time = now() today and still wait for a
--    slot.
-- 2. claim_posting_slot_item: full CREATE OR REPLACE of the
--    20261101090001 body with exactly one added predicate — marked
--    rows are never slot-claimed. Everything else is verbatim.
-- 3. claim_publish_now_items: the immediate claim. Facebook-only,
--    atomic claim-before-call, mirroring the slot RPC's gates
--    (destination active, account active, cooldown, entitlement)
--    plus the due RPC's Facebook token-expiry guard and
--    rate-limited auto-recovery. No D5 claim-limit deferral, exactly
--    like slot claims: publish-now is an explicit user action, not
--    background backlog.
--
-- Auto-applies via the Supabase GitHub Integration on merge.
-- No backfill: existing rows keep NULL markers.

ALTER TABLE public.queue_items
  ADD COLUMN IF NOT EXISTS publish_now_requested_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_queue_items_publish_now_pending
  ON public.queue_items (platform, publish_now_requested_at)
  WHERE status = 'queued' AND publish_now_requested_at IS NOT NULL;

-- 2. Slot claim: marked rows never consume a slot ----------------------
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
DECLARE
  v_timezone VARCHAR(50);
  v_status VARCHAR(30);
  v_account_status VARCHAR(30);
  v_owner_role VARCHAR(30);
  v_next_allowed TIMESTAMPTZ;
  v_slot_time TIME;
  v_slot_kind TEXT[];
  v_slot_active BOOLEAN;
  v_occurrence TIMESTAMPTZ;
BEGIN
  SELECT d.timezone, d.status, d.next_allowed_publish_at, sa.status
    INTO v_timezone, v_status, v_next_allowed, v_account_status
  FROM public.destinations d
  LEFT JOIN public.social_accounts sa ON sa.id = d.account_id
  WHERE d.id = p_destination_id AND d.platform = 'facebook';

  -- A destination still inside its cooldown claims nothing, even
  -- when its status is active: claiming now would only defer at
  -- publish time and burn the slot.
  IF v_next_allowed IS NOT NULL AND v_next_allowed > p_now THEN
    RETURN;
  END IF;

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

  -- Entitlement pause (audit fix 2026-11-01): the owning
  -- workspace's owner must have an active, non-superseded
  -- period; admin owners are exempt. A destination whose owner
  -- cannot be resolved fails closed (v_owner_role NULL is
  -- DISTINCT FROM 'admin', and the period EXISTS is false).
  SELECT u.role INTO v_owner_role
  FROM public.workspaces w
  JOIN public.users u ON u.id = w.owner_id
  JOIN public.destinations d ON d.workspace_id = w.id
  WHERE d.id = p_destination_id;
  IF v_owner_role IS DISTINCT FROM 'admin' AND NOT EXISTS (
    SELECT 1
    FROM public.workspaces w
    JOIN public.subscription_periods sp ON sp.user_id = w.owner_id
    WHERE w.id = (SELECT workspace_id FROM public.destinations WHERE id = p_destination_id)
      AND sp.superseded_at IS NULL
      AND sp.starts_at <= p_now
      AND sp.ends_at > p_now
  ) THEN
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

-- 3. Immediate claim: publish-now rows, Facebook only ------------------
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
  -- Rate-limited auto-recovery, copied from the due RPC step (a):
  -- a destination whose cooldown has expired returns to 'active'
  -- (scoped here to destinations with marked queued items), so a
  -- page the publish-now route gate already treats as active is
  -- claimable immediately.
  UPDATE public.destinations d
  SET status = 'active',
      next_allowed_publish_at = NULL,
      updated_at = now()
  WHERE d.status = 'rate_limited'
    AND d.platform = 'facebook'
    AND d.next_allowed_publish_at IS NOT NULL
    AND d.next_allowed_publish_at <= now()
    AND EXISTS (
      SELECT 1
      FROM public.queue_items qi
      WHERE qi.destination_id = d.id
        AND qi.status = 'queued'
        AND qi.publish_now_requested_at IS NOT NULL
        AND qi.platform = 'facebook'
    );

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
      AND d.status = 'active'
      AND sa.status = 'active'
      -- Facebook token-expiry guard (due RPC BG4 rule): a token
      -- whose expiry date has passed is lapsed even if the refresh
      -- job has not flipped the account status yet.
      AND (sa.token_expires_at IS NULL OR sa.token_expires_at > now())
      AND (d.next_allowed_publish_at IS NULL OR d.next_allowed_publish_at <= now())
      -- Entitlement pause (audit fix 2026-11-01): same fail-closed
      -- predicate as the slot and due claims.
      AND (
        EXISTS (
          SELECT 1
          FROM public.workspaces w
          JOIN public.users u ON u.id = w.owner_id
          WHERE w.id = d.workspace_id
            AND u.role = 'admin'
        )
        OR EXISTS (
          SELECT 1
          FROM public.workspaces w
          JOIN public.subscription_periods sp ON sp.user_id = w.owner_id
          WHERE w.id = d.workspace_id
            AND sp.superseded_at IS NULL
            AND sp.starts_at <= now()
            AND sp.ends_at > now()
        )
      )
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

-- New function: grants follow the repo convention (service_role only).
REVOKE ALL ON FUNCTION public.claim_publish_now_items(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_publish_now_items(INT) TO service_role;
