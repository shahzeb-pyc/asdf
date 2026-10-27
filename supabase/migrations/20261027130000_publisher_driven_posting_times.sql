-- Publisher-driven posting times.
--
-- The schedule moves off queued posts and onto the posting times
-- themselves: when an active posting time comes (in the page's
-- timezone), the publisher claims the first queued post that fits
-- that time's allowed formats. Queued posts therefore carry no
-- posting time, and changing times rewrites nothing on them.
--
-- This migration:
--   1. Adds queue_items.queue_seq — the ONE queue ordering. It is
--      backfilled from the old scheduled order (scheduled_time,
--      created_at) per destination, so existing queued posts keep
--      their current relative order when the new system takes over.
--   2. Makes queue_items.scheduled_time nullable and clears it (and
--      slot_id) on queued Facebook items: those items join the
--      slot-driven flow in queue_seq order. Other platforms and
--      non-queued rows are untouched, and the due-based claim RPC
--      naturally skips NULL times (NULL <= now() is not true).
--   3. Adds posting_slot_claims — one row per (destination, slot,
--      claim date in the page timezone). Its unique constraint is
--      what provably prevents double-fire: one post per posting
--      time per day per page, retry-safe.
--   4. Adds claim_posting_slot_item — the atomic slot claim. It
--      verifies the destination is active, the slot is active, and
--      the slot's occurrence today (page timezone) falls inside the
--      claim window; anything outside the window is a missed time
--      and is LOST (no catch-up). The claim insert and the
--      queued -> publishing transition happen in one statement.
--   5. Adds list_active_facebook_posting_slots for the worker tick.
--   6. Adds refresh_destination_unmatched_flag — recomputes the
--      destinations.metadata.unmatched_post_types flag (queued post
--      formats no active slot allows) while preserving every other
--      metadata key. Pause/resume never touch metadata, so the flag
--      survives pausing; the UI shows it only while status is active.

-- 1. Queue order -------------------------------------------------------
ALTER TABLE public.queue_items ADD COLUMN IF NOT EXISTS queue_seq BIGINT;

UPDATE public.queue_items qi
SET queue_seq = sub.rn
FROM (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY destination_id
           ORDER BY scheduled_time ASC, created_at ASC, id ASC
         ) AS rn
  FROM public.queue_items
) sub
WHERE qi.id = sub.id AND qi.queue_seq IS NULL;

CREATE INDEX IF NOT EXISTS idx_queue_items_destination_queue_seq
  ON public.queue_items (destination_id, queue_seq)
  WHERE status = 'queued';

-- 2. Stored times go away for queued Facebook items --------------------
ALTER TABLE public.queue_items ALTER COLUMN scheduled_time DROP NOT NULL;

UPDATE public.queue_items qi
SET scheduled_time = NULL,
    slot_id = NULL,
    updated_at = now()
FROM public.destinations d
WHERE qi.destination_id = d.id
  AND d.platform = 'facebook'
  AND qi.status = 'queued';

-- 3. One claim row per slot per day ------------------------------------
CREATE TABLE IF NOT EXISTS public.posting_slot_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id UUID NOT NULL REFERENCES public.destinations(id) ON DELETE CASCADE,
  slot_id UUID NOT NULL REFERENCES public.posting_slots(id) ON DELETE CASCADE,
  claim_date DATE NOT NULL,
  queue_item_id UUID NOT NULL REFERENCES public.queue_items(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_posting_slot_claims_destination_slot_date
    UNIQUE (destination_id, slot_id, claim_date)
);
CREATE INDEX IF NOT EXISTS idx_posting_slot_claims_queue_item
  ON public.posting_slot_claims (queue_item_id);
-- Fail closed for app roles: only the service role (which bypasses
-- RLS) reads/writes claims, via the RPCs below.
ALTER TABLE public.posting_slot_claims ENABLE ROW LEVEL SECURITY;

-- Shared item-format mapping: the slot-format vocabulary of a queue
-- item is its platform_format when that is a slot format, else kind.
-- (Kept inline in each function; SQL has no reusable expression here
-- without a helper function, and a helper would widen the surface.)

-- 4. Atomic slot claim ---------------------------------------------------
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
  v_slot_time TIME;
  v_slot_kind TEXT[];
  v_slot_active BOOLEAN;
  v_occurrence TIMESTAMPTZ;
BEGIN
  SELECT d.timezone, d.status INTO v_timezone, v_status
  FROM public.destinations d
  WHERE d.id = p_destination_id AND d.platform = 'facebook';

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

-- 5. Active Facebook slots for the worker tick --------------------------
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
  WHERE d.platform = 'facebook'
    AND d.status = 'active'
    AND s.is_active = true;
$$;

-- 6. Unmatched-type flag -------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_destination_unmatched_flag(
  p_destination_id UUID
)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unmatched TEXT[];
  v_platform TEXT;
BEGIN
  -- The unmatched flag is a Facebook posting-times concept only.
  -- Never set it on other platforms (their destinations carry no
  -- posting slots, so without this gate every queued post of theirs
  -- would look unmatched). Clearing on non-Facebook is idempotent.
  SELECT platform INTO v_platform
  FROM public.destinations
  WHERE id = p_destination_id;
  IF v_platform IS DISTINCT FROM 'facebook' THEN
    UPDATE public.destinations d
    SET metadata = d.metadata - 'unmatched_post_types',
        updated_at = now()
    WHERE d.id = p_destination_id;
    RETURN ARRAY[]::TEXT[];
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT item_format
    FROM (
      SELECT CASE
        WHEN qi.platform_format IN ('reel', 'text', 'story') THEN qi.platform_format
        WHEN qi.kind = 'image' THEN 'image'
        WHEN qi.kind = 'video' THEN 'video'
        ELSE qi.kind
      END AS item_format
      FROM public.queue_items qi
      WHERE qi.destination_id = p_destination_id
        AND qi.status = 'queued'
    ) items
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.posting_slots s
      WHERE s.destination_id = p_destination_id
        AND s.is_active = true
        AND items.item_format = ANY (s.kind)
    )
    ORDER BY 1
  ) INTO v_unmatched;

  IF v_unmatched IS NULL THEN
    v_unmatched := ARRAY[]::TEXT[];
  END IF;

  UPDATE public.destinations d
  SET metadata = CASE
      WHEN array_length(v_unmatched, 1) > 0
        THEN d.metadata || jsonb_build_object('unmatched_post_types', to_jsonb(v_unmatched))
      ELSE d.metadata - 'unmatched_post_types'
    END,
    updated_at = now()
  WHERE d.id = p_destination_id;

  RETURN v_unmatched;
END;
$$;

-- Backfill the flag for every Facebook destination at cutover.
SELECT public.refresh_destination_unmatched_flag(id)
FROM public.destinations
WHERE platform = 'facebook';
