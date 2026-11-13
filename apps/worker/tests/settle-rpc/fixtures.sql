-- =============================================================================
-- Spec 139 settle-rpc rig: deterministic fixtures.
--
-- Applied once per rig database by check.ts (idempotent: CREATE OR
-- REPLACE). Fixed UUIDs keep every case readable. settle139_reset()
-- clears the unified tables the assertions touch and re-seeds a minimal
-- graph:
--
--   user A (…1111) owns workspace A (…aaaa)
--     -> social account (…0001, facebook, active)
--     -> destination (…0002, facebook, active, no cooldown)
--     -> queue item ITEM_MAIN (…0003, facebook text, status 'publishing')
--
-- settle139_add_item(id, status) inserts one more queue item on the same
-- destination so a section can exercise several settles after one reset.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.settle139_reset()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  TRUNCATE public.publish_logs, public.queue_items, public.destinations,
           public.social_accounts, public.workspaces, public.users CASCADE;
  TRUNCATE auth.users CASCADE;

  INSERT INTO auth.users (id, email) VALUES
    ('11111111-1111-1111-1111-111111111111', 'settle139.a@gmail.com');

  INSERT INTO public.users (id, email, name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'settle139.a@gmail.com', 'Rig User A');

  INSERT INTO public.workspaces (id, owner_id, name, subdomain) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Rig WS A', 'settle139-ws-a');

  INSERT INTO public.social_accounts (id, workspace_id, platform, external_account_id, display_name, encrypted_access_token, status) VALUES
    ('f0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'facebook', 'ext-acct-a', 'Rig Unified Account A', 'dummy-encrypted-access-token', 'active');

  INSERT INTO public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, encrypted_destination_token, status, section) VALUES
    ('f0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000001', 'facebook', 'ext-dest-a', 'Rig Unified Dest A',
     'dummy-encrypted-destination-token', 'active', 'schedule');

  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at) VALUES
    ('f0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig settle caption',
     now() - INTERVAL '1 hour', 'publishing', now() - INTERVAL '1 minute');
END;
$$;

CREATE OR REPLACE FUNCTION public.settle139_add_item(p_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at) VALUES
    (p_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig settle caption',
     now() - INTERVAL '1 hour', p_status, CASE WHEN p_status = 'publishing' THEN now() ELSE NULL END);
END;
$$;
