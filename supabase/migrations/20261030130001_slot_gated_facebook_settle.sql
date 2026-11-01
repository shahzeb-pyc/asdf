-- =============================================================================
-- Migration: 20261030130000_slot_gated_facebook_settle.sql
-- Audit BG3 (owner decision 2026-10-30, "select all recommended" 1A):
-- deferred/retried Facebook posts must WAIT for the next posting slot
-- after reconnect, never publish via the due claimer at an unscheduled
-- time. Facebook queue rows are slot-driven (scheduled_time NULL);
-- the old settle wrote scheduled_time = now() + delay on defer/retry,
-- which made the row due-claimable off-schedule.
--
-- CHANGE (signature UNCHANGED, body otherwise verbatim from
-- 20261024100000): in the 'deferred' and 'queued'/'retry' branches,
-- when v_platform = 'facebook', scheduled_time is reset to NULL (and
-- slot_id cleared) instead of now() + delay. NULL fails the due
-- claimer's scheduled_time <= now() predicate, so the row is invisible
-- to claim_due_queue_items and is picked up again only by
-- claim_posting_slot_item at a later slot. All other platforms keep
-- the exact old behaviour. The 'published' and 'failed' branches are
-- untouched. ACLs are re-asserted below, as in the source migration.
-- PROD APPLICATION PENDING: this migration is NOT applied to prod by
-- this branch; it must be applied manually, separately, after merge.
-- It was NOT executed against live Postgres in this environment
-- (no local Postgres binary); syntax was checked by construction
-- (two CASE substitutions in an otherwise verbatim function body).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.settle_queue_item_outcome(
  p_queue_item_id UUID,
  p_workspace_id UUID,
  p_destination_id UUID,
  p_outcome_status TEXT,
  p_external_post_id TEXT DEFAULT NULL,
  p_external_comment_id TEXT DEFAULT NULL,
  p_retry_count INT DEFAULT 0,
  p_retry_delay_seconds INT DEFAULT 300,
  p_error_code TEXT DEFAULT NULL,
  p_error_subcode TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_comment_warning TEXT DEFAULT NULL,
  p_target_destination_status TEXT DEFAULT NULL,
  p_target_account_status TEXT DEFAULT NULL,
  p_destination_cooldown_seconds INT DEFAULT NULL,
  p_rate_usage_pct SMALLINT DEFAULT NULL,
  p_detail JSONB DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_platform public.platform;
  v_result VARCHAR(20);
  v_log_message TEXT;
  v_destination_status VARCHAR(30);
  v_updated INT;
BEGIN
  SELECT qi.platform INTO v_platform
  FROM public.queue_items qi
  WHERE qi.id = p_queue_item_id;
  IF p_outcome_status = 'published' THEN
    UPDATE public.queue_items
    SET status = 'published',
        external_post_id = p_external_post_id,
        external_comment_id = p_external_comment_id,
        error_code = NULL,
        error_subcode = NULL,
        error_message = NULL,
        updated_at = now()
    WHERE id = p_queue_item_id
      AND workspace_id = p_workspace_id
      AND status = 'publishing';

    -- [139-1] 0 rows: item is not in `publishing` (already settled,
    -- cancelled, or gone) — no-op without a publish_logs row or any
    -- destination/account side effect.
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RETURN 'already_settled';
    END IF;

    v_result := 'success';
    v_log_message := p_comment_warning;

  ELSIF p_outcome_status = 'deferred' THEN
    -- [DEFER] Deferral without counting: the item returns to `queued`
    -- and becomes due after the caller's delay, exactly like the retry
    -- branch — EXCEPT that retry_count is deliberately absent from the
    -- SET list, so the stored count is unchanged whatever value the
    -- caller passed in p_retry_count. No publish attempt failed (or,
    -- for readiness/cap deferrals, was even made), so no retry budget
    -- is consumed.
    UPDATE public.queue_items
    SET status = 'queued',
        scheduled_time = CASE WHEN v_platform = 'facebook' THEN NULL ELSE now() + make_interval(secs => GREATEST(1, COALESCE(p_retry_delay_seconds, 300))) END,
        slot_id = CASE WHEN v_platform = 'facebook' THEN NULL ELSE slot_id END,
        claimed_at = NULL,
        error_code = p_error_code,
        error_subcode = p_error_subcode,
        error_message = p_error_message,
        updated_at = now()
    WHERE id = p_queue_item_id
      AND workspace_id = p_workspace_id
      AND status = 'publishing';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RETURN 'already_settled';
    END IF;

    v_result := 'deferred';
    v_log_message := p_error_message;

  ELSIF p_outcome_status = 'queued' OR p_outcome_status = 'retry' THEN
    UPDATE public.queue_items
    SET status = 'queued',
        retry_count = p_retry_count,
        scheduled_time = CASE WHEN v_platform = 'facebook' THEN NULL ELSE now() + make_interval(secs => GREATEST(1, COALESCE(p_retry_delay_seconds, 300))) END,
        slot_id = CASE WHEN v_platform = 'facebook' THEN NULL ELSE slot_id END,
        claimed_at = NULL,
        error_code = p_error_code,
        error_subcode = p_error_subcode,
        error_message = p_error_message,
        updated_at = now()
    WHERE id = p_queue_item_id
      AND workspace_id = p_workspace_id
      AND status = 'publishing';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RETURN 'already_settled';
    END IF;

    v_result := 'retry';
    v_log_message := p_error_message;

  ELSE
    UPDATE public.queue_items
    SET status = 'failed',
        retry_count = p_retry_count,
        error_code = p_error_code,
        error_subcode = p_error_subcode,
        error_message = p_error_message,
        updated_at = now()
    WHERE id = p_queue_item_id
      AND workspace_id = p_workspace_id
      AND status = 'publishing';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RETURN 'already_settled';
    END IF;

    v_result := 'failure';
    v_log_message := p_error_message;
  END IF;

  INSERT INTO public.publish_logs (
    queue_item_id,
    destination_id,
    platform,
    attempt_no,
    result,
    external_post_id,
    response_code,
    response_message,
    duration_ms,
    detail,
    created_at
  ) VALUES (
    p_queue_item_id,
    p_destination_id,
    v_platform,
    COALESCE(p_retry_count, 0) + 1,
    v_result,
    p_external_post_id,
    CASE WHEN p_error_code ~ '^-?[0-9]+$' THEN p_error_code::INT ELSE NULL END,
    v_log_message,
    NULL,
    -- [139-3] p_detail merged under the existing error-code object (the
    -- error object wins key conflicts via `||` right-side precedence).
    -- Both sides are COALESCEd because `jsonb || NULL` is NULL: without
    -- that, a p_detail supplied on an error-free settle (the platform
    -- session-id case) would be lost. When p_detail IS NULL and there are
    -- no error codes the CASE keeps detail NULL, exactly as before.
    CASE
      WHEN p_detail IS NULL AND p_error_code IS NULL AND p_error_subcode IS NULL
        THEN NULL
      ELSE COALESCE(p_detail, '{}'::jsonb)
           || COALESCE(
                jsonb_strip_nulls(jsonb_build_object('errorCode', p_error_code, 'errorSubcode', p_error_subcode)),
                '{}'::jsonb
              )
    END,
    now()
  );

  -- Destination side effects. Target statuses are the new vocabulary;
  -- legacy Facebook names are translated explicitly so a transitional
  -- caller cannot write a value the new CHECK constraint would reject.
  v_destination_status := CASE p_target_destination_status
    WHEN 'fb_rate_limited' THEN 'rate_limited'
    WHEN 'invalid_token' THEN 'error'
    WHEN 'page_checkpoint' THEN 'error'
    WHEN 'paused' THEN 'disconnected'
    ELSE p_target_destination_status
  END;

  UPDATE public.destinations
  SET status = CASE
        WHEN v_destination_status IN ('active', 'rate_limited', 'disconnected', 'error')
          THEN v_destination_status::VARCHAR(30)
        ELSE status
      END,
      next_allowed_publish_at = CASE
        WHEN p_destination_cooldown_seconds IS NOT NULL AND p_destination_cooldown_seconds > 0
          -- [139-2] Monotonic: extend-only, never shorten a live cooldown.
          THEN GREATEST(next_allowed_publish_at, now() + make_interval(secs => p_destination_cooldown_seconds))
        ELSE next_allowed_publish_at
      END,
      rate_usage_pct = COALESCE(p_rate_usage_pct, rate_usage_pct),
      updated_at = now()
  WHERE id = p_destination_id
    AND workspace_id = p_workspace_id
  RETURNING account_id INTO v_account_id;

  IF p_target_account_status = 'expired' AND v_account_id IS NOT NULL THEN
    UPDATE public.social_accounts
    SET status = 'expired',
        updated_at = now()
    WHERE id = v_account_id
      AND workspace_id = p_workspace_id;
  END IF;

  RETURN 'settled';
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. ACLs: re-assert the exact pre-existing posture on the unified
--    17-arg signature — service_role only.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.settle_queue_item_outcome(UUID, UUID, UUID, TEXT, TEXT, TEXT, INT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, SMALLINT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_queue_item_outcome(UUID, UUID, UUID, TEXT, TEXT, TEXT, INT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, SMALLINT, JSONB) TO service_role;
