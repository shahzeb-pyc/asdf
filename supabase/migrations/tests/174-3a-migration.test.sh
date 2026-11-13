#!/usr/bin/env bash
# Live migration test for spec 174 PR 3A (claim RPC section parameter).
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), builds a minimal schema with
# the tables the four claim functions touch, applies the real
# workspace_has_active_period migration, applies the 3A forward
# migration, asserts the section behaviour, applies the reverse
# migration, and asserts the old signatures and behaviour are back.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/174-3a-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113060000_claim_rpc_section.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113060000_claim_rpc_section.sql"
HAS_ACTIVE="$ROOT/supabase/migrations/20261110000000_workspace_has_active_period.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
[ -f "$HAS_ACTIVE" ] || { echo "HAS_ACTIVE NOT FOUND: $HAS_ACTIVE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-174-3a-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/reverse.sql"
cp "$HAS_ACTIVE" "$STAGE/has_active.sql"
chown -R postgres:postgres "$STAGE"

setup_cluster() { # $1=workdir $2=port $3=db
  local workdir="$1" port="$2" db="$3"
  rm -rf "$workdir"
  mkdir -p "$workdir" "$workdir/sock"
  chown -R postgres:postgres "$workdir"
  chmod 700 "$workdir"
  su postgres -c "$PG_BIN/initdb -D '$workdir/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$workdir/data' -o \"-k '$workdir/sock' -p $port -c listen_addresses=''\" -l '$workdir/log' start" >/dev/null
  su postgres -c "$PG_BIN/createdb -h '$workdir/sock' -p $port $db" >/dev/null
}

stop_cluster() { # $1=workdir
  local workdir="$1"
  if [ -d "$workdir/data" ]; then
    su postgres -c "$PG_BIN/pg_ctl -D '$workdir/data' -m immediate stop" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}

cleanup() {
  stop_cluster /var/lib/postgresql/16/test-174-3a-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-3a-a/sock' -p 55436 -d test174a -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-3a-a/sock' -p 55436 -d test174a -tA -c '$1'"
}

setup_cluster /var/lib/postgresql/16/test-174-3a-a 55436 test174a

# Roles the grant statements reference (a fresh cluster has none).
PSQL <<'SQL'
create role anon;
create role authenticated;
create role service_role;
create type public.platform as enum ('facebook', 'instagram', 'threads', 'youtube', 'x', 'tiktok');
create table public.users (id uuid primary key, role text not null);
create table public.workspaces (id uuid primary key, owner_id uuid not null);
create table public.social_accounts (
  id uuid primary key, workspace_id uuid not null, platform public.platform not null,
  external_account_id text not null, status text not null,
  token_expires_at timestamptz, encrypted_access_token text
);
create table public.destinations (
  id uuid primary key, workspace_id uuid not null, account_id uuid,
  platform public.platform not null, external_destination_id text,
  name text, timezone text, status text not null, metadata jsonb not null default '{}'::jsonb,
  encrypted_destination_token text, section text,
  updated_at timestamptz not null default now(), rate_usage_pct smallint
);
create table public.subscription_periods (
  id uuid primary key, user_id uuid not null,
  facebook_count int not null default 0, instagram_count int not null default 0,
  threads_count int not null default 0, x_count int not null default 0,
  tiktok_count int not null default 0, youtube_count int not null default 0,
  starts_at timestamptz not null, ends_at timestamptz not null, superseded_at timestamptz
);
create table public.subscription_usage (
  id uuid primary key, user_id uuid not null, platform text not null,
  destination_key text not null, feature text not null,
  destination_id uuid, section text
);
create table public.posting_slots (
  id uuid primary key, destination_id uuid not null,
  time_of_day time not null, kind text[] not null, is_active boolean not null default true
);
create table public.queue_items (
  id uuid primary key, workspace_id uuid not null, destination_id uuid not null,
  media_item_id uuid, kind character varying not null, platform_format character varying,
  link_url text, caption text, title text, first_comment text,
  platform_options jsonb, scheduled_time timestamptz, status text not null,
  claimed_at timestamptz, retry_count int not null default 0, max_retries int not null default 5,
  external_post_id text, external_comment_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  publish_now_requested_at timestamptz, queue_seq int, media_url text,
  media_storage_key character varying, slot_id uuid, platform public.platform not null,
  error_code text, error_subcode text, error_message text
);
create table public.posting_slot_claims (
  destination_id uuid not null, slot_id uuid not null, claim_date date not null,
  queue_item_id uuid, primary key (destination_id, slot_id, claim_date)
);
create table public.destination_claim_limits (
  platform public.platform not null, metric text not null,
  window_seconds int not null, cap int not null
);
create table public.publish_logs (
  id uuid primary key default gen_random_uuid(), destination_id uuid,
  created_at timestamptz not null default now(), result text,
  queue_item_id uuid
);
create table public.media_items (
  id uuid primary key, url text, storage_key text, media_type text
);
SQL

# The real workspace_has_active_period (C4) — can_publish_for calls it.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-3a-a/sock' -p 55436 -d test174a -v ON_ERROR_STOP=1 -q -f '$STAGE/has_active.sql'"

# Seed: one user/workspace/account, one page in TWO sections (schedule +
# adu), a slot on the schedule row only, due + queued items, a live
# period capped at 1 Facebook page, and ONE usage row — in 'adu' only.
# The page is therefore registered only in Auto Download while the
# Schedule copy exists: the 2B blind spot, exactly.
PSQL <<'SQL'
insert into public.users values ('11111111-1111-1111-1111-111111111111', 'user');
insert into public.workspaces values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
insert into public.social_accounts values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'facebook', 'ext-acct-1', 'active', null, 'tok');
insert into public.subscription_periods values ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 1, 0, 0, 0, 0, 0, now() - interval '1 day', now() + interval '30 days', null);
insert into public.destinations values
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-x', 'Page X', 'UTC', 'active', '{}'::jsonb, 'tok', 'schedule', now(), null),
  ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-x', 'Page X', 'UTC', 'active', '{}'::jsonb, 'tok', 'adu', now(), null);
