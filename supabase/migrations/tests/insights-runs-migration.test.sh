#!/usr/bin/env bash
# Live migration test for the spec 240 insights-runs tables.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), applies the forward migration,
# asserts both tables + the partial-unique guard + RLS posture, proves
# the guard behaviour (one live run only; a second live insert fails;
# terminal rows never block), re-applies the forward migration
# (idempotent no-op), applies the reverse migration, asserts both
# tables are gone. Nothing touches the live database.
#
#   bash supabase/migrations/tests/insights-runs-migration.test.sh
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
MIGRATION="$ROOT/supabase/migrations/20261124010000_insights_runs.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261124010000_insights_runs.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-insights-runs-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/reverse.sql"
chown -R postgres:postgres "$STAGE"

WORKDIR=/var/lib/postgresql/16/test-insights-runs-a
PORT=55439

setup_cluster() {
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR" "$WORKDIR/sock"
  chown -R postgres:postgres "$WORKDIR"
  chmod 700 "$WORKDIR"
  su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$WORKDIR/sock' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
  su postgres -c "$PG_BIN/createdb -h '$WORKDIR/sock' -p $PORT testinsights" >/dev/null
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
  if [ "$#" -gt 0 ]; then
    # PSQL -c "sql": the -c flag cannot survive the su quoting, so
    # the SQL goes on stdin instead (same result, no quoting hell).
    # NOTE: the first version of this function dropped "$@" entirely
    # and ran a bare psql that waited on stdin forever.
    shift
    printf '%s\n' "$1" | su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testinsights -v ON_ERROR_STOP=1 -q -t -A"
  else
    # No args: stdin is the caller's (the create-role heredoc).
    su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testinsights -v ON_ERROR_STOP=1 -q -t -A"
  fi
}

setup_cluster

# Roles the migration's RLS posture assumes exist.
PSQL <<SQL
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
SQL

su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testinsights -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- Forward assertions ---
TABLES=$(PSQL -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('insights_runs', 'insights_run_chunks');")
[ "$TABLES" = "2" ] || { echo "FAIL: expected 2 insights tables, got $TABLES"; exit 1; }

RUN_CHECK=$(PSQL -c "select count(*) from pg_constraint where conrelid = 'public.insights_runs'::regclass and contype = 'c';")
[ "$RUN_CHECK" = "2" ] || { echo "FAIL: expected 2 CHECKs on insights_runs (trigger + status), got $RUN_CHECK"; exit 1; }

CHUNK_CHECK=$(PSQL -c "select count(*) from pg_constraint where conrelid = 'public.insights_run_chunks'::regclass and contype = 'c';")
[ "$CHUNK_CHECK" = "1" ] || { echo "FAIL: expected 1 CHECK on insights_run_chunks (status), got $CHUNK_CHECK"; exit 1; }

LIVE_IDX=$(PSQL -c "select count(*) from pg_indexes where schemaname='public' and indexname='insights_runs_live_idx' and indexdef like '%(status = ''running''%';")
[ "$LIVE_IDX" = "1" ] || { echo "FAIL: partial unique index insights_runs_live_idx missing"; exit 1; }

UNIQUE_CHUNK=$(PSQL -c "select count(*) from pg_indexes where schemaname='public' and indexname='insights_run_chunks_run_chunk_idx';")
[ "$UNIQUE_CHUNK" = "1" ] || { echo "FAIL: unique index insights_run_chunks_run_chunk_idx missing"; exit 1; }

RLS=$(PSQL -c "select count(*) from pg_class where relname in ('insights_runs', 'insights_run_chunks') and relrowsecurity;")
[ "$RLS" = "2" ] || { echo "FAIL: RLS not enabled on both tables (got $RLS)"; exit 1; }

POLICIES=$(PSQL -c "select count(*) from pg_policies where schemaname='public' and tablename in ('insights_runs', 'insights_run_chunks');")
[ "$POLICIES" = "0" ] || { echo "FAIL: unexpected RLS policies on insights tables"; exit 1; }

# --- Guard behaviour: one live run only ---
PSQL -c "insert into public.insights_runs (trigger, chunks_total) values ('manual', 2);" >/dev/null
if PSQL -c "insert into public.insights_runs (trigger, chunks_total) values ('cron', 1);" >/dev/null 2>&1; then
  echo "FAIL: second live insights run was accepted"
  exit 1
fi
# A terminal run never blocks the next one.
PSQL -c "update public.insights_runs set status='finished', finished_at=now() where status='running';" >/dev/null
PSQL -c "insert into public.insights_runs (trigger, chunks_total) values ('cron', 1);" >/dev/null
# Chunk uniqueness: the same chunk index twice for one run fails.
RUN_ID=$(PSQL -c "select id from public.insights_runs where trigger='cron' and status='running';")
PSQL -c "insert into public.insights_run_chunks (run_id, chunk_index, \"offset\", \"limit\") values ('$RUN_ID', 0, 0, 200);" >/dev/null
if PSQL -c "insert into public.insights_run_chunks (run_id, chunk_index, \"offset\", \"limit\") values ('$RUN_ID', 0, 0, 200);" >/dev/null 2>&1; then
  echo "FAIL: duplicate chunk index was accepted"
  exit 1
fi

# --- Idempotent re-apply: the forward migration is a safe no-op ---
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testinsights -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
TABLES_AFTER=$(PSQL -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('insights_runs', 'insights_run_chunks');")
[ "$TABLES_AFTER" = "2" ] || { echo "FAIL: re-apply changed the tables (got $TABLES_AFTER)"; exit 1; }
RUNS_AFTER=$(PSQL -c "select count(*) from public.insights_runs;")
[ "$RUNS_AFTER" = "2" ] || { echo "FAIL: re-apply changed run rows (got $RUNS_AFTER)"; exit 1; }

# --- Reverse ---
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testinsights -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

TABLES_GONE=$(PSQL -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('insights_runs', 'insights_run_chunks');")
[ "$TABLES_GONE" = "0" ] || { echo "FAIL: reverse migration left insights tables behind"; exit 1; }

echo "PASS: insights-runs migration (forward + guard behaviour + idempotent re-apply + reverse)"
