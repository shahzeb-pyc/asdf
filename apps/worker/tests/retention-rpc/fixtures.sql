-- =============================================================================
-- Spec 139 retention rig: deterministic fixtures.
--
-- Applied once per rig database by check.ts (idempotent: CREATE OR
-- REPLACE). Fixed UUIDs keep every case readable. retention_reset()
-- clears the tables the assertions touch and re-seeds a curated graph
-- around the 30-day cutoff (the rig always passes p_cutoff = now() -
-- 30 days, so all ages are relative to run time):
--
--   user A (…1111) owns workspace A (…aaaa), one unified social
--   account + destination, and seven queue items:
--     …c101 published  updated 40d ago  -> item DELETED (old terminal)
--     …c102 failed     updated 31d ago  -> item DELETED (old terminal)
--     …c103 cancelled  updated 90d ago  -> item DELETED (old terminal)
--     …c104 published  updated 29d ago  -> kept (inside the window)
--     …c105 published  updated 30d-1h   -> kept (just inside the window)
--     …c106 queued     updated 60d ago  -> kept (LIVE — never deletable)
--     …c107 publishing updated 60d ago  -> kept (LIVE — never deletable)
--   and six publish_logs:
--     …d101 on c101, created 40d ago -> DELETED (terminal parent, old)
--     …d102 on c104, created 40d ago -> DELETED by the log pass itself
--           (parent terminal, log old — even though the ITEM is recent:
--           proves the log pass is independent of the item pass)
--     …d103 on c104, created 5d ago  -> kept (young log)
--     …d104 on c106, created 40d ago -> KEPT (parent is LIVE)
--     …d105 on c107, created 40d ago -> KEPT (parent is LIVE)
--     …d106 on c101, created 2d ago  -> removed only by CASCADE when
--           c101 is deleted (young log of an old terminal item)
--
-- Expected outcomes at cutoff = now() - 30d:
--   dry-run counts: logs = 2 (d101, d102), items = 3 (c101, c102, c103)
--   full run (one big batch): returns (2, 3); afterwards 4 items remain
--     (c104, c105, c106, c107) and 3 logs remain (d103, d104, d105).
--   batch=1 call sequence: (1,1), (1,1), (0,1), (0,0) — the items pass
--     orders by updated_at (c103 first), the logs pass by created_at
--     (d101 before d102); d106 cascades with c101 on the second call.
--
-- retention_seed_bulk() adds 2,000 old published items so the EXPLAIN
-- assertion exercises the partial terminal index at planner scale.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.retention_reset()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  TRUNCATE public.publish_logs, public.queue_items, public.destinations,
           public.social_accounts, public.workspaces, public.users CASCADE;

  INSERT INTO public.users (id, email, name, updated_at) VALUES
    ('11111111-1111-1111-1111-111111111111', 'retention.a@gmail.com', 'Rig User A', now() - INTERVAL '1 day');

  INSERT INTO public.workspaces (id, owner_id, name, subdomain) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Rig WS A', 'retention-ws-a');

  INSERT INTO public.social_accounts (id, workspace_id, platform, external_account_id, display_name, encrypted_access_token, status) VALUES
    ('f0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'facebook', 'ext-acct-a', 'Rig Unified Account A', 'dummy-encrypted-access-token', 'active');

  INSERT INTO public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, encrypted_destination_token, status, section) VALUES
    ('f0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000001', 'facebook', 'ext-dest-a', 'Rig Unified Dest A',
     'dummy-encrypted-destination-token', 'active', 'schedule');

  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at, created_at, updated_at) VALUES
    ('c101c101-c101-c101-c101-c101c101c101', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig published old',
     now() - INTERVAL '41 days', 'published', NULL, now() - INTERVAL '40 days', now() - INTERVAL '40 days'),
    ('c102c102-c102-c102-c102-c102c102c102', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig failed old',
     now() - INTERVAL '32 days', 'failed', NULL, now() - INTERVAL '31 days', now() - INTERVAL '31 days'),
    ('c103c103-c103-c103-c103-c103c103c103', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig cancelled old',
     now() - INTERVAL '91 days', 'cancelled', NULL, now() - INTERVAL '90 days', now() - INTERVAL '90 days'),
    ('c104c104-c104-c104-c104-c104c104c104', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig published recent',
     now() - INTERVAL '30 days', 'published', NULL, now() - INTERVAL '29 days', now() - INTERVAL '29 days'),
    ('c105c105-c105-c105-c105-c105c105c105', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig published edge',
     now() - INTERVAL '31 days', 'published', NULL, now() - INTERVAL '30 days' + INTERVAL '1 hour', now() - INTERVAL '30 days' + INTERVAL '1 hour'),
    ('c106c106-c106-c106-c106-c106c106c106', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig queued old',
     now() + INTERVAL '1 day', 'queued', NULL, now() - INTERVAL '60 days', now() - INTERVAL '60 days'),
    ('c107c107-c107-c107-c107-c107c107c107', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 'text', 'rig publishing old',
     now() - INTERVAL '61 days', 'publishing', now() - INTERVAL '60 days', now() - INTERVAL '60 days', now() - INTERVAL '60 days');

  INSERT INTO public.publish_logs (id, queue_item_id, destination_id, platform, attempt_no, result, created_at) VALUES
    ('d101d101-d101-d101-d101-d101d101d101', 'c101c101-c101-c101-c101-c101c101c101',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 1, 'success', now() - INTERVAL '40 days'),
    ('d102d102-d102-d102-d102-d102d102d102', 'c104c104-c104-c104-c104-c104c104c104',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 1, 'retry', now() - INTERVAL '40 days'),
    ('d103d103-d103-d103-d103-d103d103d103', 'c104c104-c104-c104-c104-c104c104c104',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 2, 'success', now() - INTERVAL '5 days'),
    ('d104d104-d104-d104-d104-d104d104d104', 'c106c106-c106-c106-c106-c106c106c106',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 1, 'retry', now() - INTERVAL '40 days'),
    ('d105d105-d105-d105-d105-d105d105d105', 'c107c107-c107-c107-c107-c107c107c107',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 1, 'retry', now() - INTERVAL '40 days'),
    ('d106d106-d106-d106-d106-d106d106d106', 'c101c101-c101-c101-c101-c101c101c101',
     'f0000000-0000-0000-0000-000000000002', 'facebook', 2, 'success', now() - INTERVAL '2 days');
END;
$$;

CREATE OR REPLACE FUNCTION public.retention_seed_bulk()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- Planner-scale volume for the EXPLAIN assertion: 2,000 old terminal
  -- rows make the partial index the obviously right plan for the
  -- retention items-selection shape.
  INSERT INTO public.queue_items (id, workspace_id, destination_id, platform, kind, caption, scheduled_time, status, claimed_at, created_at, updated_at)
  SELECT md5('retention-bulk-' || g)::uuid,
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
         'f0000000-0000-0000-0000-000000000002',
         'facebook', 'text', 'rig bulk published ' || g,
         now() - INTERVAL '41 days', 'published', NULL,
         now() - INTERVAL '40 days', now() - INTERVAL '40 days'
  FROM generate_series(1, 2000) AS g;
END;
$$;