-- slot time = this UTC minute, so the occurrence is inside the window below
insert into public.posting_slots values
  ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', (date_trunc('minute', now() at time zone 'UTC'))::time, array['text'], true),
  ('66666666-6666-6666-6666-666666666667', '44444444-4444-4444-4444-444444444444', (date_trunc('minute', now() at time zone 'UTC'))::time, array['text'], true);
insert into public.queue_items (id, workspace_id, destination_id, kind, platform_format, status, platform, queue_seq, scheduled_time) values
  ('88888888-8888-8888-8888-888888888881', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'text', 'text', 'queued', 'facebook', 1, null),
  ('88888888-8888-8888-8888-888888888882', '22222222-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 'text', 'text', 'queued', 'facebook', 1, now()),
  ('88888888-8888-8888-8888-888888888883', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'text', 'text', 'queued', 'facebook', 2, null),
  ('88888888-8888-8888-8888-888888888884', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'text', 'text', 'queued', 'facebook', 3, now());
insert into public.subscription_usage values ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'facebook', 'page-x', 'auto-download-upload', '55555555-5555-5555-5555-555555555555', 'adu');
insert into public.destination_claim_limits values ('facebook', 'calls', 3600, 100);
SQL

echo "seeded"

# --- apply the forward migration ------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-3a-a/sock' -p 55436 -d test174a -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions ----------------------------------------------------
PSQL <<'SQL'
do $$
declare
  v int;
  v_bool boolean;
  v_claim uuid;
