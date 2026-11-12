#!/usr/bin/env bash
# Live migration test for spec 174 PR 1A (destinations section label + backfill).
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system user
# (postgres refuses to run as root), seeds a minimal pre-migration schema
# with representative rows, applies the forward migration, asserts Gate 1A,
# applies the reverse migration, asserts the rollback, then tears the
# cluster down. Nothing touches the live database.
#
#   bash supabase/migrations/tests/174-1a-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261112150000_destinations_section_label.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261112150000_destinations_section_label.sql"
WORKDIR=/var/lib/postgresql/16/test-174-1a
SOCKDIR="$WORKDIR/sock"
PORT=55433
DB=test174

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

cleanup() {
  if [ -d "$WORKDIR/data" ]; then
    su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -m immediate stop" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR" "$SOCKDIR"
chown -R postgres:postgres "$WORKDIR"
chmod 700 "$WORKDIR"

su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$SOCKDIR' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
su postgres -c "$PG_BIN/createdb -h '$SOCKDIR' -p $PORT $DB" >/dev/null

PSQL() {
  su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() { # single query, tuples-only output (for counts)
  su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -tA -c '$1'"
}

# --- minimal pre-migration schema (same constraints that matter) ---------
PSQL <<'SQL'
create table public.workspaces (id uuid primary key, name text not null);
create table public.social_accounts (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id),
  platform text not null,
  status text not null default 'active'
);
create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  platform text not null,
  external_destination_id varchar not null,
  name varchar not null,
  handle varchar,
  avatar_url text,
  timezone varchar not null default 'UTC',
  status varchar not null default 'active',
  encrypted_destination_token text,
  rate_usage_pct smallint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  refresh_lease_owner text,
  refresh_lease_expires_at timestamptz,
  constraint uq_destinations_account_external unique (account_id, external_destination_id)
);
create table public.posting_slots (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.destinations(id) on delete cascade,
  time_of_day text not null
);
create table public.queue_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  destination_id uuid not null references public.destinations(id) on delete cascade,
  platform text not null,
  publish_now_requested_at timestamptz
);
create table public.publish_logs (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.destinations(id) on delete cascade
);
create table public.posting_slot_claims (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.destinations(id) on delete cascade,
  slot_id uuid not null,
  claim_date date not null
);
create table public.adu_configs (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.destinations(id) on delete cascade unique
);
create table public.mirrors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  target_platform text not null,
  target_external_id text not null,
  status text not null default 'active'
);
create table public.subscription_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  platform text not null,
  destination_key text not null,
  feature text not null,
  destination_id uuid,
  created_at timestamptz not null default now()
);
SQL

# --- seed: 9 evidenced rows + the 16 real no-evidence ids + the IG row ---
PSQL <<'SQL'
insert into public.workspaces values ('11111111-1111-1111-1111-111111111111', 'ws');
insert into public.social_accounts values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'facebook', 'active'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'facebook', 'active'),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'instagram', 'active');

-- D1 sched-only (slots) · D2 sched-only (queue + publish-now row)
-- D3 adu-only (config + usage) · D4 adu-only (config, NO usage row)
-- D5 mirror-only (mirror + usage)
-- D6 sched+adu (slots + config + 2 usage rows)
-- D7 sched+mirror (queue + mirror + 2 usage rows)
-- D8 all three (slots + config + mirror + 3 usage rows)
-- D9 sched+adu, NULL token, disconnected
insert into public.destinations
  (id, workspace_id, account_id, platform, external_destination_id, name, status, encrypted_destination_token, metadata) values
  ('10000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-d1', 'D1', 'active', 'enc-d1', '{"starting_followers": 10, "current_followers": 12}'),
  ('10000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-d2', 'D2', 'active', 'enc-d2', '{}'),
  ('10000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-d3', 'D3', 'active', 'enc-d3', '{}'),
  ('10000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-d4', 'D4', 'active', 'enc-d4', '{}'),
  ('10000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-d5', 'D5', 'active', 'enc-d5', '{}'),
  ('10000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-d6', 'D6', 'active', 'enc-d6', '{"starting_followers": 5, "current_followers": 7}'),
  ('10000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-d7', 'D7', 'active', 'enc-d7', '{}'),
  ('10000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-d8', 'D8', 'active', 'enc-d8', '{}'),
  ('10000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-d9', 'D9', 'disconnected', null, '{}');

