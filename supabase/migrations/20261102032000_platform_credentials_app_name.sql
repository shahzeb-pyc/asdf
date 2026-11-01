-- Facebook BYOC app name (owner order 2026-11-02): when a workspace
-- connects its Facebook app, the app name is fetched from Meta's Graph
-- API and saved alongside the App ID and Secret, so the connected
-- view can show which app is actually connected. The same fetch is
-- the verification step that flips the row from 'unverified' to
-- 'valid' — previously nothing ever tested the saved details, so
-- every row stayed 'unverified' forever.
--
-- Safe to apply at any time: it only adds a nullable column, and
-- pre-existing rows get NULL (no name yet) until their next
-- Connect/Edit re-verifies. The app code renders nameless rows
-- exactly as before, so no backfill is needed.

ALTER TABLE public.platform_credentials
  ADD COLUMN IF NOT EXISTS app_name TEXT NULL;

COMMENT ON COLUMN public.platform_credentials.app_name IS
  'Display name of the Meta app, fetched from the Graph API at connect time and refreshed on every re-verification. NULL for rows connected before this column existed, until their next Connect/Edit.';
