#!/usr/bin/env bash
# Live migration test for the subscription_payments downgrade check
# index (spec 232, DB optimisation plan item 8): the worker's
# downgrade tick (apps/worker/src/downgrade-tick.ts) scans for due
# scheduled downgrades with
#   status = 'approved' AND period_id IS NULL
#   AND is_downgrade AND scheduled_starts_at <= now()
#   ORDER BY scheduled_starts_at ASC LIMIT 100
# but the existing index idx_subscription_payments_status_created is
# on (status, created_at), so it cannot serve the ORDER BY
# scheduled_starts_at and the scan sorts. The new index
# (status, is_downgrade, scheduled_starts_at) serves the equality
# + the range + the order.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds a minimal
# subscription_payments table plus the live pre-existing index, seeds
# 5 due downgrades and a 20k-row noise pile that matches no part of
# the tick predicate in full, then:
#   (1) EXPLAINs the tick scan BEFORE the migration and asserts it
#       sorts (the old index cannot serve the order);
#   (2) runs the tick scan and records the due downgrades
#       (earliest first);
#   (3) applies the forward migration, asserts the index exists
#       with the right definition, re-applies it (idempotent), and
#       asserts the table's columns are unchanged (index-only);
#   (4) EXPLAINs the same scan AFTER and asserts the plan uses the
#       new index with no Sort step — if it does not, the item is
#       DROPPED (the plan's drop condition), not shipped;
#   (5) runs the tick scan again and asserts the SAME due
#       downgrades come back, earliest first (identity check);
#   (6) drops the index inline (rollback proof) and asserts the
#       scan sorts again.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/downgrade-check-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
#
# NOTE: CI's sql-rigs job also applies this migration (bootstrap + every
# supabase/migrations file, in filename order, against postgres:16), so
# a syntax or dependency break fails the PR checks even without this script.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122213000_subscription_payments_status_downgrade_starts_index.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration file where it can read it.
STAGE=/var/lib/postgresql/16/test-downgrade-idx-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
chown -R postgres:postgres "$STAGE"

# Plan/scan captures go under TMPDIR (~/workspace/tmpdir on this VM:
# /tmp is a near-full ~512MB tmpfs), never under /tmp directly.
PLAN_DIR="${TMPDIR:-/tmp}/spec232-downgrade-idx"
mkdir -p "$PLAN_DIR"

WORKDIR=/var/lib/postgresql/16/test-downgrade-idx-a
PORT=55441

setup_cluster() {
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR" "$WORKDIR/sock"
  chown -R postgres:postgres "$WORKDIR"
  chmod 700 "$WORKDIR"
  su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$WORKDIR/sock' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
  su postgres -c "$PG_BIN/createdb -h '$WORKDIR/sock' -p $PORT testdowngradeidx" >/dev/null
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
  su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testdowngradeidx -v ON_ERROR_STOP=1 -q -t -A"
}

# Minimal subscription_payments: only the columns the tick scan and
# the pre-existing index touch, plus the live pre-existing index on
# (status, created_at DESC). The is_downgrade / scheduled_starts_at
# columns come from 20261102160001 on main.
SEED_SCHEMA='
create table public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status text not null,
  period_id uuid,
  is_downgrade boolean not null default false,
  scheduled_starts_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_subscription_payments_status_created
  on public.subscription_payments (status, created_at desc);
'

# Five due downgrades, one per owner, distinct scheduled starts so
# earliest-first order is deterministic. Expected scan order:
# u1 (5d ago) u2 (3d) u3 (2d) u4 (1d) u5 (1h).
SEED_DUE='
insert into public.subscription_payments (id, user_id, status, period_id, is_downgrade, scheduled_starts_at, created_at) values
  ('"'"'11111111-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'approved'"'"', null, true, now() - interval '"'"'5 days'"'"', now() - interval '"'"'10 days'"'"'),
  ('"'"'11111111-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'approved'"'"', null, true, now() - interval '"'"'3 days'"'"', now() - interval '"'"'9 days'"'"'),
  ('"'"'11111111-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'approved'"'"', null, true, now() - interval '"'"'2 days'"'"', now() - interval '"'"'8 days'"'"'),
  ('"'"'11111111-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'approved'"'"', null, true, now() - interval '"'"'1 day'"'"', now() - interval '"'"'7 days'"'"'),
  ('"'"'11111111-0000-0000-0000-000000000005'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000005'"'"', '"'"'approved'"'"', null, true, now() - interval '"'"'1 hour'"'"', now() - interval '"'"'6 days'"'"');
