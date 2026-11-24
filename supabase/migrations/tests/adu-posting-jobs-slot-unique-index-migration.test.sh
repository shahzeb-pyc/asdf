#!/usr/bin/env bash
# Live migration test for the ADU slot unique index (spec 245): the
# mint code's 23505 "already intaken for this slot" branch in
# apps/worker/src/adu-tick.ts had no backing unique index on prod
# (verified live 2026-11-24: pg_indexes lists only the pkey and the
# two non-unique indexes), so the branch was effectively dead and two
# ticks covering the same slot could mint twice. The index IS defined
# in 20261030120001_adu.sql (since the original ADU feature) but is
# absent on prod — most likely lost in the Nov 22–23 Supabase move
# restore. The new migration re-creates it (same name and definition,
# so a fresh database is a no-op).
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres`
# system user (postgres refuses to run as root), seeds a minimal
# adu_posting_jobs table plus one row, then:
#   (1) applies the forward migration twice (idempotent) and asserts
#       the index exists with the right definition, exactly once;
#   (2) asserts a second insert with the same (config_id,
#       schedule_slot_at) fails with 23505 and inserts nothing;
#   (3) asserts a different slot for the same config and the same
#       slot for a different config both succeed;
#   (4) applies the reverse migration and asserts the duplicate
#       insert then succeeds (rollback proof).
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-posting-jobs-slot-unique-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261124090000_adu_posting_jobs_config_slot_unique_index.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261124090000_adu_posting_jobs_config_slot_unique_index.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-slot-index-stage
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
  stop_cluster /var/lib/postgresql/16/test-adu-slot-index-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-slot-index-a/sock' -p 55443 -d testslotindex -v ON_ERROR_STOP=1 -q -t -A"
}
PSQL_A_FILE() { # $1=file
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-slot-index-a/sock' -p 55443 -d testslotindex -v ON_ERROR_STOP=1 -q -f '$1'"
}

# Minimal adu_posting_jobs shape (columns as on prod) plus one row:
# config A, slot 2026-11-24 08:01 UTC (the diagnosed Jkiuyo slot).
cat > "$STAGE/seed.sql" <<'SEEDSQL'
create table public.adu_posting_jobs (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null,
  reel_id uuid not null,
  schedule_slot_at timestamptz,
  status text not null default 'pending_publish',
  publish_retries integer not null default 0,
  graph_post_id text,
  last_error_code text,
  last_error_message text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
insert into public.adu_posting_jobs (id, config_id, reel_id, schedule_slot_at, status)
values ('11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001',
        '2026-11-24 08:01:00+00', 'pending_publish');
SEEDSQL
chown -R postgres:postgres "$STAGE"

setup_cluster /var/lib/postgresql/16/test-adu-slot-index-a 55443 testslotindex

PSQL_A_FILE "$STAGE/seed.sql"

# --- (1) apply the forward migration twice (idempotent) ----------------------
PSQL_A_FILE "$STAGE/forward.sql"
PSQL_A_FILE "$STAGE/forward.sql"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL' > /tmp/adu-slot-index-after.out
select 'indexdef:' || indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'idx_adu_jobs_config_slot_unique';
select 'indexcount:' || count(*) from pg_indexes
 where schemaname = 'public' and indexname = 'idx_adu_jobs_config_slot_unique';
SQL
cat /tmp/adu-slot-index-after.out
grep -q "indexdef:CREATE UNIQUE INDEX idx_adu_jobs_config_slot_unique ON public.adu_posting_jobs USING btree (config_id, schedule_slot_at) WHERE (schedule_slot_at IS NOT NULL)" /tmp/adu-slot-index-after.out || {
  echo "INDEX CHECK FAILED: index missing or wrong definition"
  exit 1
}
grep -q "indexcount:1" /tmp/adu-slot-index-after.out || {
  echo "INDEX CHECK FAILED: index created more than once"
  exit 1
}
echo "index exists with the right definition, exactly once"

# --- (2) duplicate (same config, same slot) must fail with 23505 -------------
if PSQL_A <<'SQL' > /tmp/adu-slot-index-dup.out 2>&1
insert into public.adu_posting_jobs (config_id, reel_id, schedule_slot_at, status)
values ('aaaaaaaa-0000-0000-0000-000000000001',
        'cccccccc-0000-0000-0000-000000000001',
        '2026-11-24 08:01:00+00', 'pending_publish');
SQL
then
  echo "DUPLICATE CHECK FAILED: same (config_id, schedule_slot_at) inserted twice"
  exit 1
fi
grep -q 'duplicate key value violates unique constraint "idx_adu_jobs_config_slot_unique"' /tmp/adu-slot-index-dup.out || {
  echo "DUPLICATE CHECK FAILED: insert failed, but not on the slot unique index:"
  cat /tmp/adu-slot-index-dup.out
  exit 1
}
PSQL_A <<'SQL' > /tmp/adu-slot-index-count.out
select 'rows:' || count(*) from public.adu_posting_jobs;
SQL
grep -q "rows:1" /tmp/adu-slot-index-count.out || {
  echo "DUPLICATE CHECK FAILED: row count is not 1 after the rejected insert"
  cat /tmp/adu-slot-index-count.out
  exit 1
}
echo "duplicate (config, slot) rejected with 23505, nothing inserted"

# --- (3) different slot / different config must succeed ----------------------
PSQL_A <<'SQL'
insert into public.adu_posting_jobs (config_id, reel_id, schedule_slot_at, status)
values ('aaaaaaaa-0000-0000-0000-000000000001',
        'dddddddd-0000-0000-0000-000000000001',
        '2026-11-24 08:02:00+00', 'pending_publish');
insert into public.adu_posting_jobs (config_id, reel_id, schedule_slot_at, status)
values ('aaaaaaaa-0000-0000-0000-000000000002',
        'eeeeeeee-0000-0000-0000-000000000001',
        '2026-11-24 08:01:00+00', 'pending_publish');
select 'rows:' || count(*) from public.adu_posting_jobs;
SQL
PSQL_A <<'SQL' > /tmp/adu-slot-index-count3.out
select 'rows:' || count(*) from public.adu_posting_jobs;
SQL
grep -q "rows:3" /tmp/adu-slot-index-count3.out || {
  echo "ALLOWED-INSERT CHECK FAILED: expected 3 rows after the two allowed inserts"
  cat /tmp/adu-slot-index-count3.out
  exit 1
}
echo "different slot and different config both insert fine"

# --- (4) rollback proof: reverse file drops the index, duplicate succeeds ----
PSQL_A_FILE "$STAGE/reverse.sql"
PSQL_A <<'SQL' > /tmp/adu-slot-index-rollback.out
insert into public.adu_posting_jobs (config_id, reel_id, schedule_slot_at, status)
values ('aaaaaaaa-0000-0000-0000-000000000001',
        'ffffffff-0000-0000-0000-000000000001',
        '2026-11-24 08:01:00+00', 'pending_publish');
select 'rows:' || count(*) from public.adu_posting_jobs;
select 'indexcount:' || count(*) from pg_indexes
 where schemaname = 'public' and indexname = 'idx_adu_jobs_config_slot_unique';
SQL
grep -q "rows:4" /tmp/adu-slot-index-rollback.out || {
  echo "ROLLBACK CHECK FAILED: duplicate insert did not succeed after dropping the index"
  cat /tmp/adu-slot-index-rollback.out
  exit 1
}
grep -q "indexcount:0" /tmp/adu-slot-index-rollback.out || {
  echo "ROLLBACK CHECK FAILED: index still present after the reverse migration"
  cat /tmp/adu-slot-index-rollback.out
  exit 1
}
echo "rollback check passed: dropping the index lets the duplicate through again"

echo "ALL ADU-SLOT-INDEX MIGRATION TESTS PASSED"
