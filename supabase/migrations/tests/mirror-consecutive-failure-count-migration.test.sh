#!/usr/bin/env bash
# Live migration test for the mirror consecutive-failure counter
# (spec 254): the tick counts consecutive failures with the same
# stable signature and flips a mirror to error only on a definitive
# Facebook error or the 5th consecutive same failure — so the count
# must survive across ticks and restarts, on the mirrors row.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres`
# system user (postgres refuses to run as root), seeds a minimal
# mirrors table plus one row, then:
#   (1) applies the forward migration twice (idempotent) and asserts
#       both columns exist with the right types/defaults and the
#       non-negative CHECK exists, exactly once;
#   (2) asserts the pre-existing row got count 0 / signature NULL;
#   (3) asserts a streak write (count 3, signature 'graph:2') and a
#       reset write (count 0, signature NULL) both apply;
#   (4) asserts a negative count is rejected by the CHECK (23514)
#       and inserts nothing;
#   (5) applies the reverse migration and asserts both columns are
#       gone (rollback proof).
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/mirror-consecutive-failure-count-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261125180600_mirror_consecutive_failure_count.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261125180600_mirror_consecutive_failure_count.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-mirror-failure-count-stage
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
  stop_cluster /var/lib/postgresql/16/test-mirror-failure-count-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-mirror-failure-count-a/sock' -p 55444 -d testmirrorcount -v ON_ERROR_STOP=1 -q -t -A"
}
PSQL_A_FILE() { # $1=file
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-mirror-failure-count-a/sock' -p 55444 -d testmirrorcount -v ON_ERROR_STOP=1 -q -f '$1'"
}

# Minimal mirrors shape (columns the migration touches, plus the
# status CHECK the real table carries) plus one pre-existing row:
# a mirror that predates the migration must come out with count 0.
cat > "$STAGE/seed.sql" <<'SEEDSQL'
create table public.workspaces (id uuid primary key);
create table public.mirrors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status varchar(20) not null default 'active'
    check (status in ('active', 'paused', 'error'))
);
insert into public.workspaces (id) values ('aaaaaaaa-0000-0000-0000-000000000001');
insert into public.mirrors (id, workspace_id, status)
values ('11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001', 'active');
SEEDSQL
chown -R postgres:postgres "$STAGE"

setup_cluster /var/lib/postgresql/16/test-mirror-failure-count-a 55444 testmirrorcount

PSQL_A_FILE "$STAGE/seed.sql"

# --- (1) apply the forward migration twice (idempotent) ----------------------
PSQL_A_FILE "$STAGE/forward.sql"
PSQL_A_FILE "$STAGE/forward.sql"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL' > /tmp/mirror-count-after.out
select 'countcol:' || column_name || ':' || data_type || ':' || coalesce(column_default, 'NULL')
  from information_schema.columns
 where table_schema = 'public' and table_name = 'mirrors'
   and column_name = 'consecutive_failure_count';
select 'sigcol:' || column_name || ':' || data_type || ':' || coalesce(column_default, 'NULL')
  from information_schema.columns
 where table_schema = 'public' and table_name = 'mirrors'
   and column_name = 'last_failure_signature';
select 'checkcount:' || count(*) from pg_constraint
 where conname = 'mirrors_consecutive_failure_count_nonnegative';
select 'checkdef:' || pg_get_constraintdef(oid) from pg_constraint
 where conname = 'mirrors_consecutive_failure_count_nonnegative';
SQL
cat /tmp/mirror-count-after.out
grep -q "countcol:consecutive_failure_count:integer:0" /tmp/mirror-count-after.out || {
  echo "COLUMN CHECK FAILED: consecutive_failure_count missing or wrong type/default"
  exit 1
}
grep -q "sigcol:last_failure_signature:text:NULL" /tmp/mirror-count-after.out || {
  echo "COLUMN CHECK FAILED: last_failure_signature missing or wrong type"
  exit 1
}
grep -q "checkcount:1" /tmp/mirror-count-after.out || {
  echo "CHECK CHECK FAILED: non-negative constraint missing or duplicated"
  exit 1
}
grep -q "checkdef:CHECK ((consecutive_failure_count >= 0))" /tmp/mirror-count-after.out || {
  echo "CHECK CHECK FAILED: constraint has the wrong definition"
  cat /tmp/mirror-count-after.out
  exit 1
}
echo "columns exist with the right types/defaults, constraint exists exactly once"

