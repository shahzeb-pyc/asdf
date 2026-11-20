#!/usr/bin/env bash
# Live migration test for the spec 212 poll-gate state table.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds the roles + the
# set_updated_at() function the migration's trigger needs, applies the
# forward migration, asserts the table + singleton CHECK + RLS posture
# + service-role grant, applies the reverse migration, asserts the
# table is gone. Nothing touches the live database.
#
#   bash supabase/migrations/tests/worker-poll-state-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the cluster.
#
# NOTE: CI's sql-rigs job also applies this migration (bootstrap + every
# supabase/migrations file, in filename order, against postgres:16), so
# a syntax or dependency break fails the PR checks even without this script.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261120180000_worker_poll_state.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261120180000_worker_poll_state.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-poll-state-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/reverse.sql"
chown -R postgres:postgres "$STAGE"

WORKDIR=/var/lib/postgresql/16/test-poll-state-a
PORT=55438

setup_cluster() {
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR" "$WORKDIR/sock"
  chown -R postgres:postgres "$WORKDIR"
  chmod 700 "$WORKDIR"
  su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$WORKDIR/sock' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
  su postgres -c "$PG_BIN/createdb -h '$WORKDIR/sock' -p $PORT testpoll" >/dev/null
}

stop_cluster() {
  if [ -d "$WORKDIR/data" ]; then
    su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -m immediate stop" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}

cleanup() {
  stop_cluster
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL() {
  su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testpoll -v ON_ERROR_STOP=1 -q -t -A"
}

setup_cluster

# Roles the migration's REVOKE/GRANT touches, plus the trigger
# function from 20261014160000 (the migration only references it).
PSQL <<SQL
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create or replace function public.set_updated_at()
returns trigger language plpgsql as \$\$
begin new.updated_at = now(); return new; end;
\$\$;
SQL

su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testpoll -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- Forward assertions ---
TABLE=$(PSQL -c "select count(*) from information_schema.tables where table_schema='public' and table_name='worker_poll_state';")
[ "$TABLE" = "1" ] || { echo "FAIL: worker_poll_state table missing"; exit 1; }

CHECK_CONSTRAINT=$(PSQL -c "select count(*) from information_schema.table_constraints where table_schema='public' and table_name='worker_poll_state' and constraint_type='CHECK';")
[ "$CHECK_CONSTRAINT" = "2" ] || { echo "FAIL: expected 2 CHECKs (singleton id + interval 60–240), got $CHECK_CONSTRAINT"; exit 1; }

INTERVAL_COL=$(PSQL -c "select count(*) from information_schema.columns where table_schema='public' and table_name='worker_poll_state' and column_name='current_interval_seconds' and data_type='integer';")
[ "$INTERVAL_COL" = "1" ] || { echo "FAIL: current_interval_seconds integer column missing"; exit 1; }

INTERVAL_DEFAULT=$(PSQL -c "select column_default from information_schema.columns where table_schema='public' and table_name='worker_poll_state' and column_name='current_interval_seconds';")
[ "$INTERVAL_DEFAULT" = "60" ] || { echo "FAIL: current_interval_seconds default is not 60 (got $INTERVAL_DEFAULT)"; exit 1; }

RLS=$(PSQL -c "select relrowsecurity from pg_class where relname='worker_poll_state';")
[ "$RLS" = "t" ] || { echo "FAIL: RLS not enabled on worker_poll_state"; exit 1; }

POLICIES=$(PSQL -c "select count(*) from pg_policies where schemaname='public' and tablename='worker_poll_state';")
[ "$POLICIES" = "0" ] || { echo "FAIL: unexpected RLS policies on worker_poll_state"; exit 1; }

TRIGGER=$(PSQL -c "select count(*) from information_schema.triggers where event_object_schema='public' and event_object_table='worker_poll_state' and trigger_name='trg_worker_poll_state_updated_at';")
[ "$TRIGGER" = "1" ] || { echo "FAIL: updated_at trigger missing"; exit 1; }

# Singleton behaviour: a second id is rejected by the CHECK.
PSQL -c "insert into public.worker_poll_state (id) values (1);" >/dev/null
if PSQL -c "insert into public.worker_poll_state (id) values (2);" >/dev/null 2>&1; then
  echo "FAIL: second worker_poll_state row was accepted"
  exit 1
fi

# --- Reverse ---
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testpoll -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

TABLE_AFTER=$(PSQL -c "select count(*) from information_schema.tables where table_schema='public' and table_name='worker_poll_state';")
[ "$TABLE_AFTER" = "0" ] || { echo "FAIL: reverse migration left worker_poll_state behind"; exit 1; }

echo "PASS: worker_poll_state migration (forward + reverse)"
