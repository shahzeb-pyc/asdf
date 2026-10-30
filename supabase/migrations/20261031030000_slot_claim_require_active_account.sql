-- Slot claim requires an active owning account (launch prep, P0-2).
--
-- WRITTEN BUT NOT APPLIED TO PROD. Apply it manually after merge.
--
-- Problem: the slot claimer checked only the destination's own status.
-- When Facebook revokes the app (user removes the app on Facebook's
-- side), the account row flips to 'revoked' — but if destination
-- propagation ever lags or is skipped, the slot claimer could still
-- claim a queued item for a destination whose account can no longer
-- publish, and the worker consumer would then defer it forever
-- (scheduled time reset to NULL, re-claimed next slot, no failure
-- signal). The due claimer already joins social_accounts with
-- sa.status = 'active'; the slot claimer did not, so the two
-- claimers disagreed.
--
-- Fix: both slot-claim functions now require the owning account to
-- be 'active' as well as the destination. A destination with no
-- account row fails closed (no claim), matching the due claimer's
-- INNER JOIN semantics.
--
-- This is a full CREATE OR REPLACE of both functions, so applying it
-- is correct on top of either the original 20261027130000 bodies or
-- the 20261029120000 retry-cooldown redefinition of
-- claim_posting_slot_item: the cooldown gates (scheduled_time due,
-- next_allowed_publish_at) are carried over verbatim below. Existing
-- EXECUTE grants are preserved by CREATE OR REPLACE (see
-- 20261030150000_claim_slot_item_grants.sql); no grant statements
-- are repeated here.
--
-- Safe to apply at any time: it only narrows which rows a slot may
-- claim, and never changes a function signature the worker calls.

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
  RETURN QUERY
  WITH candidate AS (
    SELECT qi.id
    FROM public.queue_items qi
    WHERE qi.destination_id = p_destination_id
      AND qi.status = 'queued'
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

CREATE OR REPLACE FUNCTION public.list_active_facebook_posting_slots()
RETURNS TABLE (
  destination_id UUID,
  slot_id UUID,
  time_of_day TEXT,
  timezone VARCHAR,
  kind TEXT[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.id, s.id, s.time_of_day::text, d.timezone, s.kind
  FROM public.destinations d
  JOIN public.posting_slots s ON s.destination_id = d.id
  JOIN public.social_accounts sa ON sa.id = d.account_id
  WHERE d.platform = 'facebook'
    AND d.status = 'active'
    AND sa.status = 'active'
    AND s.is_active = true;
$$;
