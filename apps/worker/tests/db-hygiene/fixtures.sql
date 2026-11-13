-- =============================================================================
-- Spec 139 db-hygiene rig: deterministic fixtures.
--
-- Applied once per rig database by check.ts (idempotent: CREATE OR
-- REPLACE). Fixed UUIDs keep every case readable. dbhygiene_reset()
-- clears the tables the assertions touch and re-seeds:
--
--   user A (…1111) owns workspace A (…aaaa), a unified social account +
--     destination, two media folders (parent …f001, child …f002) and
--     four curated queue items covering the recovery sweep's filter:
--       …c001 publishing / facebook  / claimed 1h ago      -> stale
--       …c002 publishing / facebook  / claimed now         -> fresh
--       …c003 publishing / instagram / claimed 1h ago      -> stale, other platform
--       …c004 publishing / facebook  / claimed_at NULL,
--             updated_at 1h ago (COALESCE fallback)         -> stale
--   user B (…2222) owns workspace B (…bbbb) — the would-be new owner in
--     the workspace owner-transfer trigger probe.
--   Both users carry updated_at = now() - 1 day (set at INSERT time,
--   which does not fire the BEFORE UPDATE set_updated_at trigger), so
--   the rig can prove the trigger bumps it on a later UPDATE.
--
-- dbhygiene_seed_bulk() adds planner-scale volume for the EXPLAIN
-- assertion: 6,000 terminal/queued rows make `publishing` a small
-- minority (so the partial index is genuinely selective), plus 1,500
-- stale publishing/facebook rows and 500 stale publishing rows on
-- other platforms.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.dbhygiene_reset()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  TRUNCATE public.publish_logs, public.queue_items, public.destinations,
           public.social_accounts, public.media_folders,
           public.workspaces, public.users CASCADE;

  INSERT INTO public.users (id, email, name, updated_at) VALUES
    ('11111111-1111-1111-1111-111111111111', 'dbhygiene.a@gmail.com', 'Rig User A', now() - INTERVAL '1 day'),
    ('22222222-2222-2222-2222-222222222222', 'dbhygiene.b@gmail.com', 'Rig User B', now() - INTERVAL '1 day');

  INSERT INTO public.workspaces (id, owner_id, name, subdomain) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Rig WS A', 'dbhygiene-ws-a'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Rig WS B', 'dbhygiene-ws-b');

  INSERT INTO public.social_accounts (id, workspace_id, platform, external_account_id, display_name, encrypted_access_token, status) VALUES
    ('f0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'facebook', 'ext-acct-a', 'Rig Unified Account A', 'dummy-encrypted-access-token', 'active');

  INSERT INTO public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, encrypted_destination_token, status, section) VALUES
    ('f0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000001', 'facebook', 'ext-dest-a', 'Rig Unified Dest A',
     'dummy-encrypted-destination-token', 'active', 'schedule');

  INSERT INTO public.media_folders (id, user_id, name, parent_id) VALUES
    ('f001f001-f001-f001-f001-f001f001f001', '11111111-1111-1111-1111-111111111111', 'Rig Folder Parent', NULL),
    ('f002f002-f002-f002-f002-f002f002f002', '11111111-1111-1111-1111-111111111111', 'Rig Folder Child', 'f001f001-f001-f001-f001-f001f001f001');

  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at, updated_at) VALUES
    ('c001c001-c001-c001-c001-c001c001c001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig stale facebook',
     now() - INTERVAL '2 hours', 'publishing', now() - INTERVAL '1 hour', now() - INTERVAL '1 hour'),
    ('c002c002-c002-c002-c002-c002c002c002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig fresh facebook',
     now() - INTERVAL '2 hours', 'publishing', now(), now()),
    ('c003c003-c003-c003-c003-c003c003c003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'instagram', 'text', 'rig stale instagram',
     now() - INTERVAL '2 hours', 'publishing', now() - INTERVAL '1 hour', now() - INTERVAL '1 hour'),
    ('c004c004-c004-c004-c004-c004c004c004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig stale facebook null claim',
     now() - INTERVAL '2 hours', 'publishing', NULL, now() - INTERVAL '1 hour');
END;
$$;

CREATE OR REPLACE FUNCTION public.dbhygiene_seed_bulk()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- Terminal / queued bulk: publishing must be the minority status.
  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at)
  SELECT md5('dbhygiene-bulk-done-' || g)::uuid,
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
         'f0000000-0000-0000-0000-000000000002',
         (ARRAY['facebook', 'instagram', 'threads', 'youtube', 'x', 'tiktok'])[1 + (g % 6)]::public.platform,
         'text', 'rig bulk done ' || g,
         now() - INTERVAL '3 hours',
         (ARRAY['published', 'queued', 'failed', 'cancelled'])[1 + (g % 4)],
         NULL
  FROM generate_series(1, 6000) AS g;

  -- Stale publishing rows on facebook (the sweep's target slice).
  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at, updated_at)
  SELECT md5('dbhygiene-bulk-fb-' || g)::uuid,
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
         'f0000000-0000-0000-0000-000000000002',
         'facebook', 'text', 'rig bulk stale fb ' || g,
         now() - INTERVAL '3 hours', 'publishing',
         now() - INTERVAL '1 hour', now() - INTERVAL '1 hour'
  FROM generate_series(1, 1500) AS g;

  -- Stale publishing rows on other platforms.
  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at, updated_at)
  SELECT md5('dbhygiene-bulk-other-' || g)::uuid,
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
         'f0000000-0000-0000-0000-000000000002',
         (ARRAY['instagram', 'threads', 'youtube', 'x', 'tiktok'])[1 + (g % 5)]::public.platform,
         'text', 'rig bulk stale other ' || g,
         now() - INTERVAL '3 hours', 'publishing',
         now() - INTERVAL '1 hour', now() - INTERVAL '1 hour'
  FROM generate_series(1, 500) AS g;
END;
$$;