begin
  -- signatures: new ones exist, old ones are gone
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'can_publish_for'
      and pg_get_function_identity_arguments(p.oid) like '%p_section%';
  if v <> 1 then raise exception 'can_publish_for 5-arg signature missing'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'can_publish_for'
      and pg_get_function_identity_arguments(p.oid) not like '%p_section%';
  if v <> 0 then raise exception 'old 4-arg can_publish_for still present'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_posting_slot_item'
      and pg_get_function_identity_arguments(p.oid) like '%p_section%';
  if v <> 1 then raise exception 'slot claim 6-arg signature missing'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_active_facebook_posting_slots'
      and pg_get_function_identity_arguments(p.oid) like '%p_section%';
  if v <> 1 then raise exception 'slot lister 1-arg signature missing'; end if;

  -- lister: schedule sees the slot, adu sees nothing, NULL sees it (compat)
  select count(*) into v from public.list_active_facebook_posting_slots('schedule');
  if v <> 2 then raise exception 'lister(schedule) returned % rows <> 2', v; end if;
  select count(*) into v from public.list_active_facebook_posting_slots('adu');
  if v <> 0 then raise exception 'lister(adu) returned % rows <> 0', v; end if;
  select count(*) into v from public.list_active_facebook_posting_slots(NULL);
  if v <> 2 then raise exception 'lister(NULL) returned % rows <> 2', v; end if;

  -- can_publish_for section gate: registered only in adu, period capped at 1
  select public.can_publish_for('22222222-2222-2222-2222-222222222222', 'facebook', 'page-x', now(), 'schedule') into v_bool;
  if v_bool then raise exception 'can_publish_for(schedule) passed for an adu-only registration'; end if;
  select public.can_publish_for('22222222-2222-2222-2222-222222222222', 'facebook', 'page-x', now(), 'adu') into v_bool;
  if not v_bool then raise exception 'can_publish_for(adu) failed for the adu registration'; end if;
  select public.can_publish_for('22222222-2222-2222-2222-222222222222', 'facebook', 'page-x', now(), NULL) into v_bool;
  if not v_bool then raise exception 'can_publish_for(NULL) failed (compat)'; end if;
  -- cap branch still works across sections: raise the cap, schedule passes
  update public.subscription_periods set facebook_count = 2 where id = '77777777-7777-7777-7777-777777777777';
  select public.can_publish_for('22222222-2222-2222-2222-222222222222', 'facebook', 'page-x', now(), 'schedule') into v_bool;
  if not v_bool then raise exception 'can_publish_for(schedule) failed under cap'; end if;
  update public.subscription_periods set facebook_count = 1 where id = '77777777-7777-7777-7777-777777777777';

  -- slot claim: needs the schedule registration first (the gate
  -- below is entitlement-aware), so the due claim runs first while
  -- the page is registered only in adu.
  -- due claim: the adu-due item claims (adu registration exists); the
  -- schedule-due item does NOT claim while the page is registered only
  -- in adu and the period is at cap.
  select count(*) into v from public.claim_due_queue_items('facebook', null, 500, 3);
  if v <> 1 then raise exception 'due claim returned % rows <> 1', v; end if;
  select count(*) into v from public.queue_items where id = '88888888-8888-8888-8888-888888888882' and status = 'publishing';
  if v <> 1 then raise exception 'adu due item was not claimed'; end if;
  select count(*) into v from public.queue_items where id = '88888888-8888-8888-8888-888888888884' and status = 'queued';
  if v <> 1 then raise exception 'schedule due item claimed despite adu-only registration at cap'; end if;
  -- register the page in schedule too: the schedule slot and due
  -- items now claim
  insert into public.subscription_usage values ('99999999-9999-9999-9999-999999999998', '11111111-1111-1111-1111-111111111111', 'facebook', 'page-x', 'destination-queue', '44444444-4444-4444-4444-444444444444', 'schedule');
  select id into v_claim from public.claim_posting_slot_item(
    '44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666',
    (now() at time zone 'UTC')::date, now(), 60, 'schedule');
  if v_claim is null then raise exception 'schedule slot claim returned nothing'; end if;
  if v_claim <> '88888888-8888-8888-8888-888888888881' then raise exception 'schedule slot claim returned %', v_claim; end if;
  select count(*) into v from public.claim_posting_slot_item(
    '44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666',
    (now() at time zone 'UTC')::date, now(), 60, 'schedule');
  if v <> 0 then raise exception 'second claim for the same slot+day returned % rows', v; end if;
  select count(*) into v from public.claim_posting_slot_item(
    '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666',
    (now() at time zone 'UTC')::date, now(), 60, 'adu');
  if v <> 0 then raise exception 'adu claim for a schedule slot returned % rows', v; end if;
  -- NULL-section compat: the 4-arg call still claims (rigs rely on it)
  select id into v_claim from public.claim_posting_slot_item(
    '44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666667',
    (now() at time zone 'UTC')::date, now());
  if v_claim is null then raise exception '4-arg slot claim returned nothing'; end if;
  if v_claim <> '88888888-8888-8888-8888-888888888883' then raise exception '4-arg slot claim returned %', v_claim; end if;
  -- due claim after schedule registration: the schedule due item claims
  select count(*) into v from public.claim_due_queue_items('facebook', null, 500, 3);
  if v <> 1 then raise exception 'due claim after schedule registration returned % rows <> 1', v; end if;
  select count(*) into v from public.queue_items where id = '88888888-8888-8888-8888-888888888884' and status = 'publishing';
  if v <> 1 then raise exception 'schedule due item was not claimed after registration'; end if;

  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "forward migration + assertions passed"

# --- apply the reverse migration -------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-3a-a/sock' -p 55436 -d test174a -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- reverse assertions ------------------------------------------------------
PSQL <<'SQL'
do $$
declare
  v int;
  v_claim uuid;
begin
  -- old signatures are back, new ones are gone
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'can_publish_for'
      and pg_get_function_identity_arguments(p.oid) not like '%p_section%';
  if v <> 1 then raise exception 'reverse: old 4-arg can_publish_for missing'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'can_publish_for'
      and pg_get_function_identity_arguments(p.oid) like '%p_section%';
  if v <> 0 then raise exception 'reverse: 5-arg can_publish_for still present'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_active_facebook_posting_slots'
      and pg_get_function_identity_arguments(p.oid) = '';
  if v <> 1 then raise exception 'reverse: old 0-arg lister missing'; end if;

  -- old behaviour is back: the 4-arg slot claim works on a fresh slot
  insert into public.posting_slots values
    ('66666666-6666-6666-6666-666666666668', '44444444-4444-4444-4444-444444444444', (date_trunc('minute', now() at time zone 'UTC'))::time, array['text'], true);
  insert into public.queue_items (id, workspace_id, destination_id, kind, platform_format, status, platform, queue_seq, scheduled_time) values
    ('88888888-8888-8888-8888-888888888885', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'text', 'text', 'queued', 'facebook', 4, null);
  select id into v_claim from public.claim_posting_slot_item(
    '44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666668',
    (now() at time zone 'UTC')::date, now());
  if v_claim is null then raise exception 'reverse: 4-arg slot claim returned nothing'; end if;
  if v_claim <> '88888888-8888-8888-8888-888888888885' then raise exception 'reverse: 4-arg slot claim returned %', v_claim; end if;

  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "reverse migration + assertions passed"
echo "174-3a migration test: ALL PASSED"
