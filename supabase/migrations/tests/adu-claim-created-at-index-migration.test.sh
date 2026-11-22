#!/usr/bin/env bash
# Live migration test for the adu_reels claim created_at index
# (spec 223): the downloader's claim RPCs pick one pending reel per
# active config with
#   ORDER BY created_at DESC, discovery_rank ASC NULLS LAST, id ASC
# but the existing index idx_adu_reels_config_status_rank is on
# (config_id, status, discovery_rank), so it cannot serve the
# ORDER BY created_at DESC and the lookup sorts. The new index
# (config_id, status, created_at) serves the equality + the order.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds minimal adu_configs /
# adu_reels tables plus the live claim RPC definitions (the
# 20261117183523 discovery-rank migration, applied as-is), seeds a
# 50k-row pending pile for one config, then:
#   (1) EXPLAINs the first-pending lookup BEFORE the migration and
#       asserts it sorts (the old index cannot serve the order);
#   (2) claims once and records the picked reels;
#   (3) applies the forward migration, asserts the index exists
#       with the right definition, re-applies it (idempotent);
#   (4) EXPLAINs the same lookup AFTER and asserts the plan uses
#       the new index with no full Sort (an Incremental Sort over
#       the index-ordered stream is fine);
#   (5) claims again and asserts the SAME reels are picked (claim
#       behaviour unchanged) and the RPC definitions + grants are
#       byte-identical (the migration is index-only);
#   (6) drops the index inline (rollback proof) and asserts the
#       lookup sorts again.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-claim-created-at-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122180000_adu_reels_claim_created_at_index.sql"
CLAIM_DEFS="$ROOT/supabase/migrations/20261117183523_adu_discovery_rank.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$CLAIM_DEFS" ] || { echo "CLAIM DEFS NOT FOUND: $CLAIM_DEFS"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-claim-idx-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$CLAIM_DEFS" "$STAGE/claim-defs.sql"
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
  stop_cluster /var/lib/postgresql/16/test-adu-claim-idx-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-idx-a/sock' -p 55440 -d testclaimidx -v ON_ERROR_STOP=1 -q"
}