'

# Noise pile: 20,000 rows, none of which satisfies the full tick
# predicate (status approved + period null + downgrade + due):
#   g%4=0: approved + downgrade + period null, but scheduled in the FUTURE
#   g%4=1: approved + downgrade + due, but already has a period
#   g%4=2: approved + due + period null, but NOT a downgrade
#   g%4=3: downgrade + due + period null, but status pending
# Plus 200 approved downgrades with a NULL scheduled start (the
# lte() filter excludes them).
SEED_NOISE='
insert into public.subscription_payments (user_id, status, period_id, is_downgrade, scheduled_starts_at, created_at)
select gen_random_uuid(),
  case when g % 4 = 3 then '"'"'pending'"'"' else '"'"'approved'"'"' end,
  case when g % 4 = 1 then gen_random_uuid() else null end,
  case when g % 4 = 2 then false else true end,
  case when g % 4 = 0 then now() + ((g % 72) + 1 || '"'"' hours'"'"')::interval
       else now() - ((g % 720) + 1 || '"'"' hours'"'"')::interval end,
  now() - ((g % 720) + 1 || '"'"' hours'"'"')::interval
  from generate_series(1, 20000) g;
insert into public.subscription_payments (user_id, status, period_id, is_downgrade, scheduled_starts_at, created_at)
select gen_random_uuid(), '"'"'approved'"'"', null, true, null,
       now() - ((g % 720) + 1 || '"'"' hours'"'"')::interval
  from generate_series(1, 200) g;
analyze public.subscription_payments;
'

# The exact tick scan from apps/worker/src/downgrade-tick.ts:45-52.
EXPLAIN_SCAN='
explain (analyze, buffers)
select user_id, scheduled_starts_at
from public.subscription_payments
where status = '"'"'approved'"'"'
  and period_id is null
  and is_downgrade = true
  and scheduled_starts_at <= now()
order by scheduled_starts_at asc
limit 100;
'

# Same scan without EXPLAIN, for the before/after identity check.
TICK_SCAN='
select user_id::text || '"'"'|'"'"' || scheduled_starts_at::text
from public.subscription_payments
where status = '"'"'approved'"'"'
  and period_id is null
  and is_downgrade = true
  and scheduled_starts_at <= now()
order by scheduled_starts_at asc
limit 100;
'

EXPECTED_ORDER='aaaaaaaa-0000-0000-0000-000000000001
aaaaaaaa-0000-0000-0000-000000000002
aaaaaaaa-0000-0000-0000-000000000003
aaaaaaaa-0000-0000-0000-000000000004
aaaaaaaa-0000-0000-0000-000000000005'

setup_cluster

PSQL <<SQL
$SEED_SCHEMA
$SEED_DUE
$SEED_NOISE
SQL

# Snapshot the table shape before the migration (index-only proof).
PSQL -c "select column_name || ':' || data_type from information_schema.columns where table_schema='public' and table_name='subscription_payments' order by ordinal_position;" > "$PLAN_DIR/columns-before.txt"

# --- (1) BEFORE: the scan must sort ---------------------------------------
echo "=== EXPLAIN BEFORE (no new index) ==="
PSQL <<SQL > "$PLAN_DIR/before.plan"
$EXPLAIN_SCAN
SQL
cat "$PLAN_DIR/before.plan"
grep -Eq '(^ *|-> *)Sort +[(]cost' "$PLAN_DIR/before.plan" || {
  echo "NEGATIVE CONTROL FAILED: before-plan has no plain Sort node — the old index already serves the order?"
  exit 1
}
grep -q "idx_subscription_payments_status_downgrade_starts" "$PLAN_DIR/before.plan" && {
  echo "NEGATIVE CONTROL FAILED: before-plan mentions the new index, which does not exist yet"
  exit 1
}
echo "before-plan sorts, as expected (old index cannot serve ORDER BY scheduled_starts_at)"

