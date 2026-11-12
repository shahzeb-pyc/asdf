#!/usr/bin/env bash
# Live migration test for spec 174 PR 1B (hub RPCs return only `adu` rows).
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system user
# (postgres refuses to run as root), seeds a minimal schema with a config
# on an `adu` row, a config on a `schedule` row, a config on a `mirror`
# row, a config on a NULL-section row, a config on a dangling destination,
# and Threads equivalents, then:
#   1. applies the REVERSE migration (the pre-1B definitions) and asserts
#      the OLD behaviour — the wrong-section configs ARE returned. This is
#      the negative control: it proves the assertions below can catch the
#      bug (they fail on old code).
#   2. applies the forward migration and asserts Gate 1B for the RPCs:
#      every hub function returns only configs whose destination is
#      section='adu' — including the fail-closed cases (wrong-section,
#      NULL-section, dangling destination).
#   3. applies the reverse migration again and asserts the old behaviour
#      is restored (rollback proof).
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/174-1b-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261112180000_adu_hub_section_label.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261112180000_adu_hub_section_label.sql"
WORKDIR=/var/lib/postgresql/16/test-174-1b
SOCKDIR="$WORKDIR/sock"
PORT=55434
DB=test174b

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION" && exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE" && exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user" && exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN" && exit 1; }

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

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
cp "$MIGRATION" "$WORKDIR/forward.sql"
cp "$REVERSE" "$WORKDIR/reverse.sql"
chown postgres:postgres "$WORKDIR/forward.sql" "$WORKDIR/reverse.sql"
MIGRATION="$WORKDIR/forward.sql"
REVERSE="$WORKDIR/reverse.sql"

su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$SOCKDIR' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
su postgres -c "$PG_BIN/createdb -h '$SOCKDIR' -p $PORT $DB" >/dev/null

