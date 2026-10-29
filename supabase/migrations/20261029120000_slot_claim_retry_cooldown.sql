-- Slot-claim retry-delay + cooldown gates (Create Posts fix, 2026-10-29).
--
-- WRITTEN BUT NOT APPLIED TO PROD. This is a CREATE OR REPLACE of
-- claim_posting_slot_item only; no other function in the applied
-- migration is touched. Applying it is safe at any time: it only
-- narrows which queued rows a slot may claim.
--
-- Before: a slot claimed the first queued fitting post regardless of
-- its retry delay or the destination cooldown, so a transiently
-- failed post that settled back to queued with a delay could burn
-- the next slot without publishing, and a post could be claimed
-- while the destination was still in cooldown.
-- After: a candidate must be due (scheduled_time IS NULL, or
-- scheduled_time <= now) and the destination must not be in a
-- future cooldown (next_allowed_publish_at IS NULL, or <= now).
-- Facebook queued posts normally store no time (NULL), so the
-- scheduled_time gate only bites on deferred/retried rows, which
-- is exactly the intended behaviour.

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
  v_next_allowed TIMESTAMPTZ;
  v_slot_time TIME;
  v_slot_kind TEXT[];
  v_slot_active BOOLEAN;
  v_occurrence TIMESTAMPTZ;
BEGIN
  SELECT d.timezone, d.status, d.next_allowed_publish_at
    INTO v_timezone, v_status, v_next_allowed
  FROM public.destinations d
  WHERE d.id = p_destination_id AND d.platform = 'facebook';

  -- A destination still inside its cooldown claims nothing, even
  -- when its status is active: claiming now would only defer at
  -- publish time and burn the slot.
  IF v_next_allowed IS NOT NULL AND v_next_allowed > p_now THEN
    RETURN;
  END IF;

  -- Only active pages publish. Paused pages are stored as
  -- 'disconnected' + marker, rate-limited as 'rate_limited', and
  -- checkpoint as 'error' — all excluded here by the status check.
  IF NOT FOUND OR v_status <> 'active' THEN
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
