#!/usr/bin/env bash
# Live migration test for the destinations workspace+status index
# (spec 233, DB optimisation plan item 9): the entitlement check
# (`apps/web/src/lib/billing/entitlement.ts`) lists disconnected
# pages per workspace with
#   workspace_id IN (...) AND status = 'disconnected'
# but the only workspace index is `idx_destinations_workspace_id`
# on (workspace_id) alone, so the status is filtered by hand
# afterwards. The new index (workspace_id, status) serves the
# equality pair directly.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds a minimal
# destinations table with the two existing workspace indexes, seeds
# a 17k-row pile across three workspaces, then:
#   (1) EXPLAINs the disconnected-pages lookup BEFORE the migration
#       and asserts it filters on status by hand (no new index);
#   (2) records the disconnected page ids (identity baseline);
#   (3) applies the forward migration, asserts the index exists
#       with the right definition, re-applies it (idempotent);
#   (4) EXPLAINs the same lookup AFTER and asserts the plan uses
#       the new index with no status filter;
#   (5) asserts the SAME disconnected page ids are returned
#       (lookup behaviour unchanged);
#   (6) drops the index inline (rollback proof) and asserts the
#       lookup filters on status again.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/destinations-workspace-status-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122220000_destinations_workspace_status_index.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration file where it can read it.
STAGE=/var/lib/postgresql/16/test-dest-ws-status-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
chown -R postgres:postgres "$STAGE"

WORKDIR=/var/lib/postgresql/16/test-dest-ws-status-a
PORT=55441

