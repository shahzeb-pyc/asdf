#!/usr/bin/env bash
# Live migration test for the spec 241 analytics JSON columns.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), creates minimal stubs of the
# three page-record tables, applies the forward migration, asserts the
# four jsonb columns exist on all three tables (NULL by default, no
# other schema change), re-applies it (idempotent — IF NOT EXISTS),
# applies the reverse migration and asserts the columns are gone.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/analytics-json-columns-migration.test.sh
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
MIGRATION="$ROOT/supabase/migrations/20261123210000_analytics_json_columns.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261123210000_analytics_json_columns.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-analytics-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/reverse.sql"
chown -R postgres:postgres "$STAGE"

WORKDIR=/var/lib/postgresql/16/test-analytics-a
PORT=55439

setup_cluster() {
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR" "$WORKDIR/sock"
  chown -R postgres:postgres "$WORKDIR"
  chmod 700 "$WORKDIR"
  su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$WORKDIR/sock' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
  su postgres -c "$PG_BIN/createdb -h '$WORKDIR/sock' -p $PORT testanalytics" >/dev/null
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
  # "$@" is forwarded to psql (e.g. -c "select ..."). Each arg is
  # %q-escaped so the inner su shell sees exactly one argument per
  # word — without this the -c query is silently dropped and psql
  # reads stdin forever. With no args, psql reads the caller's stdin
  # (the heredoc form used for the stub tables).
  local quoted=()
  local arg
  for arg in "$@"; do
    quoted+=( "$(printf '%q' "$arg")" )
  done
  # shellcheck disable=SC2128
  su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testanalytics -v ON_ERROR_STOP=1 -q -t -A ${quoted[*]:-}"
}

setup_cluster

# Minimal stubs of the three page-record tables (the migration only
# adds columns; no other table shape is needed to prove it applies).
PSQL <<SQL
create table public.destinations (id uuid primary key, metadata jsonb);
create table public.adu_configs (id uuid primary key, followers_updated_at timestamptz);
create table public.mirrors (id uuid primary key, followers_updated_at timestamptz);
SQL

su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testanalytics -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- Forward assertions: the four jsonb columns on all three tables ---
for TABLE in destinations adu_configs mirrors; do
  for COL in analytics_1d analytics_7d analytics_28d analytics_locations; do
    COUNT=$(PSQL -c "select count(*) from information_schema.columns where table_schema='public' and table_name='$TABLE' and column_name='$COL' and data_type='jsonb';")
    [ "$COUNT" = "1" ] || { echo "FAIL: $TABLE.$COL jsonb column missing"; exit 1; }
    DEFAULT_VAL=$(PSQL -c "select column_default from information_schema.columns where table_schema='public' and table_name='$TABLE' and column_name='$COL';")
    [ -z "$DEFAULT_VAL" ] || { echo "FAIL: $TABLE.$COL has a default ($DEFAULT_VAL), expected NULL"; exit 1; }
  done
done

# analytics_updated_at: real column on adu_configs + mirrors only —
# destinations stamps it as a metadata key instead.
for TABLE in adu_configs mirrors; do
  COUNT=$(PSQL -c "select count(*) from information_schema.columns where table_schema='public' and table_name='$TABLE' and column_name='analytics_updated_at' and data_type='timestamp with time zone';")
  [ "$COUNT" = "1" ] || { echo "FAIL: $TABLE.analytics_updated_at timestamptz column missing"; exit 1; }
done
DEST_COUNT=$(PSQL -c "select count(*) from information_schema.columns where table_schema='public' and table_name='destinations' and column_name='analytics_updated_at';")
[ "$DEST_COUNT" = "0" ] || { echo "FAIL: destinations must NOT gain an analytics_updated_at column (metadata key instead)"; exit 1; }

# A fresh row carries NULL in every new column (no backfill).
PSQL -c "insert into public.destinations (id) values ('11111111-1111-1111-1111-111111111111');" >/dev/null
NULLS=$(PSQL -c "select count(*) from public.destinations where analytics_1d is null and analytics_7d is null and analytics_28d is null and analytics_locations is null;")
[ "$NULLS" = "1" ] || { echo "FAIL: new columns are not NULL by default"; exit 1; }

# --- Idempotency: a second apply changes nothing ---
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testanalytics -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
COLS=$(PSQL -c "select count(*) from information_schema.columns where table_schema='public' and table_name in ('destinations','adu_configs','mirrors') and column_name like 'analytics_%';")
[ "$COLS" = "14" ] || { echo "FAIL: second apply changed the column count (got $COLS, expected 14)"; exit 1; }

# --- Reverse ---
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testanalytics -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"
COLS_AFTER=$(PSQL -c "select count(*) from information_schema.columns where table_schema='public' and table_name in ('destinations','adu_configs','mirrors') and column_name like 'analytics_%';")
[ "$COLS_AFTER" = "0" ] || { echo "FAIL: reverse migration left analytics columns behind ($COLS_AFTER)"; exit 1; }

echo "PASS: analytics JSON columns migration (forward + idempotent re-apply + reverse)"
