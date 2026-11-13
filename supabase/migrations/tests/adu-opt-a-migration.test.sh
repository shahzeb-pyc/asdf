#!/usr/bin/env bash
# Live migration test for ADU optimization Stream A (F9/F10):
# status-filtered hub indexes on adu_configs.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds a minimal adu_configs
# table, applies the forward migration, asserts both indexes exist
# and serve the hub list shapes (EXPLAIN), re-applies the forward
# migration (idempotent), applies the reverse migration, asserts the
# indexes are gone and the rows are untouched. Nothing touches the
# live database.
#
#   bash supabase/migrations/tests/adu-opt-a-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113100000_adu_configs_status_indexes.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113100000_adu_configs_status_indexes.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-opt-a-stage
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
  stop_cluster /var/lib/postgresql/16/test-adu-opt-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-a/sock' -p 55444 -d testadua -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-a/sock' -p 55444 -d testadua -tA -c '$1'"
}

setup_cluster /var/lib/postgresql/16/test-adu-opt-a 55444 testadua

# Minimal adu_configs: only the columns the indexes and the hub
# shapes touch, with the real types.
PSQL <<'SQL'
create table public.adu_configs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  destination_id uuid,
  source_platform text not null default 'facebook',
  source_username text not null default '',
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
create unique index idx_adu_configs_destination_unique
  on public.adu_configs (destination_id);
create index idx_adu_configs_workspace_created
  on public.adu_configs (workspace_id, created_at desc);
SQL

PSQL <<'SQL'
insert into public.adu_configs (workspace_id, status, current_followers, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'active', 100, '2026-11-01 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'active', 300, '2026-11-02 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'paused', 200, '2026-11-03 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'active', 50, '2026-11-04 10:00:00+00'),
  ('22222222-2222-2222-2222-222222222222', 'active', 999, '2026-11-05 10:00:00+00');
SQL

echo "seeded: configs=$(PSQL_TA 'select count(*) from adu_configs') (expect 5)"

# --- apply the forward migration ----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-a/sock' -p 55444 -d testadua -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions ---------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'adu_configs'
    and indexname = 'idx_adu_configs_workspace_status_created';
  if v <> 1 then raise exception 'status+created index missing'; end if;
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'adu_configs'
    and indexname = 'idx_adu_configs_workspace_status_followers';
  if v <> 1 then raise exception 'status+followers index missing'; end if;
  -- the pre-existing indexes are untouched
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'adu_configs'
    and indexname in ('idx_adu_configs_destination_unique', 'idx_adu_configs_workspace_created');
  if v <> 2 then raise exception 'pre-existing index lost: % present', v; end if;
  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL

# The status-filtered default-sort list shape is served by the new
# status+created index (seqscan disabled so the planner must show
# the index it would use — with 5 rows it would seq-scan otherwise).
PLAN_CREATED=$(su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-a/sock' -p 55444 -d testadua -tA -c \"set enable_seqscan=off; explain (costs off) select id from public.adu_configs where workspace_id = '11111111-1111-1111-1111-111111111111' and status = 'active' order by created_at desc limit 9;\"")
echo "$PLAN_CREATED" | grep -q "Index Scan using idx_adu_configs_workspace_status_created" || {
  echo "EXPLAIN FAILED: status+created list shape does not use the new index"
  echo "$PLAN_CREATED"
  exit 1
}
echo "explain: status+created list shape uses idx_adu_configs_workspace_status_created"

# The followers sort shape is served by the new status+followers index.
PLAN_FOLLOWERS=$(su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-a/sock' -p 55444 -d testadua -tA -c \"set enable_seqscan=off; explain (costs off) select id from public.adu_configs where workspace_id = '11111111-1111-1111-1111-111111111111' and status = 'active' order by current_followers desc limit 9;\"")
echo "$PLAN_FOLLOWERS" | grep -q "Index Scan using idx_adu_configs_workspace_status_followers" || {
  echo "EXPLAIN FAILED: status+followers sort shape does not use the new index"
  echo "$PLAN_FOLLOWERS"
  exit 1
}
echo "explain: followers sort shape uses idx_adu_configs_workspace_status_followers"

# --- idempotent re-apply --------------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-a/sock' -p 55444 -d testadua -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'adu_configs'
    and indexname like 'idx_adu_configs_workspace_status%';
  if v <> 2 then raise exception 'after re-apply: % status indexes <> 2', v; end if;
  raise notice 'IDEMPOTENT RE-APPLY PASSED';
end $$;
SQL
echo "forward migration is idempotent"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-a/sock' -p 55444 -d testadua -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- rollback assertions --------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'adu_configs'
    and indexname like 'idx_adu_configs_workspace_status%';
  if v <> 0 then raise exception 'after reverse: % status indexes remain', v; end if;
  -- rows untouched, pre-existing indexes untouched
  select count(*) into v from adu_configs;
  if v <> 5 then raise exception 'after reverse: configs rows % <> 5', v; end if;
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'adu_configs'
    and indexname in ('idx_adu_configs_destination_unique', 'idx_adu_configs_workspace_created');
  if v <> 2 then raise exception 'after reverse: pre-existing index lost'; end if;
  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "ALL ADU-OPT-A MIGRATION TESTS PASSED"
