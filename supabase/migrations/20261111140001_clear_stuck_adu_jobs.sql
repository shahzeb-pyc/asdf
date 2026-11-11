-- Spec 164: clear the stuck ADU jobs and restore the configs that mint
-- them, so the pile cannot come back.
--
-- Step 1 — clear stuck jobs, RULE-based, never an id list: pending
-- jobs that failed at the destination gate (`destination_not_active`)
-- on a blocked Facebook destination. Never touches published jobs,
-- active destinations, or rate-limited destinations (a rate-limited
-- page's job must survive to publish after its cooldown).
--
-- Step 2 — restore error-destination configs: a config that is still
-- `active` while its destination is `error` mints ~2 stuck jobs per
-- day, so the clear alone would regrow. Each such config is set to
-- evaluateAduPublishError's aduStatus for its latest failed ADU job
-- (same latest-failed derivation as migration 20261111140000; NULL =
-- the mapper says noFlip, leave alone). The reset CASE mirrors the
-- mapper exactly, including `fb_rate_limited` for rate-limited latest
-- jobs (the mapper's honest verdict; it stops intake either way) and
-- the status-only statuses (the config flips even though the
-- destination stays put — exactly what a live tick failure does).
-- Basit khan #2 is excluded explicitly as well as automatically.
--
-- Step 3 — pause active configs on removed (disconnected) pages: an
-- `active` config on a removed page can never post and mints a stuck
-- job at every posting time. `paused` is the honest state — the setup
-- can be deleted or rebuilt when the page is re-added (which creates a
-- new destination row the old config could never point at). The
-- reactivation guard (ADU PATCH route, spec 164) blocks turning such a
-- config back on while the destination is disconnected, so the pile
-- cannot return through the toggle either.
--
-- Idempotent: step 1's predicates are state-based (a re-run finds no
-- matching jobs); steps 2 and 3 only touch configs still `active`.
-- No SECURITY DEFINER, no new function, no RLS change — plain DML.
-- Expected live counts at build time: 53 jobs, 9 error configs,
-- 6 disconnected configs; re-count at deploy time.
DO $$
DECLARE
  v_jobs int;
  v_error_configs int;
  v_paused_configs int;
BEGIN
  -- Step 1: clear stuck jobs.
  DELETE FROM adu_posting_jobs j
   USING adu_configs c, destinations d
   WHERE j.config_id = c.id
     AND c.destination_id = d.id
     AND d.platform = 'facebook'
     AND j.status = 'pending_publish'
     AND j.last_error_code = 'destination_not_active'
     AND d.status IN ('error', 'disconnected');
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  RAISE NOTICE 'spec 164 stuck-job clear: % jobs deleted', v_jobs;

  -- Step 2: restore error-destination configs to the mapper status of
  -- their latest failed job.
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
  reset AS (
    SELECT c.id,
           CASE
             WHEN lf.code = '368' AND lf.subcode IN ('4854002', '1404078') THEN 'fb_verification_required'
             WHEN lf.code = '400' AND lf.subcode = '4854002' THEN 'fb_verification_required'
             WHEN lf.code = '190' AND lf.subcode IN ('459', '464') THEN 'fb_verification_required'
             -- 190/2069032 is a no-flip app bug, NOT invalid_token.
             WHEN lf.code = '190' AND lf.subcode = '2069032' THEN NULL
             WHEN lf.code = '190' AND lf.subcode = '492' THEN 'missing_page_access'
             WHEN lf.code = '190' AND lf.subcode = '2069031' THEN 'check_developer_app'
             WHEN lf.code IN ('190', '102') THEN 'invalid_token'
             WHEN lf.code = '368' AND lf.subcode = '1390008' THEN 'fb_rate_limited'
             -- 1404102/1404082 are no-flip: they must yield NULL before
             -- the bare-368 catch-all below.
             WHEN lf.code = '368' AND lf.subcode IN ('1404102', '1404082') THEN NULL
             WHEN lf.code = '368' AND lf.subcode = '1404112' THEN 'account_suspended'
             WHEN lf.code = '368' AND (lf.message LIKE '%suspended%' OR lf.message LIKE '%disabled%') THEN 'account_suspended'
             WHEN lf.code = '368' AND (lf.message LIKE '%developer app%' OR lf.message LIKE '%app is restricted%') THEN 'check_developer_app'
             -- Any other 368 is the mapper's rateLimited() fallthrough.
             WHEN lf.code = '368' THEN 'fb_rate_limited'
             WHEN lf.code = '10'
               OR (CASE WHEN lf.code ~ '^[0-9]+$' THEN lf.code::int END) BETWEEN 200 AND 299 THEN
               CASE
                 WHEN lf.subcode IN ('2069030', '2069031', '2069033') OR lf.message LIKE '%api access blocked%' THEN 'check_developer_app'
                 ELSE 'missing_permission'
               END
             WHEN (lf.code IS NULL OR lf.code !~ '^[0-9]+$')
               AND (lf.message LIKE '%page not found%' OR lf.message LIKE '%does not exist%') THEN 'page_not_accessible'
             ELSE NULL
           END AS new_status
      FROM adu_configs c
      JOIN destinations d ON d.id = c.destination_id
      JOIN latest_failed lf ON lf.destination_id = d.id
     WHERE c.status = 'active'
       AND d.platform = 'facebook'
       AND d.status = 'error'
       -- Basit khan #2: separate investigation. Do not label or touch.
       AND d.id <> 'a49ee493-3d6f-4606-bc3a-5f64ca300d3a'
  )
  UPDATE adu_configs c
     SET status = r.new_status,
         updated_at = now()
    FROM reset r
   WHERE c.id = r.id
     AND r.new_status IS NOT NULL;
  GET DIAGNOSTICS v_error_configs = ROW_COUNT;
  RAISE NOTICE 'spec 164 config restore: % error-destination configs reset', v_error_configs;

  -- Step 3: pause active configs on removed pages.
  UPDATE adu_configs c
     SET status = 'paused',
         updated_at = now()
    FROM destinations d
   WHERE c.destination_id = d.id
     AND d.platform = 'facebook'
     AND c.status = 'active'
     AND d.status = 'disconnected';
  GET DIAGNOSTICS v_paused_configs = ROW_COUNT;
  RAISE NOTICE 'spec 164 config pause: % disconnected-destination configs paused', v_paused_configs;
END $$;
