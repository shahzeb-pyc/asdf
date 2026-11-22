#!/usr/bin/env bash
# Live migration test for the stale-download reset index (spec 228,
# DB optimisation plan item 4): `reset_stale_adu_reel_downloads`
# finds stuck downloads with
#   WHERE status = 'processing'
#     AND download_claimed_at IS NOT NULL
#     AND download_claimed_at < now() - make_interval(mins => 40)
#     AND download_retries < 3
# but every existing adu_reels index leads with config_id, which
# this query never filters on, so every call seq-scans. The new
# partial index (download_claimed_at) WHERE status = 'processing'
# serves it directly.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres`
# system user (postgres refuses to run as root), seeds a minimal
# adu_reels table plus the live reset function (verbatim from
# 20261030130000_adu_claim_rpc.sql) and the existing
# (config_id, status) index, seeds a 50k-row pile, then:
#   (1) EXPLAINs the reset UPDATE BEFORE the migration and asserts
#       it scans every processing row (the old index can only be
#       scanned on status, so claimed_at is a filter, not a lookup);
#   (2) runs the reset and records the exact stuck rows it resets;
#   (3) restores those rows to their stuck state, applies the
#       forward migration, asserts the index exists with the right
#       definition, re-applies it (idempotent);
#   (4) EXPLAINs the same UPDATE AFTER and asserts the plan uses
#       the new index with no full processing-row scan;
#   (5) runs the reset again and asserts the SAME rows (same ids,
#       same count) are reset and the reset function definition is
#       byte-identical (the migration is index-only);
#   (6) drops the index inline (rollback proof) and asserts the
#       plan scans the processing rows again.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-stale-reset-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122193000_adu_reels_processing_claimed_at_index.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration file where it can read it.
STAGE=/var/lib/postgresql/16/test-adu-stale-reset-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
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
  stop_cluster /var/lib/postgresql/16/test-adu-stale-reset-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-stale-reset-a/sock' -p 55441 -d teststalereset -v ON_ERROR_STOP=1 -q"
}
PSQL_A_FILE() { # $1=file
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-stale-reset-a/sock' -p 55441 -d teststalereset -v ON_ERROR_STOP=1 -q -f '$1'"
}

# Minimal adu_reels shape the reset touches, the existing
# (config_id, status) index (the one the reset cannot use), and
# the reset function verbatim from 20261030130000_adu_claim_rpc.sql.
# Quoted heredoc delimiter: the function body contains $$, which
# must reach psql untouched.
cat > "$STAGE/seed.sql" <<'SEEDSQL'
create table public.adu_reels (
  id uuid primary key,
  config_id uuid not null,
  status text not null,
  download_retries int not null default 0,
  download_claimed_at timestamptz
);
create index if not exists idx_adu_reels_config_status
  on public.adu_reels (config_id, status);
create or replace function public.reset_stale_adu_reel_downloads(p_stale_minutes int default 40)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reset_count integer;
begin
  update public.adu_reels
  set
    status = 'pending',
    download_claimed_at = null
  where status = 'processing'
    and download_claimed_at is not null
    and download_claimed_at < now() - make_interval(mins => p_stale_minutes)
    and download_retries < 3;
  get diagnostics v_reset_count = row_count;
  return v_reset_count;
end;
$$;
SEEDSQL

# The pile: 50,000 pending rows so the planner cannot pretend the
# lookup is cheap, 200 fresh processing rows (claimed minutes ago,
# inside the partial index but not stale), and the six edge rows:
#   S1..S3 stuck (claimed 2h ago, retries 0/1/2) — MUST reset
#   F1    fresh (claimed 5 min ago) — must NOT reset
#   R1    retry-exhausted (claimed 2h ago, retries 3) — must NOT reset
#   N1    processing with no claim timestamp — must NOT reset
#   D1    downloaded, claimed 2h ago — must NOT reset
cat > "$STAGE/seed-data.sql" <<'SEEDSQL'
insert into public.adu_reels (id, config_id, status, download_claimed_at, download_retries)
select gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'pending', null, 0
  from generate_series(1, 50000) g;
insert into public.adu_reels (id, config_id, status, download_claimed_at, download_retries)
select gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'processing',
       now() - (g || ' seconds')::interval, 0
  from generate_series(1, 200) g;
