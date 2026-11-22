#!/usr/bin/env bash
# Live migration test for the adu_reels failed-count check index
# (spec 229, DB optimisation plan item 5): inside every download
# claim, the database counts, per source, how many downloads failed
# in the last 24 hours — and skips the source if there are more
# than 10:
#   select count(*) from public.adu_reels r
#    where r.config_id = c.id
#      and r.status = 'download_failed'
#      and r.download_failed_at >= now() - interval '24 hours'
# The existing index idx_adu_reels_config_download_failed_at is on
# (config_id, download_failed_at): it serves the source and the
# time range but not the status, so the status is filtered by hand
# afterwards (the before-plan's Bitmap Heap Scan drops 5,000 rows
# through a Filter). The new index
# (config_id, status, download_failed_at) serves all three
# conditions as Index Cond — and, once vacuumed as production
# autovacuum does, as an Index Only Scan.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds minimal adu_configs /
# adu_reels tables plus the live claim RPC definitions (the
# 20261117183523 discovery-rank migration, applied as-is), seeds a
# 50k-row mixed pile for one config plus four small boundary
# configs, then:
#   (1) asserts the seeded failed counts (T 10,000 recent failures;
#       BAD 11; EDGE exactly 10; OLD 11 but 25h ago, so 0 recent);
#   (2) EXPLAINs the failed-count query BEFORE the migration and
#       asserts it hand-filters on download_failed_at and never
#       mentions the new index;
#   (3) claims once and records the picked reels + RPC fingerprints
#       (definitions + grants): EDGE and OLD are claimed, BAD and T
#       are skipped (both > 10 recent failures), F's newest wins;
#   (4) applies the forward migration, asserts the index exists
#       with the right definition, re-applies it (idempotent);
#   (5) VACUUMs (production autovacuum does this; without it the
#       visibility map is unset and the planner cannot choose an
#       Index Only Scan), EXPLAINs the same query AFTER and asserts
#       the plan is an Index Only Scan on the new index with no
#       Filter;
#   (6) claims again and asserts the SAME reels are picked (the
#       > 10-in-24h skip rule is unchanged) and the RPC definitions
#       + grants are byte-identical (the migration is index-only);
#   (7) drops the index inline (rollback proof) and asserts the
#       query hand-filters again.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-failed-count-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122200000_adu_reels_config_status_failed_at_index.sql"
CLAIM_DEFS="$ROOT/supabase/migrations/20261117183523_adu_discovery_rank.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$CLAIM_DEFS" ] || { echo "CLAIM DEFS NOT FOUND: $CLAIM_DEFS"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-failed-count-idx-stage
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
  # jit=off: the PGDG build's llvmjit.so needs libLLVM.so.19.1,
  # which is not installed in this sandbox; JIT is irrelevant to
  # the index plans this test asserts.
  su postgres -c "$PG_BIN/pg_ctl -D '$workdir/data' -o \"-k '$workdir/sock' -p $port -c listen_addresses='' -c jit=off\" -l '$workdir/log' start" >/dev/null
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
  stop_cluster /var/lib/postgresql/16/test-adu-failed-count-idx-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-failed-count-idx-a/sock' -p 55441 -d testfailedcount -v ON_ERROR_STOP=1 -q"
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

# Five configs, all active + synced with a buffer target, so all
# are hungry (buffer empty):
#   T    TikTok, the 50k-row mixed pile (10,000 recent failures -> skipped)
#   F    Facebook, a handful of rows, zero failures
#   BAD  TikTok, 11 failures in the last 24h -> skipped (> 10)
#   EDGE TikTok, exactly 10 failures in the last 24h -> claimed (= 10, not > 10)
#   OLD  TikTok, 11 failures but 25h ago -> claimed (outside 24h)
SEED_CONFIGS='
insert into public.adu_configs (id, status, sync_status, source_platform, source_username, posts_per_day) values
  ('"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'bigpile'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'facebook'"'"', '"'"'smallpile'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'bad11'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'edge10'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000005'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'old11'"'"', 5);
'

# T's pile: 50,000 rows spread over the last day, so the planner
# cannot pretend the lookup is cheap. g%10: 0-5 pending (60%),
# 6-7 download_failed within 24h (20% -> 10,000 recent failures),
# 8 download_failed 25h+ ago (10%), 9 downloaded (10%).
SEED_BIG_PILE='
insert into public.adu_reels (id, config_id, status, source_reel_id, discovery_rank, download_failed_at, created_at)
select gen_random_uuid(), '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"',
       case when g % 10 <= 5 then '"'"'pending'"'"'
            when g % 10 <= 7 then '"'"'download_failed'"'"'
            when g % 10 = 8 then '"'"'download_failed'"'"'
            else '"'"'downloaded'"'"' end,
       '"'"'bulk-'"'"' || g, (g % 60) + 1,
       case when g % 10 in (6,7) then now() - (g % 20 || '"'"' hours'"'"')::interval
            when g % 10 = 8 then now() - interval '"'"'25 hours'"'"' - (g % 5 || '"'"' hours'"'"')::interval
            else null end,
       now() - interval '"'"'1 day'"'"' + (g || '"'"' seconds'"'"')::interval
  from generate_series(1, 50000) g;
'

# F's rows: the newest (largest created_at) must win the claim both
# before and after the migration.
SEED_SMALL_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'00000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'f-oldest'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'50000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'f-mid'"'"', now() - interval '"'"'1 hour'"'"'),
  ('"'"'90000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'f-newest'"'"', now());
'

# BAD: 11 recent failures + 3 pending rows. None of the pending
# rows may ever be claimed (the source is skipped).
SEED_BAD_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, download_failed_at, created_at)
select gen_random_uuid(), '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'download_failed'"'"', '"'"'bad-fail-'"'"' || g,
       now() - interval '"'"'1 hour'"'"', now() - interval '"'"'1 hour'"'"'
  from generate_series(1, 11) g;
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'10000000-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'pending'"'"', '"'"'bad-p1'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'20000000-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'pending'"'"', '"'"'bad-p2'"'"', now() - interval '"'"'1 hour'"'"'),
  ('"'"'30000000-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'pending'"'"', '"'"'bad-p3'"'"', now());
'

# EDGE: exactly 10 recent failures + 3 pending rows. The newest
# pending row MUST be claimed (10 is not > 10).
SEED_EDGE_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, download_failed_at, created_at)
select gen_random_uuid(), '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'download_failed'"'"', '"'"'edge-fail-'"'"' || g,
       now() - interval '"'"'1 hour'"'"', now() - interval '"'"'1 hour'"'"'
  from generate_series(1, 10) g;
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'10000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'edge-p1'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'20000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'edge-p2'"'"', now() - interval '"'"'1 hour'"'"'),
  ('"'"'30000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'edge-p3'"'"', now());