# --- (2) tick scan before, record the due downgrades -----------------------
PSQL <<SQL > "$PLAN_DIR/before.scan"
$TICK_SCAN
SQL
cat "$PLAN_DIR/before.scan"
BEFORE_USERS="$(cut -d'|' -f1 "$PLAN_DIR/before.scan")"
[ "$BEFORE_USERS" = "$EXPECTED_ORDER" ] || {
  echo "BEFORE SCAN FAILED: due downgrades are not the expected 5, earliest first"
  echo "got: $BEFORE_USERS"
  exit 1
}
echo "before-scan returns the expected 5 due downgrades, earliest first"

# --- (3) apply the forward migration (twice: idempotent) ------------------
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testdowngradeidx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testdowngradeidx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice (idempotent)"

PSQL <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'idx_subscription_payments_status_downgrade_starts';
  if v_def is null then raise exception 'index idx_subscription_payments_status_downgrade_starts missing after migration'; end if;
  if v_def not like '%(status, is_downgrade, scheduled_starts_at)%' then raise exception 'index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_subscription_payments_status_downgrade_starts';
  if v_count <> 1 then raise exception 'index created % times (expected 1)', v_count; end if;
  raise notice 'INDEX EXISTS WITH RIGHT DEFINITION: %', v_def;
end $$;
SQL

# Index-only: the table's columns must be byte-identical.
PSQL -c "select column_name || ':' || data_type from information_schema.columns where table_schema='public' and table_name='subscription_payments' order by ordinal_position;" > "$PLAN_DIR/columns-after.txt"
diff "$PLAN_DIR/columns-before.txt" "$PLAN_DIR/columns-after.txt" || {
  echo "INDEX-ONLY CHECK FAILED: subscription_payments columns changed"
  exit 1
}
echo "table columns unchanged (index-only)"

# --- (4) AFTER: the scan must use the new index, no Sort -------------------
echo "=== EXPLAIN AFTER (new index) ==="
PSQL <<SQL > "$PLAN_DIR/after.plan"
$EXPLAIN_SCAN
SQL
cat "$PLAN_DIR/after.plan"
grep -q "idx_subscription_payments_status_downgrade_starts" "$PLAN_DIR/after.plan" || {
  echo "DROP CONDITION HIT: after-plan does not use the new index — the item is DROPPED, not shipped"
  exit 1
}
grep -Eq '(^ *|-> *)Sort +[(]cost' "$PLAN_DIR/after.plan" && {
  echo "DROP CONDITION HIT: after-plan still sorts despite the new index — the item is DROPPED, not shipped"
  cat "$PLAN_DIR/after.plan"
  exit 1
}
echo "after-plan uses the new index with no Sort step"

# --- (5) tick scan after: same due downgrades, earliest first --------------
PSQL <<SQL > "$PLAN_DIR/after.scan"
$TICK_SCAN
SQL
cat "$PLAN_DIR/after.scan"
if ! diff "$PLAN_DIR/before.scan" "$PLAN_DIR/after.scan" >/dev/null; then
  echo "IDENTITY CHECK FAILED: tick scan differs before/after the migration"
  diff "$PLAN_DIR/before.scan" "$PLAN_DIR/after.scan" || true
  exit 1
fi
echo "identity check passed: same 5 due downgrades, earliest first, before and after"

# --- (6) rollback proof: drop the index, the scan sorts again --------------
PSQL <<SQL
drop index if exists public.idx_subscription_payments_status_downgrade_starts;
SQL
PSQL <<SQL > "$PLAN_DIR/rollback.plan"
$EXPLAIN_SCAN
SQL
grep -Eq '(^ *|-> *)Sort +[(]cost' "$PLAN_DIR/rollback.plan" || {
  echo "ROLLBACK CHECK FAILED: after dropping the index the plan still does not sort"
  exit 1
}
grep -q "idx_subscription_payments_status_downgrade_starts" "$PLAN_DIR/rollback.plan" && {
  echo "ROLLBACK CHECK FAILED: dropped index still in plan"
  exit 1
}
echo "rollback check passed: dropping the index brings the Sort back"

echo "ALL DOWNGRADE-CHECK-INDEX MIGRATION TESTS PASSED"