-- the 16 owner-confirmed no-evidence Facebook rows (verbatim ids)
insert into public.destinations
  (id, workspace_id, account_id, platform, external_destination_id, name, status, encrypted_destination_token, metadata)
select x, '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-noev-' || left(x::text, 8), 'NoEv', 'active', 'enc-noev', '{}'
from unnest(array[
  'e3a6a989-eeb3-44e6-a157-4c5ff1b364f8', 'f78eaf14-94a5-421c-8e54-b81915e17135',
  '6258695c-b29c-44b6-b028-76bd2e940afa', 'c6a7f476-b0b1-4690-9e3e-4d6cad907ede',
  '63b31526-a956-43d6-b8e3-8c892d6ae010', '1ebd7a14-0ce9-4273-b243-147e60763f26',
  '382097bf-292c-45de-9ff9-c087617acfef', 'bd40cee4-863e-4fc6-ba57-1583b4ca634e',
  'f4699dd3-d83e-4f93-ac61-0fc35a2928c6', 'db7475a8-c143-49e2-93ee-3823ffb9debf',
  'd7311301-58a9-4ed1-b3e0-65bb87745fe7', 'e69663b5-04b4-4dcc-8fa1-6276aa7a563e',
  '25384b0d-6bad-49a1-ac8e-82c1653de8dd', '24113f75-6e00-41fa-a25e-c6099697139c',
  'a8dc82af-bf5e-4cb6-9441-41cebe1b8406', 'e820b678-c35b-4bbd-8005-dcd050eb7b95'
]::uuid[]) as x;

-- the Instagram correction row (shahzeb.pxp)
insert into public.destinations
  (id, workspace_id, account_id, platform, external_destination_id, name, status, encrypted_destination_token, metadata) values
  ('a6a8ac7c-a449-4f2c-a959-aefda650f2e1', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'instagram', '17841456440622459', 'shahzeb.pxp', 'active', null, '{}');

insert into public.posting_slots (destination_id, time_of_day) values
  ('10000000-0000-0000-0000-000000000001', '09:00'),
  ('10000000-0000-0000-0000-000000000006', '10:00'),
  ('10000000-0000-0000-0000-000000000008', '11:00'),
  ('10000000-0000-0000-0000-000000000009', '12:00');

insert into public.queue_items (workspace_id, destination_id, platform, publish_now_requested_at) values
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000002', 'facebook', now()),
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000007', 'facebook', null),
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000008', 'facebook', null);

insert into public.publish_logs (destination_id) values
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000006'),
  ('10000000-0000-0000-0000-000000000008');

insert into public.posting_slot_claims (destination_id, slot_id, claim_date) values
  ('10000000-0000-0000-0000-000000000001', gen_random_uuid(), current_date),
  ('10000000-0000-0000-0000-000000000006', gen_random_uuid(), current_date);

insert into public.adu_configs (destination_id) values
  ('10000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000004'),
  ('10000000-0000-0000-0000-000000000006'),
  ('10000000-0000-0000-0000-000000000008'),
  ('10000000-0000-0000-0000-000000000009');

insert into public.mirrors (workspace_id, target_platform, target_external_id, status) values
  ('11111111-1111-1111-1111-111111111111', 'facebook', 'page-d5', 'active'),
  ('11111111-1111-1111-1111-111111111111', 'facebook', 'page-d7', 'active'),
  ('11111111-1111-1111-1111-111111111111', 'facebook', 'page-d8', 'active');

insert into public.subscription_usage (user_id, platform, destination_key, feature, destination_id) values
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d1', 'destination-queue', '10000000-0000-0000-0000-000000000001'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d3', 'auto-download-upload', '10000000-0000-0000-0000-000000000003'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d5', 'tiktok-mirror', '10000000-0000-0000-0000-000000000005'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d6', 'destination-queue', '10000000-0000-0000-0000-000000000006'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d6', 'auto-download-upload', '10000000-0000-0000-0000-000000000006'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d7', 'destination-queue', '10000000-0000-0000-0000-000000000007'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d7', 'tiktok-mirror', '10000000-0000-0000-0000-000000000007'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d8', 'destination-queue', '10000000-0000-0000-0000-000000000008'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d8', 'auto-download-upload', '10000000-0000-0000-0000-000000000008'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d8', 'tiktok-mirror', '10000000-0000-0000-0000-000000000008'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d9', 'auto-download-upload', '10000000-0000-0000-0000-000000000009'),
  -- 6 orphaned usage rows (5 ADU + 1 queue), pointing at nothing
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'gone-1', 'auto-download-upload', '60000000-0000-0000-0000-000000000001'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'gone-2', 'auto-download-upload', '60000000-0000-0000-0000-000000000002'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'gone-3', 'auto-download-upload', '60000000-0000-0000-0000-000000000003'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'gone-4', 'auto-download-upload', '60000000-0000-0000-0000-000000000004'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'gone-5', 'auto-download-upload', '60000000-0000-0000-0000-000000000005'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'gone-6', 'destination-queue', '60000000-0000-0000-0000-000000000006');
SQL