'

# OLD: 11 failures, but 25h ago (outside the 24h window) + 3
# pending rows. The newest pending row MUST be claimed.
SEED_OLD_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, download_failed_at, created_at)
select gen_random_uuid(), '"'"'aaaaaaaa-0000-0000-0000-000000000005'"'"', '"'"'download_failed'"'"', '"'"'old-fail-'"'"' || g,
       now() - interval '"'"'25 hours'"'"', now() - interval '"'"'25 hours'"'"'
  from generate_series(1, 11) g;
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'10000000-0000-0000-0000-000000000005'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000005'"'"', '"'"'pending'"'"', '"'"'old-p1'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'20000000-0000-0000-0000-000000000005'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000005'"'"', '"'"'pending'"'"', '"'"'old-p2'"'"', now() - interval '"'"'1 hour'"'"'),
  ('"'"'30000000-0000-0000-0000-000000000005'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000005'"'"', '"'"'pending'"'"', '"'"'old-p3'"'"', now());
'

# The exact failed-count subquery from active_pages in both claim
# RPCs, for config T. EXPLAIN (ANALYZE, BUFFERS) so the PR body can
# quote real before/after numbers.
EXPLAIN_FAILED_COUNT='
explain (analyze, buffers)
select count(*)::int
from public.adu_reels r
where r.config_id = '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"'
  and r.status = '"'"'download_failed'"'"'
  and r.download_failed_at >= now() - interval '"'"'24 hours'"'"';
'

setup_cluster /var/lib/postgresql/16/test-adu-failed-count-idx-a 55441 testfailedcount

PSQL_A <<SQL
$SEED_SCHEMA
SQL

# Live claim RPC definitions first, as on production.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-failed-count-idx-a/sock' -p 55441 -d testfailedcount -v ON_ERROR_STOP=1 -q -f '$STAGE/claim-defs.sql'"

PSQL_A <<SQL
$SEED_CONFIGS
$SEED_SMALL_REELS
$SEED_BIG_PILE
$SEED_BAD_REELS
$SEED_EDGE_REELS
$SEED_OLD_REELS
analyze public.adu_reels;
SQL