setup_cluster() {
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR" "$WORKDIR/sock"
  chown -R postgres:postgres "$WORKDIR"
  chmod 700 "$WORKDIR"
  su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$WORKDIR/sock' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
  su postgres -c "$PG_BIN/createdb -h '$WORKDIR/sock' -p $PORT testdestws" >/dev/null
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
  su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testdestws -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() {
  su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testdestws -v ON_ERROR_STOP=1 -q -t -A -c \"$1\""
}

setup_cluster

# Minimal destinations table: only the columns the lookup and the
# fixtures touch, with the real status type + CHECK and the two
# existing workspace indexes from the repo migrations
# (20261022120000 unified schema, 20261112150000 section label).
PSQL <<'SQL'
create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  account_id uuid not null,
  platform text not null,
  external_destination_id varchar(255) not null,
  name varchar(255) not null,
  section text not null default 'schedule',
  status varchar(30) not null default 'active'
    check (status in ('active', 'rate_limited', 'disconnected', 'error')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_destinations_workspace_id
  on public.destinations (workspace_id);
create index idx_destinations_workspace_section_platform
  on public.destinations (workspace_id, section, platform);
SQL

# ws1: 10,000 rows, 50 disconnected. ws2: 5,000 rows, 30
# disconnected. ws3: 2,000 rows, all active (noise the lookup must
# not touch). Disconnected rows are spread through each workspace
# so no ordering accident hides them.
PSQL <<'SQL'
insert into public.destinations (workspace_id, account_id, platform, external_destination_id, name, status)
select '11111111-1111-1111-1111-111111111111', gen_random_uuid(), 'facebook',
       'ext-ws1-' || g, 'ws1-page-' || g,
       case when g % 200 = 0 then 'disconnected' else 'active' end
  from generate_series(1, 10000) g;
insert into public.destinations (workspace_id, account_id, platform, external_destination_id, name, status)
select '22222222-2222-2222-2222-222222222222', gen_random_uuid(), 'facebook',
       'ext-ws2-' || g, 'ws2-page-' || g,
       case when g % 167 = 0 then 'disconnected' else 'active' end
  from generate_series(1, 5000) g;
insert into public.destinations (workspace_id, account_id, platform, external_destination_id, name, status)
select '33333333-3333-3333-3333-333333333333', gen_random_uuid(), 'facebook',
       'ext-ws3-' || g, 'ws3-page-' || g, 'active'
  from generate_series(1, 2000) g;
analyze public.destinations;
SQL

echo "seeded: destinations=$(PSQL_TA 'select count(*) from public.destinations') (expect 17000)"
echo "seeded: disconnected ws1+ws2=$(PSQL_TA "select count(*) from public.destinations where workspace_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222') and status = 'disconnected'") (expect 79)"

# The exact lookup shape from the entitlement check
# (apps/web/src/lib/billing/entitlement.ts): workspace ids IN (...),
# status = 'disconnected', selecting id + platform.
LOOKUP="select id, platform from public.destinations where workspace_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222') and status = 'disconnected'"
EXPLAIN_LOOKUP="explain (analyze, buffers) $LOOKUP;"

# --- (1) BEFORE: the lookup must filter status by hand ------------------
echo "=== EXPLAIN BEFORE (no new index) ==="
PSQL <<SQL > /tmp/dest-ws-status-before.plan
$EXPLAIN_LOOKUP
SQL
cat /tmp/dest-ws-status-before.plan
grep -q "idx_destinations_workspace_status" /tmp/dest-ws-status-before.plan && {
  echo "NEGATIVE CONTROL FAILED: before-plan mentions the new index, which does not exist yet"
  exit 1
}
grep -Eq 'Filter:.*status' /tmp/dest-ws-status-before.plan || {
  echo "NEGATIVE CONTROL FAILED: before-plan has no status Filter — the old indexes already serve the pair?"
  exit 1
}
echo "before-plan filters on status by hand, as expected"

# --- (2) identity baseline: disconnected ids before -----------------------
PSQL_TA "$LOOKUP order by id" > /tmp/dest-ws-status-before.ids
BEFORE_COUNT=$(wc -l < /tmp/dest-ws-status-before.ids)
[ "$BEFORE_COUNT" = "79" ] || {
  echo "IDENTITY BASELINE FAILED: $BEFORE_COUNT disconnected rows before (expect 79)"
  exit 1
}
echo "identity baseline: $BEFORE_COUNT disconnected page ids recorded"

# --- (3) apply the forward migration (twice: idempotent) ------------------
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testdestws -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testdestws -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice (idempotent)"

PSQL <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'idx_destinations_workspace_status';
  if v_def is null then raise exception 'index idx_destinations_workspace_status missing after migration'; end if;
  if v_def not like '%(workspace_id, status)%' then raise exception 'index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_destinations_workspace_status';
  if v_count <> 1 then raise exception 'index created % times (expected 1)', v_count; end if;
  raise notice 'INDEX EXISTS WITH RIGHT DEFINITION: %', v_def;
end $$;
SQL

# --- (4) AFTER: the lookup must use the new index, no status filter -------
echo "=== EXPLAIN AFTER (new index) ==="
PSQL <<SQL > /tmp/dest-ws-status-after.plan
$EXPLAIN_LOOKUP
SQL
cat /tmp/dest-ws-status-after.plan
grep -q "idx_destinations_workspace_status" /tmp/dest-ws-status-after.plan || {
  echo "AFTER PLAN FAILED: new index not used by the disconnected-pages lookup"
  exit 1
}
grep -Eq 'Filter:.*status' /tmp/dest-ws-status-after.plan && {
  echo "AFTER PLAN FAILED: plan still filters on status despite the new index"
  cat /tmp/dest-ws-status-after.plan
  exit 1
}
echo "after-plan uses the new index with no status filter"

# --- (5) identity check: same disconnected ids after ----------------------
PSQL_TA "$LOOKUP order by id" > /tmp/dest-ws-status-after.ids
if ! cmp -s /tmp/dest-ws-status-before.ids /tmp/dest-ws-status-after.ids; then
  echo "IDENTITY CHECK FAILED: disconnected page ids differ before/after"
  diff /tmp/dest-ws-status-before.ids /tmp/dest-ws-status-after.ids | head -20
  exit 1
fi
echo "identity check passed: same $BEFORE_COUNT disconnected page ids before/after"

# --- (6) rollback proof: drop the index, the lookup filters again ---------
PSQL <<'SQL'
drop index if exists public.idx_destinations_workspace_status;
SQL
PSQL <<SQL > /tmp/dest-ws-status-rollback.plan
$EXPLAIN_LOOKUP
SQL
grep -q "idx_destinations_workspace_status" /tmp/dest-ws-status-rollback.plan && {
  echo "ROLLBACK CHECK FAILED: dropped index still in plan"
  exit 1
}
grep -Eq 'Filter:.*status' /tmp/dest-ws-status-rollback.plan || {
  echo "ROLLBACK CHECK FAILED: after dropping the index the plan still does not filter on status"
  exit 1
}
echo "rollback check passed: dropping the index brings the status filter back"

echo "ALL DESTINATIONS-WORKSPACE-STATUS-INDEX MIGRATION TESTS PASSED"
