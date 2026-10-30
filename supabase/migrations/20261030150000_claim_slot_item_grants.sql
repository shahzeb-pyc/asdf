-- Grant lockdown for claim_posting_slot_item (audit PR-stage safety check).
--
-- The function was introduced as SECURITY DEFINER by
-- 20261029120000_slot_claim_retry_cooldown.sql (already on main, not
-- yet applied to prod) without a REVOKE/GRANT, so by default it would
-- be executable by PUBLIC (anon/authenticated) once applied. It is a
-- worker-only function: it claims posting slots and moves queued rows
-- to publishing for an arbitrary destination id, with no workspace
-- ownership check of its own. Lock it to service_role only.
--
-- Apply AFTER 20261029120000 (timestamp order handles this when
-- migrations are applied in order).

REVOKE EXECUTE ON FUNCTION public.claim_posting_slot_item(UUID, UUID, DATE, TIMESTAMPTZ, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_posting_slot_item(UUID, UUID, DATE, TIMESTAMPTZ, INT) TO service_role;