echo "seeded: destinations=$(PSQL_TA 'select count(*) from destinations') (expect 26), usage=$(PSQL_TA 'select count(*) from subscription_usage') (expect 17)"

# --- apply the forward migration (its own assertions run inside) --------
su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -v ON_ERROR_STOP=1 -q -f '$MIGRATION'"

# --- Gate 1A assertions --------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  -- section counts: schedule 6, adu 5, mirror 3, publish_now 0, total 14
  select count(*) into v from destinations where section = 'schedule';
  if v <> 6 then raise exception 'schedule rows % <> 6', v; end if;
  select count(*) into v from destinations where section = 'adu';
  if v <> 5 then raise exception 'adu rows % <> 5', v; end if;
  select count(*) into v from destinations where section = 'mirror';
  if v <> 3 then raise exception 'mirror rows % <> 3', v; end if;
  select count(*) into v from destinations where section = 'publish_now';
  if v <> 0 then raise exception 'publish_now rows % <> 0', v; end if;
  select count(*) into v from destinations;
  if v <> 14 then raise exception 'total destinations % <> 14', v; end if;
  select count(*) into v from destinations where section is null;
  if v <> 0 then raise exception '% rows left with NULL section', v; end if;

  -- the 16 + 1 are gone
  select count(*) into v from destinations where id = any (array[
    'e3a6a989-eeb3-44e6-a157-4c5ff1b364f8','f78eaf14-94a5-421c-8e54-b81915e17135',
    '6258695c-b29c-44b6-b028-76bd2e940afa','c6a7f476-b0b1-4690-9e3e-4d6cad907ede',
    '63b31526-a956-43d6-b8e3-8c892d6ae010','1ebd7a14-0ce9-4273-b243-147e60763f26',
    '382097bf-292c-45de-9ff9-c087617acfef','bd40cee4-863e-4fc6-ba57-1583b4ca634e',
    'f4699dd3-d83e-4f93-ac61-0fc35a2928c6','db7475a8-c143-49e2-93ee-3823ffb9debf',
    'd7311301-58a9-4ed1-b3e0-65bb87745fe7','e69663b5-04b4-4dcc-8fa1-6276aa7a563e',
    '25384b0d-6bad-49a1-ac8e-82c1653de8dd','24113f75-6e00-41fa-a25e-c6099697139c',
    'a8dc82af-bf5e-4cb6-9441-41cebe1b8406','e820b678-c35b-4bbd-8005-dcd050eb7b95',
    'a6a8ac7c-a449-4f2c-a959-aefda650f2e1']::uuid[]);
  if v <> 0 then raise exception '% of the 17 deleted rows still present', v; end if;

  -- exactly 5 split copies, each token byte-identical to its original
  select count(*) into v from destinations where metadata ? 'split_from_destination_id';
  if v <> 5 then raise exception 'split copies % <> 5', v; end if;
  select count(*) into v
  from destinations c join destinations o
    on o.id = (c.metadata ->> 'split_from_destination_id')::uuid
  where c.encrypted_destination_token is distinct from o.encrypted_destination_token;
  if v <> 0 then raise exception '% copies with a differing token', v; end if;
  -- the NULL-token split (D9) copied NULL, not a value
  select count(*) into v from destinations c
  where (c.metadata ->> 'split_from_destination_id')::uuid = '10000000-0000-0000-0000-000000000009'
    and c.encrypted_destination_token is not null;
  if v <> 0 then raise exception 'NULL-token copy gained a token', v; end if;
  -- followers copied byte-for-byte on the D6 ADU copy
  select count(*) into v from destinations c
  where (c.metadata ->> 'split_from_destination_id')::uuid = '10000000-0000-0000-0000-000000000006'
    and c.section = 'adu'
    and c.metadata ->> 'starting_followers' = '5'
    and c.metadata ->> 'current_followers' = '7';
  if v <> 1 then raise exception 'D6 ADU copy lost its follower counts', v; end if;

  -- ADU configs moved to the ADU copies; single-section configs stayed
  select count(*) into v from adu_configs ac join destinations d on d.id = ac.destination_id
  where d.section = 'adu' and (d.metadata ->> 'split_from_destination_id')::uuid
    in ('10000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000009');
  if v <> 3 then raise exception '% configs on split ADU copies <> 3', v; end if;
  select count(*) into v from adu_configs ac
  where ac.destination_id in ('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
  if v <> 2 then raise exception '% configs on untouched ADU rows <> 2', v; end if;

  -- usage rows: 11 left (6 orphans deleted), each on its feature's section
  select count(*) into v from subscription_usage;
  if v <> 11 then raise exception 'usage rows % <> 11', v; end if;
  select count(*) into v from subscription_usage su join destinations d on d.id = su.destination_id
  where (su.feature = 'auto-download-upload' and d.section <> 'adu')
     or (su.feature = 'destination-queue' and d.section <> 'schedule')
     or (su.feature = 'tiktok-mirror' and d.section <> 'mirror');
  if v <> 0 then raise exception '% usage rows on the wrong section', v; end if;
  -- D8's three usage rows sit on three different rows now
  select count(distinct destination_id) into v from subscription_usage
  where destination_key = 'page-d8';
  if v <> 3 then raise exception 'D8 usage rows span % destinations <> 3', v; end if;

  -- schedule children never moved (slots / queue / logs / claims on originals)
  select count(*) into v from posting_slots where destination_id not in (
    '10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000006',
    '10000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000009');
  if v <> 0 then raise exception 'posting_slots moved off the Schedule rows', v; end if;
  select count(*) into v from queue_items where publish_now_requested_at is not null
    and destination_id <> '10000000-0000-0000-0000-000000000002';
  if v <> 1 then raise exception 'publish-now queue row moved', v; end if;

  -- the new unique key holds: same page + same section conflicts,
  -- same page + different section is allowed
  begin
    insert into destinations (workspace_id, account_id, platform, external_destination_id, name, section)
    values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','facebook','page-d1','dup','schedule');
    raise exception 'duplicate (account, page, section) was allowed';
  exception when unique_violation then null;
  end;
  insert into destinations (workspace_id, account_id, platform, external_destination_id, name, section)
  values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','facebook','page-d1','D1-adu','adu');
  delete from destinations where name = 'D1-adu';

  raise notice 'GATE 1A ASSERTIONS PASSED';
end $$;
SQL

echo "forward migration + Gate 1A assertions passed"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -v ON_ERROR_STOP=1 -q -f '$REVERSE'"

# --- rollback assertions -------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  -- 9 destinations left (26 seeded minus the 17 owner-ordered deletes)
  select count(*) into v from destinations;
  if v <> 9 then raise exception 'after reverse: destinations % <> 9', v; end if;
  -- no split copies remain
  select count(*) into v from destinations where metadata ? 'split_from_destination_id';
  if v <> 0 then raise exception 'after reverse: % split copies remain', v; end if;
  -- the section column is gone
  select count(*) into v from information_schema.columns
  where table_schema = 'public' and table_name = 'destinations' and column_name = 'section';
  if v <> 0 then raise exception 'after reverse: section column still present', v; end if;
  -- the old unique key is back
  select count(*) into v from pg_constraint
  where conrelid = 'public.destinations'::regclass and conname = 'uq_destinations_account_external';
  if v <> 1 then raise exception 'after reverse: old unique key not restored', v; end if;
  -- children are back on the originals
  select count(*) into v from adu_configs
  where destination_id in ('10000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000009');
  if v <> 3 then raise exception 'after reverse: % configs back on originals <> 3', v; end if;
  select count(*) into v from subscription_usage
  where destination_id in ('10000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000008');
  if v <> 7 then raise exception 'after reverse: % usage rows back on originals <> 7', v; end if;
  select count(*) into v from subscription_usage;
  if v <> 11 then raise exception 'after reverse: usage rows % <> 11', v; end if;
  -- the old key is enforced again
  begin
    insert into destinations (workspace_id, account_id, platform, external_destination_id, name)
    values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','facebook','page-d1','dup');
    raise exception 'duplicate (account, page) was allowed after reverse';
  exception when unique_violation then null;
  end;

  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "reverse migration + rollback assertions passed"
echo "ALL 174-1A MIGRATION TESTS PASSED"
