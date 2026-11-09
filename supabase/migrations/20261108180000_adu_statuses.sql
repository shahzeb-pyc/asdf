-- ADU statuses (spec §3.4): wire the decided error-code mapping into the
-- database enums.
--
-- - `adu_configs.status`: 'inactive' is removed (turning automation off
--   is Pause now) and 'paused', 'missing_page_access',
--   'missing_permission' are added. The CHECK was declared inline in
--   20261030120001_adu.sql, so Postgres named it `adu_configs_status_check`;
--   no later migration alters it (verified by grep before writing this
--   file). Existing 'inactive' rows are converted to 'paused' FIRST, or
--   the new CHECK would fail validation on those rows.
-- - `adu_reels.status`: 'failed' is added (inline CHECK, auto-named
--   `adu_reels_status_check`). Terminally-failed reels are terminal like
--   posted reels: they must not block the config completing.
-- - Backfill: reels stranded in 'processing' whose job already settled
--   terminally (failed_to_publish / publish_error / integrity_error) go
--   to 'failed'. Single indexed EXISTS update, not a row transfer.
-- - `adu_configs.rate_limited_at`: dedicated anchor for the 3-day
--   rate-limit auto-recovery (updated_at is touched by unrelated PATCH
--   writes and would restart the clock).
--
-- No SECURITY DEFINER functions. No unbounded statements.

UPDATE public.adu_configs SET status = 'paused' WHERE status = 'inactive';

ALTER TABLE public.adu_configs DROP CONSTRAINT adu_configs_status_check;
ALTER TABLE public.adu_configs ADD CONSTRAINT adu_configs_status_check CHECK (status IN ('active', 'paused', 'completed', 'fb_verification_required', 'invalid_token', 'fb_rate_limited', 'page_not_accessible', 'invalid_username', 'creator_suspended', '2fa_required_on_BM', 'check_developer_app', 'account_suspended', 'missing_page_access', 'missing_permission'));

ALTER TABLE public.adu_reels DROP CONSTRAINT adu_reels_status_check;
ALTER TABLE public.adu_reels ADD CONSTRAINT adu_reels_status_check CHECK (status IN ('pending', 'processing', 'downloaded', 'download_failed', 'posted', 'skipped', 'failed'));

UPDATE public.adu_reels SET status = 'failed'
WHERE status = 'processing'
  AND EXISTS (
    SELECT 1 FROM public.adu_posting_jobs j
    WHERE j.reel_id = public.adu_reels.id
      AND j.status IN ('failed_to_publish', 'publish_error', 'integrity_error')
  );

ALTER TABLE public.adu_configs ADD COLUMN rate_limited_at timestamptz;