# Pre-203 shapes (the claim-defs migration adds discovery_rank +
# view_count). The roles exist only so the grant-closure assertions
# in the claim-defs migration can run.
SEED_SCHEMA='
create table public.adu_configs (
  id uuid primary key,
  status text not null,
  sync_status text not null,
  source_platform text not null,
  source_username text,
  posts_per_day int
);
create table public.adu_reels (
  id uuid primary key,
  config_id uuid not null,
  status text not null,
  source_reel_id text not null,
  download_retries int not null default 0,
  download_failed_at timestamptz,
  download_claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
'

# One TikTok config (T) and one Facebook config (F), both active +
# synced with a buffer target, so both are hungry (buffer empty).
# T carries the 50k-row pending pile; F carries a handful of rows
# with distinct created_at values so the claim pick is
# deterministic and comparable before/after.
SEED_CONFIGS='
insert into public.adu_configs (id, status, sync_status, source_platform, source_username, posts_per_day) values
  ('"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'bigpile'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'facebook'"'"', '"'"'smallpile'"'"', 5);
'

# F's rows: the newest (largest created_at) must win the claim both
# before and after the migration.
SEED_SMALL_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'00000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'f-oldest'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'50000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'f-mid'"'"', now() - interval '"'"'1 hour'"'"'),
  ('"'"'90000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'f-newest'"'"', now());
'

# T's pile: 50,000 pending rows spread over the last day, so the
# planner cannot pretend the lookup is cheap. One row is the
# newest (created_at now(), rank 1) and must win the claim both
# before and after.
SEED_BIG_PILE='
insert into public.adu_reels (id, config_id, status, source_reel_id, discovery_rank, created_at)
select gen_random_uuid(), '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"',
       '"'"'bulk-'"'"' || g, (g % 60) + 1,
       now() - interval '"'"'1 day'"'"' + (g || '"'"' seconds'"'"')::interval
  from generate_series(1, 50000) g;
insert into public.adu_reels (id, config_id, status, source_reel_id, discovery_rank, created_at) values
  ('"'"'ffffffff-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'t-newest-rank1'"'"', 1, now());
analyze public.adu_reels;
'

# The exact first-pending lookup from hungry_pages in both claim
# RPCs, for config T. EXPLAIN (ANALYZE, BUFFERS) so the PR body can
# quote real before/after numbers.
EXPLAIN_LOOKUP='
explain (analyze, buffers)
select r.id
from public.adu_reels r
where r.config_id = '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"'
  and r.status = '"'"'pending'"'"'
  and r.download_retries < 3
order by r.created_at desc, r.discovery_rank asc nulls last, r.id asc
limit 1;
'

setup_cluster /var/lib/postgresql/16/test-adu-claim-idx-a 55440 testclaimidx

PSQL_A <<SQL
$SEED_SCHEMA
SQL

# Live claim RPC definitions first, as on production.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-idx-a/sock' -p 55440 -d testclaimidx -v ON_ERROR_STOP=1 -q -f '$STAGE/claim-defs.sql'"

PSQL_A <<SQL
$SEED_CONFIGS
$SEED_SMALL_REELS
$SEED_BIG_PILE
SQL

# --- (1) BEFORE: the lookup must sort -------------------------------------
echo "=== EXPLAIN BEFORE (no new index) ==="
PSQL_A <<SQL > /tmp/adu-claim-idx-before.plan
$EXPLAIN_LOOKUP
SQL
cat /tmp/adu-claim-idx-before.plan
# A plain Sort node (not Incremental Sort, which only sorts the
# equal-created_at group the index stream already delivers in
# order) proves the old index cannot serve the ORDER BY.
grep -Eq '(^ *|-> *)Sort +[(]cost' /tmp/adu-claim-idx-before.plan || {
  echo "NEGATIVE CONTROL FAILED: before-plan has no plain Sort node — the old index already serves the order?"
  exit 1
}
grep -q "idx_adu_reels_config_status_created_at" /tmp/adu-claim-idx-before.plan && {
  echo "NEGATIVE CONTROL FAILED: before-plan mentions the new index, which does not exist yet"
  exit 1
}
echo "before-plan sorts, as expected (old index cannot serve ORDER BY created_at DESC)"

# --- (2) claim before, record the picks + RPC fingerprints -----------------
PSQL_A <<'SQL' > /tmp/adu-claim-idx-before.claims
select 'tiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_tiktok_buffer_downloads(10);
select 'nontiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_non_tiktok_buffer_downloads(10);
select 'tikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
select 'tiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
SQL
cat /tmp/adu-claim-idx-before.claims
grep -q "ffffffff-0000-0000-0000-000000000001" /tmp/adu-claim-idx-before.claims || {
  echo "BEFORE CLAIM FAILED: TikTok claim did not pick the newest rank-1 reel"
  exit 1
}
grep -q "90000000-0000-0000-0000-000000000002" /tmp/adu-claim-idx-before.claims || {
  echo "BEFORE CLAIM FAILED: non-TikTok claim did not pick the newest reel"
  exit 1
}

# Reset the claimed rows so the after-claim runs on identical state.
PSQL_A <<SQL
update public.adu_reels
   set status = 'pending', download_retries = 0, download_claimed_at = null;
SQL

# --- (3) apply the forward migration (twice: idempotent) ------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-idx-a/sock' -p 55440 -d testclaimidx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-idx-a/sock' -p 55440 -d testclaimidx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_reels_config_status_created_at';
  if v_def is null then raise exception 'index idx_adu_reels_config_status_created_at missing after migration'; end if;
  if v_def not like '%(config_id, status, created_at)%' then raise exception 'index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_reels_config_status_created_at';
  if v_count <> 1 then raise exception 'index created % times (expected 1)', v_count; end if;
  raise notice 'INDEX EXISTS WITH RIGHT DEFINITION: %', v_def;
end $$;
SQL

# --- (4) AFTER: the lookup must use the new index, no Sort -----------------
echo "=== EXPLAIN AFTER (new index) ==="
PSQL_A <<SQL > /tmp/adu-claim-idx-after.plan
$EXPLAIN_LOOKUP
SQL
cat /tmp/adu-claim-idx-after.plan
grep -q "idx_adu_reels_config_status_created_at" /tmp/adu-claim-idx-after.plan || {
  echo "AFTER PLAN FAILED: new index not used by the first-pending lookup"
  exit 1
}
# A plain Sort node would mean the whole 50k-row set is still
# sorted; an Incremental Sort over the index-ordered stream is
# expected and fine (it only sorts rows sharing one created_at).
grep -Eq '(^ *|-> *)Sort +[(]cost' /tmp/adu-claim-idx-after.plan && {
  echo "AFTER PLAN FAILED: plan still sorts the full set despite the new index"
  cat /tmp/adu-claim-idx-after.plan
  exit 1
}
echo "after-plan uses the new index with no full Sort"

# --- (5) claim after: same picks, RPCs + grants byte-identical --------------
PSQL_A <<'SQL' > /tmp/adu-claim-idx-after.claims
select 'tiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_tiktok_buffer_downloads(10);
select 'nontiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_non_tiktok_buffer_downloads(10);
select 'tikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
select 'tiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
SQL
cat /tmp/adu-claim-idx-after.claims
for key in tiktok nontiktok tikdef nontikdef tiksecdef nontiksecdef; do
  # psql aligned output pads each value with a leading space.
  before="$(grep -E "^ *$key:" /tmp/adu-claim-idx-before.claims)"
  after="$(grep -E "^ *$key:" /tmp/adu-claim-idx-after.claims)"
  if [ "$before" != "$after" ]; then
    echo "PARITY FAILED for $key:"
    echo "  before: $before"
    echo "  after:  $after"
    exit 1
  fi
done
echo "claim picks, RPC definitions and grants identical before/after"

# --- (6) rollback proof: drop the index, the lookup sorts again ------------
PSQL_A <<SQL
drop index if exists public.idx_adu_reels_config_status_created_at;
SQL
PSQL_A <<SQL > /tmp/adu-claim-idx-rollback.plan
$EXPLAIN_LOOKUP
SQL
grep -Eq '(^ *|-> *)Sort +[(]cost' /tmp/adu-claim-idx-rollback.plan || {
  echo "ROLLBACK CHECK FAILED: after dropping the index the plan still does not sort"
  exit 1
}
grep -q "idx_adu_reels_config_status_created_at" /tmp/adu-claim-idx-rollback.plan && {
  echo "ROLLBACK CHECK FAILED: dropped index still in plan"
  exit 1
}
echo "rollback check passed: dropping the index brings the Sort back"

echo "ALL ADU-CLAIM-CREATED-AT-INDEX MIGRATION TESTS PASSED"
