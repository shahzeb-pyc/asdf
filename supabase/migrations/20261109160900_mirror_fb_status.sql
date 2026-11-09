-- Spec 155: Facebook error detail for mirrors.
--
-- Mirrors have no metadata column (unlike destinations), so the
-- Facebook publish-error detail gets its own columns:
--   fb_status           — the Facebook detail for a mirror in `error`
--                         (one of the MIRROR_FB_STATUSES values, or
--                         NULL when there is no Facebook error).
--                         `checkpoint` is the mirror spelling of the
--                         Pages wire value `page_checkpoint`.
--   fb_rate_limited_at  — the 3-day auto-resume anchor for a
--                         rate-limited mirror (the tick recomputes
--                         status hourly, so without the anchor a
--                         rate-limited mirror would flip back to
--                         active on the next check).
--
-- `mirrors.status` itself stays active / paused / error (unchanged
-- CHECK). The display status is derived at read time, never stored
-- twice: error + fb_status -> that status; error + no fb_status ->
-- the target destination's Facebook detail when the target carries
-- one, else generic Error (see the mirror display helper).
--
-- The CHECK values mirror `MIRROR_FB_STATUSES` in
-- packages/contracts/src/domain/facebook-page-status.ts — keep the
-- two in step. `2fa_required_on_BM` has no writer (same as ADU):
-- the value is accepted, only ever set by a future writer.
--
-- Applies automatically on merge via the Supabase GitHub
-- integration (verified live 2026-11-09); verify via the ledger row
-- + column presence after merging, it can lag a few minutes.

ALTER TABLE public.mirrors
  ADD COLUMN IF NOT EXISTS fb_status text NULL
    CHECK (
      fb_status IS NULL
      OR fb_status IN (
        'checkpoint',
        'invalid_token',
        'fb_rate_limited',
        'page_not_accessible',
        'missing_page_access',
        'missing_permission',
        'check_developer_app',
        'account_suspended',
        '2fa_required_on_BM'
      )
    ),
  ADD COLUMN IF NOT EXISTS fb_rate_limited_at timestamptz NULL;

COMMENT ON COLUMN public.mirrors.fb_status IS
  'Spec 155: Facebook publish-error detail for a mirror in error (MIRROR_FB_STATUSES); NULL when there is no Facebook error.';
COMMENT ON COLUMN public.mirrors.fb_rate_limited_at IS
  'Spec 155: 3-day auto-resume anchor for a rate-limited mirror (fb_status = fb_rate_limited).';