PSQL() {
  su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() { # single query, tuples-only output (for counts)
  # The -c argument is double-quoted (not single) so SQL string
  # literals inside the query survive the su -c layer intact.
  su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -tA -c \"$1\""
}

assert_eq() { # assert_eq <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected $3, got $2"
    exit 1
  fi
  echo "ok: $1 = $2"
}

# --- minimal schema (only the columns the hub RPCs touch) ------------------
# NOTE: adu_configs.destination_id has NO foreign key here on purpose:
# the dangling-destination config (C6) is the fail-closed case — in prod
# the FK would cascade-delete such a config, but the RPC must still
# exclude it if one ever exists.
PSQL <<'SQL'
create table public.destinations (
  id uuid primary key,
  workspace_id uuid not null,
  platform text not null,
  external_destination_id text not null,
  name text not null,
  status text not null default 'active',
  section text check (section in ('schedule', 'adu', 'mirror', 'publish_now'))
);
create table public.adu_configs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  destination_id uuid not null,
  source_platform text not null,
  source_username text not null,
  timezone text not null default 'UTC',
  posts_per_day integer not null default 1,
  schedule_type text not null default 'dailyrandom',
  posting_times text[] not null default '{}',
  status text not null default 'active',
  sync_status text not null default 'pending',
  starting_followers integer not null default 0,
  current_followers integer not null default 0,
  followers_updated_at timestamptz,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
SQL

# --- seed -------------------------------------------------------------------
# Facebook: A1/A2 adu, S1 schedule, M1 mirror, N1 NULL-section, C6 dangling.
# Threads: T1 adu, T2 schedule.
PSQL <<'SQL'
insert into public.destinations
  (id, workspace_id, platform, external_destination_id, name, status, section) values
  ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'facebook', 'page-a1', 'Page Adu', 'active', 'adu'),
  ('a0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'facebook', 'page-a2', 'Page Adu Two', 'active', 'adu'),
  ('a0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'facebook', 'page-s1', 'Page Sched', 'active', 'schedule'),
  ('a0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'facebook', 'page-m1', 'Page Mirror', 'active', 'mirror'),
  ('a0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'facebook', 'page-n1', 'Page Null', 'active', null),
  ('a0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'threads', 'threads-t1', 'Threads Adu', 'active', 'adu'),
  ('a0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'threads', 'threads-t2', 'Threads Sched', 'active', 'schedule');

insert into public.adu_configs
  (id, workspace_id, destination_id, source_platform, source_username, status, starting_followers, current_followers) values
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001', 'tiktok', 'creator-one', 'active', 10, 12),
  ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002', 'tiktok', 'creator-two', 'paused', 20, 25),
  ('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003', 'tiktok', 'creator-sched', 'active', 30, 30),
  ('c0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000004', 'tiktok', 'creator-mirror', 'active', 40, 41),
  ('c0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000005', 'tiktok', 'creator-null', 'active', 50, 50),
  ('c0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000000', 'tiktok', 'creator-dangling', 'active', 60, 60),
  ('c0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000006', 'tiktok', 'threads-one', 'active', 70, 73),
  ('c0000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000007', 'tiktok', 'threads-sched', 'active', 80, 80);
SQL

WS="'11111111-1111-1111-1111-111111111111'"

# --- 1. negative control: pre-1B definitions return the wrong-section rows -
# NOTE: the Facebook RPC has no platform predicate (pre-existing — the
# Threads hub has its own RPC), so pre-1B it returns all 8 configs and
# post-1B the 3 whose destination is section='adu' (2 Facebook + 1 Threads).
su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -v ON_ERROR_STOP=1 -q -f '$REVERSE'"
assert_eq "pre-1B adu_hub_list rows (negative control)" "$(PSQL_TA "select count(*) from adu_hub_list($WS, null, null, null, 50, 0)")" 8
assert_eq "pre-1B adu_hub_stats total" "$(PSQL_TA "select total_count from adu_hub_stats($WS, null, null)")" 8
assert_eq "pre-1B threads_adu_hub_list rows (negative control)" "$(PSQL_TA "select count(*) from threads_adu_hub_list($WS, null, null, null, 50, 0)")" 2
assert_eq "pre-1B threads_adu_hub_stats total" "$(PSQL_TA "select total_count from threads_adu_hub_stats($WS, null, null)")" 2

# --- 2. forward migration: only `adu` rows ----------------------------------
su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -v ON_ERROR_STOP=1 -q -f '$MIGRATION'"

assert_eq "adu_hub_list rows" "$(PSQL_TA "select count(*) from adu_hub_list($WS, null, null, null, 50, 0)")" 3
assert_eq "adu_hub_list search creator-one" "$(PSQL_TA "select count(*) from adu_hub_list($WS, 'creator-one', null, null, 50, 0)")" 1
assert_eq "adu_hub_list search by adu destination name" "$(PSQL_TA "select count(*) from adu_hub_list($WS, 'Page Adu', null, null, 50, 0)")" 2
assert_eq "adu_hub_list search wrong-section username" "$(PSQL_TA "select count(*) from adu_hub_list($WS, 'creator-sched', null, null, 50, 0)")" 0
assert_eq "adu_hub_list search wrong-section destination name" "$(PSQL_TA "select count(*) from adu_hub_list($WS, 'Page Sched', null, null, 50, 0)")" 0
assert_eq "adu_hub_list status filter paused" "$(PSQL_TA "select count(*) from adu_hub_list($WS, null, 'paused', null, 50, 0)")" 1
assert_eq "adu_hub_list returned ids are adu only" "$(PSQL_TA "select count(*) from adu_hub_list($WS, null, null, null, 50, 0) l join destinations d on d.id = l.destination_id where d.section <> 'adu'")" 0
assert_eq "adu_hub_stats total" "$(PSQL_TA "select total_count from adu_hub_stats($WS, null, null)")" 3
assert_eq "adu_hub_stats followers sum (12+25+73)" "$(PSQL_TA "select total_followers_sum from adu_hub_stats($WS, null, null)")" 110
assert_eq "adu_hub_stats net gained sum (2+5+3)" "$(PSQL_TA "select net_gained_sum from adu_hub_stats($WS, null, null)")" 10
assert_eq "threads_adu_hub_list rows" "$(PSQL_TA "select count(*) from threads_adu_hub_list($WS, null, null, null, 50, 0)")" 1
assert_eq "threads_adu_hub_list search wrong-section username" "$(PSQL_TA "select count(*) from threads_adu_hub_list($WS, 'threads-sched', null, null, 50, 0)")" 0
assert_eq "threads_adu_hub_stats total" "$(PSQL_TA "select total_count from threads_adu_hub_stats($WS, null, null)")" 1
assert_eq "threads_adu_hub_stats followers sum" "$(PSQL_TA "select total_followers_sum from threads_adu_hub_stats($WS, null, null)")" 73

# --- 3. reverse migration restores the old behaviour (rollback proof) -------
su postgres -c "$PG_BIN/psql -h '$SOCKDIR' -p $PORT -d $DB -v ON_ERROR_STOP=1 -q -f '$REVERSE'"
assert_eq "post-reverse adu_hub_list rows" "$(PSQL_TA "select count(*) from adu_hub_list($WS, null, null, null, 50, 0)")" 8
assert_eq "post-reverse threads_adu_hub_list rows" "$(PSQL_TA "select count(*) from threads_adu_hub_list($WS, null, null, null, 50, 0)")" 2

echo "ALL 1B MIGRATION ASSERTIONS PASSED"
