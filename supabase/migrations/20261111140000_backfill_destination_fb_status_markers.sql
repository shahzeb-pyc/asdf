-- Spec 164: backfill metadata.fb_status for Facebook destinations in
-- error whose latest failed ADU job proves the reason.
--
-- The ADU tick flipped destinations to `error` but never wrote the
-- detail marker, so every ADU-broken page read as "Invalid token" in
-- Pages. This migration writes the marker the tick should have
-- written, from the same evidence the tick had: the latest
-- `failed_to_publish` ADU job for the destination (latest by
-- updated_at, joined through adu_configs.destination_id). The marker
-- CASE mirrors evaluateGraphApiError -> destinationFbStatusMarker
-- (packages/contracts/src/domain/facebook-health.ts and
-- facebook-page-status.ts) for the codes the mapper/publisher know;
-- NULL means "no marker", and those rows are left alone.
--
-- Scope, per the owner decisions (2026-11-11):
--   * Only platform='facebook', status='error', marker IS NULL.
--   * Basit khan #2 (a49ee493-3d6f-4606-bc3a-5f64ca300d3a) is EXCLUDED
--     explicitly — separate investigation, do not label or touch.
--     It has no failed job, so it is excluded automatically too.
--   * Destinations with no failed job (e.g. Ddebsahoy) have no row in
--     the latest-failed join and stay unmarked — cause unknown.
--   * Rate-limited rows never get a marker here (368/1390008 and the
--     1404102/1404082 no-flip codes yield NULL).
--   * No publish_logs fallback: the live re-count showed 0 publish_logs
--     failures for every error destination — the ADU path is the only
--     evidence.
--
-- Idempotent: the marker IS NULL guard makes a re-run a no-op.
-- No SECURITY DEFINER, no new function, no RLS change — plain DML
-- inside one DO block, so a failure rolls the whole migration back.
-- Expected live count at build time: 22 markers (21 x checkpoint from
-- 368/4854002 + 1 x checkpoint from 190/459); re-count at deploy time.
DO $$
DECLARE
  v_count int;
BEGIN
  WITH latest_failed AS (
    SELECT DISTINCT ON (c.destination_id)
           c.destination_id,
           j.last_error_code AS code,
           substring(j.last_error_message FROM 'subcode=([0-9]+)') AS subcode,
           lower(coalesce(j.last_error_message, '')) AS message
      FROM adu_posting_jobs j
      JOIN adu_configs c ON c.id = j.config_id
     WHERE j.status = 'failed_to_publish'
     ORDER BY c.destination_id, j.updated_at DESC
  ),
  marked AS (
    SELECT d.id,
           CASE
             WHEN lf.code = '368' AND lf.subcode IN ('4854002', '1404078') THEN 'checkpoint'
             WHEN lf.code = '400' AND lf.subcode = '4854002' THEN 'checkpoint'
             WHEN lf.code = '190' AND lf.subcode IN ('459', '464') THEN 'checkpoint'
             -- 190/2069032 is a no-flip app bug (generic-backend), NOT
             -- invalid_token: it must yield NULL before the generic
             -- 190 branch below.
             WHEN lf.code = '190' AND lf.subcode = '2069032' THEN NULL
             WHEN lf.code = '190' AND lf.subcode = '492' THEN 'missing_page_access'
             WHEN lf.code = '190' AND lf.subcode = '2069031' THEN 'check_developer_app'
             WHEN lf.code IN ('190', '102') THEN 'invalid_token'
             -- Rate-limited and the 1404102/1404082 no-flip codes carry
             -- no marker.
             WHEN lf.code = '368' AND lf.subcode = '1390008' THEN NULL
             WHEN lf.code = '368' AND lf.subcode IN ('1404102', '1404082') THEN NULL
             WHEN lf.code = '368' AND lf.subcode = '1404112' THEN 'account_suspended'
             WHEN lf.code = '368' AND (lf.message LIKE '%suspended%' OR lf.message LIKE '%disabled%') THEN 'account_suspended'
             WHEN lf.code = '368' AND (lf.message LIKE '%developer app%' OR lf.message LIKE '%app is restricted%') THEN 'check_developer_app'
             -- 10 / 200-299 permission family. The code is text: the
             -- CASE safe-cast only casts when the value is numeric, so
             -- a non-numeric code (e.g. 'auth') can never raise.
             WHEN lf.code = '10'
               OR (CASE WHEN lf.code ~ '^[0-9]+$' THEN lf.code::int END) BETWEEN 200 AND 299 THEN
               CASE
                 WHEN lf.subcode IN ('2069030', '2069031', '2069033') OR lf.message LIKE '%api access blocked%' THEN 'check_developer_app'
                 ELSE 'missing_permission'
               END
             -- No numeric code, HTTP-level page-gone signal.
             WHEN (lf.code IS NULL OR lf.code !~ '^[0-9]+$')
               AND (lf.message LIKE '%page not found%' OR lf.message LIKE '%does not exist%') THEN 'page_not_accessible'
             ELSE NULL
           END AS marker
      FROM destinations d
      JOIN latest_failed lf ON lf.destination_id = d.id
     WHERE d.platform = 'facebook'
       AND d.status = 'error'
       AND d.metadata->>'fb_status' IS NULL
       -- Basit khan #2: separate investigation. Do not label or touch.
       AND d.id <> 'a49ee493-3d6f-4606-bc3a-5f64ca300d3a'
  )
  UPDATE destinations d
     SET metadata = d.metadata || jsonb_build_object('fb_status', m.marker),
         updated_at = now()
    FROM marked m
   WHERE d.id = m.id
     AND m.marker IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'spec 164 backfill: % destination fb_status markers written', v_count;
END $$;