# --- (1) seeded failed counts ----------------------------------------------
PSQL_A <<'SQL'
do $$
declare
  v_t int; v_bad int; v_edge int; v_old int; v_f int;
begin
  select count(*) into v_t from public.adu_reels
   where config_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and status = 'download_failed' and download_failed_at >= now() - interval '24 hours';
  select count(*) into v_bad from public.adu_reels
   where config_id = 'aaaaaaaa-0000-0000-0000-000000000003'
     and status = 'download_failed' and download_failed_at >= now() - interval '24 hours';
  select count(*) into v_edge from public.adu_reels
   where config_id = 'aaaaaaaa-0000-0000-0000-000000000004'
     and status = 'download_failed' and download_failed_at >= now() - interval '24 hours';
  select count(*) into v_old from public.adu_reels
   where config_id = 'aaaaaaaa-0000-0000-0000-000000000005'
     and status = 'download_failed' and download_failed_at >= now() - interval '24 hours';
  select count(*) into v_f from public.adu_reels
   where config_id = 'aaaaaaaa-0000-0000-0000-000000000002'
     and status = 'download_failed' and download_failed_at >= now() - interval '24 hours';
  if v_t <> 10000 then raise exception 'T recent failures % <> 10000', v_t; end if;
  if v_bad <> 11 then raise exception 'BAD recent failures % <> 11', v_bad; end if;
  if v_edge <> 10 then raise exception 'EDGE recent failures % <> 10', v_edge; end if;
  if v_old <> 0 then raise exception 'OLD recent failures % <> 0 (11 failures are 25h old)', v_old; end if;
  if v_f <> 0 then raise exception 'F recent failures % <> 0', v_f; end if;
  raise notice 'SEEDED FAILED COUNTS PASSED: T=10000 BAD=11 EDGE=10 OLD=0 F=0';
end $$;
SQL
echo "seeded failed counts passed"

# --- (2) BEFORE: the count must hand-filter on the failure time -------------
echo "=== EXPLAIN BEFORE (no new index) ==="
PSQL_A <<SQL > /tmp/adu-failed-count-idx-before.plan
$EXPLAIN_FAILED_COUNT
SQL
cat /tmp/adu-failed-count-idx-before.plan
grep -q "idx_adu_reels_config_status_failed_at" /tmp/adu-failed-count-idx-before.plan && {
  echo "NEGATIVE CONTROL FAILED: before-plan mentions the new index, which does not exist yet"
  exit 1
}
grep -q "Filter: (download_failed_at" /tmp/adu-failed-count-idx-before.plan || {
  echo "NEGATIVE CONTROL FAILED: before-plan has no hand Filter on download_failed_at — the old index already serves the count?"
  exit 1
}
echo "before-plan hand-filters on download_failed_at, as expected"

# --- (3) claim before, record the picks + RPC fingerprints ------------------
PSQL_A <<'SQL' > /tmp/adu-failed-count-idx-before.claims
select 'tiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_tiktok_buffer_downloads(10);
select 'nontiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_non_tiktok_buffer_downloads(10);
select 'tikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
select 'tiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
SQL
cat /tmp/adu-failed-count-idx-before.claims
# EDGE (exactly 10) and OLD (11, but 25h ago) are claimed; BAD (11
# recent) and T (10,000 recent) are skipped; F's newest wins.
grep -q "30000000-0000-0000-0000-000000000004" /tmp/adu-failed-count-idx-before.claims || {
  echo "BEFORE CLAIM FAILED: TikTok claim did not pick EDGE's newest reel (exactly 10 failures must not skip)"
  exit 1
}
grep -q "30000000-0000-0000-0000-000000000005" /tmp/adu-failed-count-idx-before.claims || {
  echo "BEFORE CLAIM FAILED: TikTok claim did not pick OLD's newest reel (11 failures 25h ago must not skip)"
  exit 1
}
grep -q "30000000-0000-0000-0000-000000000003" /tmp/adu-failed-count-idx-before.claims && {
  echo "BEFORE CLAIM FAILED: TikTok claim picked BAD's reel (11 recent failures must skip)"
  exit 1
}
grep -q "90000000-0000-0000-0000-000000000002" /tmp/adu-failed-count-idx-before.claims || {
  echo "BEFORE CLAIM FAILED: non-TikTok claim did not pick F's newest reel"
  exit 1
}
echo "before-claim picks correct: EDGE + OLD claimed, BAD + T skipped, F newest claimed"