insert into public.adu_reels (id, config_id, status, download_claimed_at, download_retries) values
  ('10000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'processing', now() - interval '2 hours', 0),
  ('20000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'processing', now() - interval '2 hours', 1),
  ('30000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'processing', now() - interval '2 hours', 2),
  ('40000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'processing', now() - interval '5 minutes', 0),
  ('50000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'processing', now() - interval '2 hours', 3),
  ('60000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'processing', null, 0),
  ('70000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'downloaded', now() - interval '2 hours', 0);
analyze public.adu_reels;
SEEDSQL

# The reset UPDATE itself (the exact WHERE from the function), run
# inside a rolled-back transaction so EXPLAIN ANALYZE measures the
# plan without mutating the seed.
cat > "$STAGE/explain-reset.sql" <<'SEEDSQL'
begin;
explain (analyze, buffers)
update public.adu_reels
   set status = 'pending', download_claimed_at = null
 where status = 'processing'
   and download_claimed_at is not null
   and download_claimed_at < now() - make_interval(mins => 40)
   and download_retries < 3;
rollback;
SEEDSQL
chown -R postgres:postgres "$STAGE"

setup_cluster /var/lib/postgresql/16/test-adu-stale-reset-a 55441 teststalereset

PSQL_A_FILE "$STAGE/seed.sql"
PSQL_A_FILE "$STAGE/seed-data.sql"

# --- (1) BEFORE: the reset must NOT use the new index -----------------------
# The old (config_id, status) index can only be scanned on status, so
# the plan walks every processing row and filters on claimed_at
# (Rows Removed by Filter ~203 of ~206). It must not mention the new
# index, which does not exist yet.
echo "=== EXPLAIN BEFORE (no new index) ==="
PSQL_A_FILE "$STAGE/explain-reset.sql" > /tmp/adu-stale-reset-before.plan
cat /tmp/adu-stale-reset-before.plan
grep -q "idx_adu_reels_processing_claimed_at" /tmp/adu-stale-reset-before.plan && {
  echo "NEGATIVE CONTROL FAILED: before-plan mentions the new index, which does not exist yet"
  exit 1
}
grep -Eq "Seq Scan on public.adu_reels|Index Scan using idx_adu_reels_config_status" /tmp/adu-stale-reset-before.plan || {
  echo "NEGATIVE CONTROL FAILED: before-plan uses neither a Seq Scan nor the old (config_id, status) index"
  exit 1
}
grep -Eq "Rows Removed by Filter: 20[0-9]" /tmp/adu-stale-reset-before.plan || {
  echo "NEGATIVE CONTROL FAILED: before-plan did not filter out the ~203 fresh processing rows — seed is wrong"
  exit 1
}
echo "before-plan scans every processing row and filters on claimed_at, as expected"

# --- (2) reset before, record exactly which rows reset ----------------------
PSQL_A <<'SQL' > /tmp/adu-stale-reset-before.reset
select 'resetdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'reset_stale_adu_reel_downloads';
create temp table expected_reset as
  select id, download_claimed_at, download_retries from public.adu_reels
   where status = 'processing'
     and download_claimed_at is not null
     and download_claimed_at < now() - make_interval(mins => 40)
     and download_retries < 3;
select 'expected:' || count(*) from expected_reset;
select 'resetcount:' || public.reset_stale_adu_reel_downloads(40);
select 'resetids:' || coalesce(string_agg(id::text, ',' order by id), '(none)') from expected_reset;
select 'pending_after:' || count(*) from public.adu_reels r join expected_reset e on e.id = r.id where r.status = 'pending' and r.download_claimed_at is null;
select 'fresh_still_processing:' || count(*) from public.adu_reels where id = '40000000-0000-0000-0000-000000000001' and status = 'processing';
select 'exhausted_still_processing:' || count(*) from public.adu_reels where id = '50000000-0000-0000-0000-000000000001' and status = 'processing';
select 'nullclaim_still_processing:' || count(*) from public.adu_reels where id = '60000000-0000-0000-0000-000000000001' and status = 'processing';
select 'downloaded_untouched:' || count(*) from public.adu_reels where id = '70000000-0000-0000-0000-000000000001' and status = 'downloaded';
SQL
cat /tmp/adu-stale-reset-before.reset
grep -q "expected:3" /tmp/adu-stale-reset-before.reset || {
  echo "BEFORE RESET FAILED: expected 3 stuck rows, seed is wrong"
  exit 1
}
grep -q "resetcount:3" /tmp/adu-stale-reset-before.reset || {
  echo "BEFORE RESET FAILED: reset did not return 3"
  exit 1
}
grep -q "resetids:10000000-0000-0000-0000-000000000001,20000000-0000-0000-0000-000000000001,30000000-0000-0000-0000-000000000001" /tmp/adu-stale-reset-before.reset || {
  echo "BEFORE RESET FAILED: reset ids are not exactly S1,S2,S3"
  exit 1
}
grep -q "pending_after:3" /tmp/adu-stale-reset-before.reset || {
  echo "BEFORE RESET FAILED: reset rows did not land pending with a cleared claim"
  exit 1
}
for key in fresh_still_processing exhausted_still_processing nullclaim_still_processing downloaded_untouched; do
  grep -q "$key:1" /tmp/adu-stale-reset-before.reset || {
    echo "BEFORE RESET FAILED: $key edge row was wrongly reset or touched"
    exit 1
  }
done
echo "before-reset resets exactly S1,S2,S3 and leaves every edge row alone"

# Restore the three stuck rows to their pre-reset state so the
# after-reset runs on identical state.
PSQL_A <<'SQL'
update public.adu_reels r
   set status = 'processing', download_claimed_at = e.download_claimed_at, download_retries = e.download_retries
  from (select '10000000-0000-0000-0000-000000000001'::uuid as id, now() - interval '2 hours' as download_claimed_at, 0 as download_retries
        union all select '20000000-0000-0000-0000-000000000001', now() - interval '2 hours', 1
        union all select '30000000-0000-0000-0000-000000000001', now() - interval '2 hours', 2) e
 where r.id = e.id;
SQL

# --- (3) apply the forward migration (twice: idempotent) --------------------
PSQL_A_FILE "$STAGE/forward.sql"
PSQL_A_FILE "$STAGE/forward.sql"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_reels_processing_claimed_at';
  if v_def is null then raise exception 'index idx_adu_reels_processing_claimed_at missing after migration'; end if;
  if v_def not like '%(download_claimed_at)%' then raise exception 'index definition wrong: %', v_def; end if;
  if v_def not like '%processing%' then raise exception 'index is not partial on processing: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_reels_processing_claimed_at';
  if v_count <> 1 then raise exception 'index created % times (expected 1)', v_count; end if;
  raise notice 'INDEX EXISTS WITH RIGHT DEFINITION: %', v_def;
end $$;
SQL

# --- (4) AFTER: the reset must use the new index, no full scan ---------------
echo "=== EXPLAIN AFTER (new index) ==="
PSQL_A_FILE "$STAGE/explain-reset.sql" > /tmp/adu-stale-reset-after.plan
cat /tmp/adu-stale-reset-after.plan
grep -q "idx_adu_reels_processing_claimed_at" /tmp/adu-stale-reset-after.plan || {
  echo "AFTER PLAN FAILED: new index not used by the reset UPDATE"
  exit 1
}
grep -Eq "Seq Scan on public.adu_reels|Index Scan using idx_adu_reels_config_status" /tmp/adu-stale-reset-after.plan && {
  echo "AFTER PLAN FAILED: plan still scans every processing row despite the new index"
  cat /tmp/adu-stale-reset-after.plan
  exit 1
}
echo "after-plan uses the new index with no full processing-row scan"

# --- (5) reset after: same rows, function definition identical ---------------
PSQL_A <<'SQL' > /tmp/adu-stale-reset-after.reset
select 'resetdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'reset_stale_adu_reel_downloads';
select 'resetcount:' || public.reset_stale_adu_reel_downloads(40);
select 'resetids:' || coalesce(string_agg(id::text, ',' order by id), '(none)') from public.adu_reels where status = 'pending' and download_claimed_at is null and id in ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001');
select 'fresh_still_processing:' || count(*) from public.adu_reels where id = '40000000-0000-0000-0000-000000000001' and status = 'processing';
select 'exhausted_still_processing:' || count(*) from public.adu_reels where id = '50000000-0000-0000-0000-000000000001' and status = 'processing';
select 'nullclaim_still_processing:' || count(*) from public.adu_reels where id = '60000000-0000-0000-0000-000000000001' and status = 'processing';
select 'downloaded_untouched:' || count(*) from public.adu_reels where id = '70000000-0000-0000-0000-000000000001' and status = 'downloaded';
SQL
cat /tmp/adu-stale-reset-after.reset
for key in resetcount resetids; do
  before="$(grep -E "^ *$key:" /tmp/adu-stale-reset-before.reset)"
  after="$(grep -E "^ *$key:" /tmp/adu-stale-reset-after.reset)"
  if [ "$before" != "$after" ]; then
    echo "PARITY FAILED for $key:"
    echo "  before: $before"
    echo "  after:  $after"
    exit 1
  fi
done
before_def="$(grep -E '^ *resetdef:' /tmp/adu-stale-reset-before.reset)"
after_def="$(grep -E '^ *resetdef:' /tmp/adu-stale-reset-after.reset)"
if [ "$before_def" != "$after_def" ]; then
  echo "PARITY FAILED for resetdef: migration changed the reset function"
  echo "  before: $before_def"
  echo "  after:  $after_def"
  exit 1
fi
for key in fresh_still_processing exhausted_still_processing nullclaim_still_processing downloaded_untouched; do
  grep -q "$key:1" /tmp/adu-stale-reset-after.reset || {
    echo "AFTER RESET FAILED: $key edge row was wrongly reset or touched"
    exit 1
  }
done
echo "reset ids, count and function definition identical before/after"

# --- (6) rollback proof: drop the index, the reset scans again --------------
PSQL_A <<'SQL'
drop index if exists public.idx_adu_reels_processing_claimed_at;
SQL
PSQL_A_FILE "$STAGE/explain-reset.sql" > /tmp/adu-stale-reset-rollback.plan
grep -Eq "Seq Scan on public.adu_reels|Index Scan using idx_adu_reels_config_status" /tmp/adu-stale-reset-rollback.plan || {
  echo "ROLLBACK CHECK FAILED: after dropping the index the plan still does not scan the processing rows"
  exit 1
}
grep -q "idx_adu_reels_processing_claimed_at" /tmp/adu-stale-reset-rollback.plan && {
  echo "ROLLBACK CHECK FAILED: dropped index still in plan"
  exit 1
}
echo "rollback check passed: dropping the index brings the full scan back"

echo "ALL ADU-STALE-RESET-INDEX MIGRATION TESTS PASSED"
