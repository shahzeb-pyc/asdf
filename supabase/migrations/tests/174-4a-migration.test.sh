#!/usr/bin/env bash
# Live migration test for spec 174 PR 4A part 2 (the lock).
#
# Spins up throwaway PostgreSQL 16 clusters as the `postgres` system
# user (postgres refuses to run as root), builds a minimal schema with
# the tables the lock migration touches, and runs three scenarios:
#   A — forward labels two single-evidence NULL rows, sets NOT NULL,
#       and all assertions pass; reverse drops the lock and keeps labels.
#   B — negative control: a NULL row with NO evidence makes the forward
#       migration fail loudly, and the lock is not applied.
#   C — negative control: a NULL row with MULTI-section evidence makes
#       the forward migration fail loudly, and the lock is not applied.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/174-4a-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the servers and removing the clusters.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113160000_destinations_section_not_null.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113160000_destinations_section_not_null.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-174-4a-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/reverse.sql"
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
  stop_cluster /var/lib/postgresql/16/test-174-4a-a
  stop_cluster /var/lib/postgresql/16/test-174-4a-b
  stop_cluster /var/lib/postgresql/16/test-174-4a-c
  rm -rf "$STAGE"
}
trap cleanup EXIT

# psql against a cluster; SQL comes from stdin.
PSQL_A() { su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-4a-a/sock' -p 55437 -d test174a -v ON_ERROR_STOP=1 -q"; }
PSQL_B() { su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-4a-b/sock' -p 55438 -d test174b -v ON_ERROR_STOP=1 -q"; }
PSQL_C() { su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-4a-c/sock' -p 55439 -d test174c -v ON_ERROR_STOP=1 -q"; }
# Assert the lock was NOT applied in a negative-control cluster.
# $1 = PSQL function for that cluster.

# Minimal schema the lock migration touches. $1 = psql function name.
create_schema() { # $1=PSQL function
  "$1" <<'SQL'
create type public.platform as enum ('facebook', 'instagram', 'threads', 'youtube', 'x', 'tiktok');
create table public.destinations (
  id uuid primary key, workspace_id uuid not null, account_id uuid,
  platform public.platform not null, external_destination_id text,
  name text, timezone text, status text not null, metadata jsonb not null default '{}'::jsonb,
  encrypted_destination_token text, section text
    constraint destinations_section_check
    check (section in ('schedule', 'adu', 'mirror', 'publish_now')),
  updated_at timestamptz not null default now()
);
create table public.posting_slots (id uuid primary key, destination_id uuid not null);
create table public.queue_items (id uuid primary key, destination_id uuid not null);
create table public.adu_configs (id uuid primary key, destination_id uuid not null);
create table public.mirrors (id uuid primary key, workspace_id uuid not null, target_platform text not null, target_external_id text not null);
create table public.publish_logs (id uuid primary key, destination_id uuid);
create table public.posting_slot_claims (destination_id uuid not null, slot_id uuid not null, claim_date date not null, primary key (destination_id, slot_id, claim_date));
create table public.subscription_usage (
  id uuid primary key, destination_id uuid, destination_key text not null,
  feature text not null, section text
);
SQL
}

assert_lock_off() { # $1=PSQL function
  "$1" <<'SQL'
do $$
declare
  v text;
begin
  select is_nullable into v from information_schema.columns
  where table_schema = 'public' and table_name = 'destinations' and column_name = 'section';
  if v <> 'YES' then raise exception 'negative control: lock applied despite the failed migration (is_nullable=%)', v; end if;
end $$;
SQL
}

# =====================================================================
# Cluster A — the happy path
# =====================================================================
setup_cluster /var/lib/postgresql/16/test-174-4a-a 55437 test174a
create_schema PSQL_A
PSQL_A <<'SQL'
-- schedule row + slot; adu row + config; mirror row + mirror; publish_now row, no evidence.
insert into public.destinations values
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-sched', 'Page Sched', 'UTC', 'active', '{}'::jsonb, 'tok', 'schedule', now()),
  ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-adu', 'Page Adu', 'UTC', 'active', '{}'::jsonb, 'tok', 'adu', now()),
  ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-mirror', 'Page Mirror', 'UTC', 'active', '{}'::jsonb, 'tok', 'mirror', now()),
  ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-pn', 'Page PN', 'UTC', 'active', '{}'::jsonb, 'tok', 'publish_now', now()),
  -- NULL stragglers: one with schedule evidence only, one with adu evidence only.
  ('88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-null-sched', 'Page Null Sched', 'UTC', 'active', '{}'::jsonb, 'tok', null, now()),
  ('99999999-9999-9999-9999-999999999999', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-null-adu', 'Page Null Adu', 'UTC', 'active', '{}'::jsonb, 'tok', null, now());
insert into public.posting_slots values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', '88888888-8888-8888-8888-888888888888');
insert into public.adu_configs values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55555555-5555-5555-5555-555555555555'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', '99999999-9999-9999-9999-999999999999');
insert into public.mirrors values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'facebook', 'page-mirror');
insert into public.subscription_usage values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'page-sched', 'destination-queue', 'schedule'),
  ('dddddddd-dddd-dddd-dddd-ddddddddddee', '55555555-5555-5555-5555-555555555555', 'page-adu', 'auto-download-upload', 'adu');
SQL
echo "cluster A seeded"

# --- apply the forward migration ------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-4a-a/sock' -p 55437 -d test174a -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions ----------------------------------------------------
PSQL_A <<'SQL'
do $$
declare
  v text;
  v_int int;
begin
  select is_nullable into v from information_schema.columns
  where table_schema = 'public' and table_name = 'destinations' and column_name = 'section';
  if v <> 'NO' then raise exception 'forward: section is_nullable = %, expected NO', v; end if;

  -- the two stragglers were labelled by their single evidence
  select section into v from public.destinations where id = '88888888-8888-8888-8888-888888888888';
  if v <> 'schedule' then raise exception 'forward: null-sched straggler labelled %, expected schedule', v; end if;
  select section into v from public.destinations where id = '99999999-9999-9999-9999-999999999999';
  if v <> 'adu' then raise exception 'forward: null-adu straggler labelled %, expected adu', v; end if;

  -- counts: schedule 2, adu 2, mirror 1, publish_now 1, total 6, NULL 0
  select count(*) into v_int from public.destinations where section = 'schedule';
  if v_int <> 2 then raise exception 'forward: schedule rows % <> 2', v_int; end if;
  select count(*) into v_int from public.destinations where section = 'adu';
  if v_int <> 2 then raise exception 'forward: adu rows % <> 2', v_int; end if;
  select count(*) into v_int from public.destinations where section = 'mirror';
  if v_int <> 1 then raise exception 'forward: mirror rows % <> 1', v_int; end if;
  select count(*) into v_int from public.destinations where section = 'publish_now';
  if v_int <> 1 then raise exception 'forward: publish_now rows % <> 1', v_int; end if;
  select count(*) into v_int from public.destinations where section is null;
  if v_int <> 0 then raise exception 'forward: % NULL sections remain', v_int; end if;

  -- inserting a NULL-section row now fails (the lock is real)
  begin
    insert into public.destinations values
      ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-null-new', 'Page Null New', 'UTC', 'active', '{}'::jsonb, 'tok', null, now());
    raise exception 'forward: NULL-section insert succeeded despite NOT NULL';
  exception when not_null_violation then
    null; -- expected
  end;

  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL
echo "cluster A forward migration + assertions passed"

# --- apply the reverse migration -------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-4a-a/sock' -p 55437 -d test174a -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- reverse assertions ------------------------------------------------------
PSQL_A <<'SQL'
do $$
declare
  v text;
begin
  select is_nullable into v from information_schema.columns
  where table_schema = 'public' and table_name = 'destinations' and column_name = 'section';
  if v <> 'YES' then raise exception 'reverse: section is_nullable = %, expected YES', v; end if;

  -- labels stay after the reverse
  select section into v from public.destinations where id = '88888888-8888-8888-8888-888888888888';
  if v <> 'schedule' then raise exception 'reverse: null-sched label lost, now %', v; end if;
  select section into v from public.destinations where id = '99999999-9999-9999-9999-999999999999';
  if v <> 'adu' then raise exception 'reverse: null-adu label lost, now %', v; end if;

  -- a NULL-section row inserts again (the lock is off)
  insert into public.destinations values
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-null-new', 'Page Null New', 'UTC', 'active', '{}'::jsonb, 'tok', null, now());

  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL
echo "cluster A reverse migration + assertions passed"

# =====================================================================
# Cluster B — negative control: NULL row with NO evidence
# =====================================================================
setup_cluster /var/lib/postgresql/16/test-174-4a-b 55438 test174b
create_schema PSQL_B
PSQL_B <<'SQL'
insert into public.destinations values
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-sched', 'Page Sched', 'UTC', 'active', '{}'::jsonb, 'tok', 'schedule', now()),
  ('88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-null-none', 'Page Null None', 'UTC', 'active', '{}'::jsonb, 'tok', null, now());
SQL
if su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-4a-b/sock' -p 55438 -d test174b -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'" 2>/var/lib/postgresql/16/test-174-4a-b/forward.err; then
  echo "NEGATIVE B FAILED: forward migration succeeded on a no-evidence NULL row"
  exit 1
fi
grep -q "no evidence" /var/lib/postgresql/16/test-174-4a-b/forward.err || { echo "NEGATIVE B FAILED: error does not mention no-evidence:"; cat /var/lib/postgresql/16/test-174-4a-b/forward.err; exit 1; }
assert_lock_off PSQL_B || { echo "NEGATIVE B FAILED: lock applied despite the failed migration"; exit 1; }
echo "cluster B negative control passed (no-evidence NULL row fails loud, lock not applied)"

# =====================================================================
# Cluster C — negative control: NULL row with MULTI-section evidence
# =====================================================================
setup_cluster /var/lib/postgresql/16/test-174-4a-c 55439 test174c
create_schema PSQL_C
PSQL_C <<'SQL'
insert into public.destinations values
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-sched', 'Page Sched', 'UTC', 'active', '{}'::jsonb, 'tok', 'schedule', now()),
  ('88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'facebook', 'page-null-multi', 'Page Null Multi', 'UTC', 'active', '{}'::jsonb, 'tok', null, now());
insert into public.posting_slots values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '88888888-8888-8888-8888-888888888888');
insert into public.adu_configs values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '88888888-8888-8888-8888-888888888888');
SQL
if su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-4a-c/sock' -p 55439 -d test174c -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'" 2>/var/lib/postgresql/16/test-174-4a-c/forward.err; then
  echo "NEGATIVE C FAILED: forward migration succeeded on a multi-evidence NULL row"
  exit 1
fi
grep -q "multi-section" /var/lib/postgresql/16/test-174-4a-c/forward.err || { echo "NEGATIVE C FAILED: error does not mention multi-section:"; cat /var/lib/postgresql/16/test-174-4a-c/forward.err; exit 1; }
assert_lock_off PSQL_C || { echo "NEGATIVE C FAILED: lock applied despite the failed migration"; exit 1; }
echo "cluster C negative control passed (multi-evidence NULL row fails loud, lock not applied)"

echo "174-4a migration test: ALL PASSED"