# --- (2) pre-existing row defaults to count 0 / signature NULL --------------
PSQL_A <<'SQL' > /tmp/mirror-count-default.out
select 'row:' || consecutive_failure_count || ':' || coalesce(last_failure_signature, 'NULL')
  from public.mirrors where id = '11111111-1111-1111-1111-111111111111';
SQL
grep -q "row:0:NULL" /tmp/mirror-count-default.out || {
  echo "DEFAULT CHECK FAILED: pre-existing row did not get count 0 / signature NULL"
  cat /tmp/mirror-count-default.out
  exit 1
}
echo "pre-existing row defaults to count 0 / signature NULL"

# --- (3) streak write and reset write both apply -----------------------------
PSQL_A <<'SQL'
update public.mirrors
   set consecutive_failure_count = 3, last_failure_signature = 'graph:2'
 where id = '11111111-1111-1111-1111-111111111111';
update public.mirrors
   set consecutive_failure_count = 0, last_failure_signature = NULL
 where id = '11111111-1111-1111-1111-111111111111';
select 'row:' || consecutive_failure_count || ':' || coalesce(last_failure_signature, 'NULL')
  from public.mirrors where id = '11111111-1111-1111-1111-111111111111';
SQL
PSQL_A <<'SQL' > /tmp/mirror-count-reset.out
select 'row:' || consecutive_failure_count || ':' || coalesce(last_failure_signature, 'NULL')
  from public.mirrors where id = '11111111-1111-1111-1111-111111111111';
SQL
grep -q "row:0:NULL" /tmp/mirror-count-reset.out || {
  echo "WRITE CHECK FAILED: streak then reset did not land"
  cat /tmp/mirror-count-reset.out
  exit 1
}
echo "streak write and reset write both apply"

# --- (4) negative count is rejected by the CHECK (23514) ----------------------
if PSQL_A <<'SQL' > /tmp/mirror-count-neg.out 2>&1
update public.mirrors
   set consecutive_failure_count = -1
 where id = '11111111-1111-1111-1111-111111111111';
SQL
then
  echo "NEGATIVE CHECK FAILED: negative count was accepted"
  exit 1
fi
grep -q 'violates check constraint "mirrors_consecutive_failure_count_nonnegative"' /tmp/mirror-count-neg.out || {
  echo "NEGATIVE CHECK FAILED: update failed, but not on the count CHECK:"
  cat /tmp/mirror-count-neg.out
  exit 1
}
PSQL_A <<'SQL' > /tmp/mirror-count-neg-row.out
select 'row:' || consecutive_failure_count from public.mirrors
 where id = '11111111-1111-1111-1111-111111111111';
SQL
grep -q "row:0" /tmp/mirror-count-neg-row.out || {
  echo "NEGATIVE CHECK FAILED: row changed despite the rejected update"
  cat /tmp/mirror-count-neg-row.out
  exit 1
}
echo "negative count rejected with 23514, row unchanged"

# --- (5) rollback proof: reverse file drops both columns ----------------------
PSQL_A_FILE "$STAGE/reverse.sql"
PSQL_A <<'SQL' > /tmp/mirror-count-rollback.out
select 'cols:' || count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'mirrors'
   and column_name in ('consecutive_failure_count', 'last_failure_signature');
select 'checkcount:' || count(*) from pg_constraint
 where conname = 'mirrors_consecutive_failure_count_nonnegative';
SQL
grep -q "cols:0" /tmp/mirror-count-rollback.out || {
  echo "ROLLBACK CHECK FAILED: columns still present after the reverse migration"
  cat /tmp/mirror-count-rollback.out
  exit 1
}
grep -q "checkcount:0" /tmp/mirror-count-rollback.out || {
  echo "ROLLBACK CHECK FAILED: constraint still present after the reverse migration"
  cat /tmp/mirror-count-rollback.out
  exit 1
}
echo "rollback check passed: reverse drops both columns and the constraint"

echo "ALL MIRROR-FAILURE-COUNT MIGRATION TESTS PASSED"
