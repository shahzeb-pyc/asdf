-- =============================================================================
-- Spec 117 rls-rpc rig: deterministic fixtures.
--
-- Applied once per rig database by check.ts (idempotent: CREATE OR
-- REPLACE). Fixed UUIDs keep every case readable. rls117_reset() clears
-- the tables the assertions touch and re-seeds the two-tenant graph:
--
--   user A (…1111) owns workspace A (…aaaa) and a unified
--     account/destination/queue-item graph.
--   user B (…2222) owns workspace B (…bbbb).
--   A manipulated platform_credentials row sitting in B's workspace
--     (seeded as superuser, bypassing RLS — the row an attacker would
--     plant; the workspace-owner policy must make it invisible to A).
--   media_download_jobs rows for A and B (user_id FKs auth.users, so
--     auth.users is seeded with the same ids).
--
-- Phase 7 (2026-10-24): the pre-unification fixture graph (FB
-- account/page, BYOC rows, legacy queue items) moved to
-- fixtures-legacy.sql, applied ONLY in vulnerable mode (whose database
-- is built pre-drop, so those tables still exist there). The hardened
-- database has the legacy schema dropped by migration
-- 20261024130000 — seeding it here would fail, by design.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rls117_reset()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  TRUNCATE public.media_download_jobs,
           public.platform_credentials,
           public.publish_logs, public.queue_items, public.destinations,
           public.social_accounts,
           public.workspaces, public.users CASCADE;
  TRUNCATE auth.users CASCADE;

  INSERT INTO auth.users (id, email) VALUES
    ('11111111-1111-1111-1111-111111111111', 'rls117.a@gmail.com'),
    ('22222222-2222-2222-2222-222222222222', 'rls117.b@gmail.com');

  INSERT INTO public.users (id, email, name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'rls117.a@gmail.com', 'Rig User A'),
    ('22222222-2222-2222-2222-222222222222', 'rls117.b@gmail.com', 'Rig User B');

  INSERT INTO public.workspaces (id, owner_id, name, subdomain) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Rig WS A', 'rls117-ws-a'),
    ('acacacac-acac-acac-acac-acacacacacac', '11111111-1111-1111-1111-111111111111', 'Rig WS A2', 'rls117-ws-a2'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Rig WS B', 'rls117-ws-b'),
    ('abababab-abab-abab-abab-abababababab', '22222222-2222-2222-2222-222222222222', 'Rig WS C (B, empty)', 'rls117-ws-c');

  -- Legitimate credentials row: A's workspace, facebook platform.
  INSERT INTO public.platform_credentials (id, workspace_id, platform, client_id, encrypted_client_secret) VALUES
    ('e1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'facebook', 'app-a', 'dummy-encrypted-secret-a');

  -- Manipulated credentials row: sits in B's workspace (the planted
  -- row; A's owner-policy must not see it).
  INSERT INTO public.platform_credentials (id, workspace_id, platform, client_id, encrypted_client_secret) VALUES
    ('e2222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'facebook', 'app-planted', 'dummy-encrypted-secret-planted');

  INSERT INTO public.media_download_jobs (user_id, source_url) VALUES
    ('11111111-1111-1111-1111-111111111111', 'https://example.com/a.mp4'),
    ('22222222-2222-2222-2222-222222222222', 'https://example.com/b.mp4');

  -- Minimal unified-schema graph (workspace A) so the unified settle
  -- overload can be exercised end-to-end as service_role.
  INSERT INTO public.social_accounts (id, workspace_id, platform, external_account_id, display_name, encrypted_access_token, status) VALUES
    ('f0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'facebook', 'ext-acct-a', 'Rig Unified Account A', 'dummy-encrypted-access-token', 'active');

  INSERT INTO public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, encrypted_destination_token, status, section) VALUES
    ('f0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000001', 'facebook', 'ext-dest-a', 'Rig Unified Dest A',
     'dummy-encrypted-destination-token', 'active', 'schedule');

  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status) VALUES
    ('f0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig unified caption',
     now() - INTERVAL '1 hour', 'queued');
END;
$$;