# Reset ONLY the rows the claims picked (status='processing') back
# to pending. A blanket reset would also flip the seeded
# download_failed rows to pending and destroy the failure counts
# the identity check depends on.
PSQL_A <<SQL
update public.adu_reels
   set status = 'pending', download_retries = 0, download_claimed_at = null
 where status = 'processing';
SQL

# --- (4) apply the forward migration (twice: idempotent) -------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-failed-count-idx-a/sock' -p 55441 -d testfailedcount -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-failed-count-idx-a/sock' -p 55441 -d testfailedcount -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_reels_config_status_failed_at';
  if v_def is null then raise exception 'index idx_adu_reels_config_status_failed_at missing after migration'; end if;
  if v_def not like '%(config_id, status, download_failed_at)%' then raise exception 'index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_reels_config_status_failed_at';
  if v_count <> 1 then raise exception 'index created % times (expected 1)', v_count; end if;
  raise notice 'INDEX EXISTS WITH RIGHT DEFINITION: %', v_def;
end $$;
SQL

# --- (5) AFTER: the count must use the new index, no hand Filter ------------
# Production autovacuum keeps the visibility map set; a plain
# ANALYZE leaves it unset and the planner falls back to a Bitmap
# Heap Scan. VACUUM here stands in for autovacuum so the plan
# proves what production will do.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-failed-count-idx-a/sock' -p 55441 -d testfailedcount -v ON_ERROR_STOP=1 -q -c 'vacuum analyze public.adu_reels;'"
echo "=== EXPLAIN AFTER (new index) ==="
PSQL_A <<SQL > /tmp/adu-failed-count-idx-after.plan
$EXPLAIN_FAILED_COUNT
SQL
cat /tmp/adu-failed-count-idx-after.plan
grep -q "Index Only Scan using idx_adu_reels_config_status_failed_at" /tmp/adu-failed-count-idx-after.plan || {
  echo "AFTER PLAN FAILED: failed-count query is not an Index Only Scan on the new index"
  exit 1
}
grep -q "Filter:" /tmp/adu-failed-count-idx-after.plan && {
  echo "AFTER PLAN FAILED: plan still hand-filters despite the new index"
  cat /tmp/adu-failed-count-idx-after.plan
  exit 1
}
echo "after-plan is an Index Only Scan on the new index with no Filter"

# --- (6) claim after: same picks, RPCs + grants byte-identical ---------------
PSQL_A <<'SQL' > /tmp/adu-failed-count-idx-after.claims
select 'tiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_tiktok_buffer_downloads(10);
select 'nontiktok:' || coalesce(string_agg(reel_id::text, ',' order by reel_id), '(none)') from public.claim_non_tiktok_buffer_downloads(10);
select 'tikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontikdef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
select 'tiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_tiktok_buffer_downloads';
select 'nontiksecdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_non_tiktok_buffer_downloads';
SQL
cat /tmp/adu-failed-count-idx-after.claims
for key in tiktok nontiktok tikdef nontikdef tiksecdef nontiksecdef; do
  # psql aligned output pads each value with a leading space.
  before="$(grep -E "^ *$key:" /tmp/adu-failed-count-idx-before.claims)"
  after="$(grep -E "^ *$key:" /tmp/adu-failed-count-idx-after.claims)"
  if [ "$before" != "$after" ]; then
    echo "PARITY FAILED for $key:"
    echo "  before: $before"
    echo "  after:  $after"
    exit 1
  fi
done
echo "claim picks, RPC definitions and grants identical before/after"

# --- (7) rollback proof: drop the index, the count hand-filters again -------
PSQL_A <<SQL
drop index if exists public.idx_adu_reels_config_status_failed_at;
SQL
PSQL_A <<SQL > /tmp/adu-failed-count-idx-rollback.plan
$EXPLAIN_FAILED_COUNT
SQL
grep -q "Filter: (download_failed_at" /tmp/adu-failed-count-idx-rollback.plan || {
  echo "ROLLBACK CHECK FAILED: after dropping the index the plan still does not hand-filter"
  exit 1
}
grep -q "idx_adu_reels_config_status_failed_at" /tmp/adu-failed-count-idx-rollback.plan && {
  echo "ROLLBACK CHECK FAILED: dropped index still in plan"
  exit 1
}
echo "rollback check passed: dropping the index brings the hand Filter back"

echo "ALL ADU-FAILED-COUNT-INDEX MIGRATION TESTS PASSED"
