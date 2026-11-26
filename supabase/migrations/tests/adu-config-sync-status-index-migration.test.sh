#!/usr/bin/env bash
# Live migration test for the adu_configs source pickup index
# (spec 230, DB optimisation plan item 6): the scraper's pickup
# routines (`get_next_pending_adu_config` and
# `get_next_browser_pending_adu_config`, 20261030130000) pick one
# source with sync_status 'pending' (or 'browser_pending'),
# optionally filtered by source_platform — but no index leads with
# sync_status, so every call scans the sources table. The new index
# (sync_status, source_platform) serves the equality on both.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds minimal adu_configs /
# adu_reels tables plus the live pickup RPC definitions (the
# 20261030130000 claim-RPC migration, applied as-is), seeds a 20k-row
# synced pile plus a handful of pending / browser_pending sources,
# then:
#   (1) EXPLAINs the pickup lookup BEFORE the migration and asserts
#       it seq-scans (no index leads with sync_status);
#   (2) calls both pickup routines and asserts the KIND of pick —
#       one pending source, right platform and username, marked
#       processing — never a specific source id (the routines have
#       no ORDER BY, so the pick is deliberately unspecified);
#   (3) applies the forward migration, asserts the index exists
#       with the right definition, re-applies it (idempotent);
#   (4) EXPLAINs the same lookups AFTER and asserts the plans use
#       the new index with no Seq Scan;
#   (5) calls both pickup routines again and asserts the same KIND
#       of pick, and the RPC definitions are byte-identical (the
#       migration is index-only);
#   (6) drops the index inline (rollback proof) and asserts the
#       lookup seq-scans again.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-config-sync-status-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122203000_adu_configs_sync_status_platform_index.sql"
PICKUP_DEFS="$ROOT/supabase/migrations/20261030130000_adu_claim_rpc.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$PICKUP_DEFS" ] || { echo "PICKUP DEFS NOT FOUND: $PICKUP_DEFS"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-config-sync-idx-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$PICKUP_DEFS" "$STAGE/pickup-defs.sql"
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
  stop_cluster /var/lib/postgresql/16/test-adu-config-sync-idx-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-config-sync-idx-a/sock' -p 55441 -d testconfigsyncidx -v ON_ERROR_STOP=1 -q"
}

# Minimal shapes the pickup RPCs touch (the pickup-defs migration
# adds the media_size_bytes / content-type / download_claimed_at /
# download_failed_at columns to adu_reels itself).
SEED_SCHEMA='
create table public.adu_configs (
  id uuid primary key,
  status text not null,
  sync_status text not null,
  source_platform text not null,
  source_username text,
  posts_per_day int,
  updated_at timestamptz not null default now()
);
create table public.adu_reels (
  id uuid primary key,
  config_id uuid not null,
  status text not null,
  source_reel_id text not null,
  caption text,
  media_url text,
  media_object_key text,
  media_sha256 text,
  download_retries int not null default 0,
  downloaded_at timestamptz,
  created_at timestamptz not null default now()
);
'

# Pending sources (the pick pool) and browser-pending sources, each
# with a distinct username so the identity check can name the set
# without naming one row. Everything else is synced, so the pile
# below is the haystack the lookup must not scan.
SEED_PICK_POOL='
insert into public.adu_configs (id, status, sync_status, source_platform, source_username, posts_per_day) values
  ('"'"'aaaaaaaa-0000-0000-0000-000000000011'"'"', '"'"'active'"'"', '"'"'pending'"'"', '"'"'tiktok'"'"', '"'"'pend-tik-1'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000012'"'"', '"'"'active'"'"', '"'"'pending'"'"', '"'"'tiktok'"'"', '"'"'pend-tik-2'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000013'"'"', '"'"'active'"'"', '"'"'pending'"'"', '"'"'tiktok'"'"', '"'"'pend-tik-3'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000014'"'"', '"'"'active'"'"', '"'"'pending'"'"', '"'"'facebook'"'"', '"'"'pend-fb-1'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000015'"'"', '"'"'active'"'"', '"'"'pending'"'"', '"'"'facebook'"'"', '"'"'pend-fb-2'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000016'"'"', '"'"'active'"'"', '"'"'pending'"'"', '"'"'instagram'"'"', '"'"'pend-ig-1'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000021'"'"', '"'"'active'"'"', '"'"'browser_pending'"'"', '"'"'tiktok'"'"', '"'"'bpend-tik-1'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000022'"'"', '"'"'active'"'"', '"'"'browser_pending'"'"', '"'"'tiktok'"'"', '"'"'bpend-tik-2'"'"', 1),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000023'"'"', '"'"'active'"'"', '"'"'browser_pending'"'"', '"'"'facebook'"'"', '"'"'bpend-fb-1'"'"', 1);
'

# The haystack: 20,000 synced configs, so the planner cannot
# pretend the pickup lookup is cheap. Seeded BEFORE the pick pool,
# so the pending rows sit at the heap end — the production shape
# (pending sources are rare among mostly-synced ones), and a
# seq scan must traverse the pile before finding one.
SEED_PILE='
insert into public.adu_configs (id, status, sync_status, source_platform, source_username, posts_per_day)
select gen_random_uuid(), '"'"'active'"'"', '"'"'synced'"'"',
       (array['"'"'tiktok'"'"','"'"'facebook'"'"','"'"'instagram'"'"','"'"'youtube'"'"'])[1 + (g % 4)],
       '"'"'bulk-'"'"' || g, 1
  from generate_series(1, 20000) g;
analyze public.adu_configs;
'

# The exact pickup lookups from inside both routines, with
# p_platform = 'tiktok'. EXPLAIN (ANALYZE, BUFFERS) so the PR body
# can quote real before/after numbers.
EXPLAIN_LOOKUP='
explain (analyze, buffers)
select c.id
from public.adu_configs c
where c.sync_status = '"'"'pending'"'"'
  and c.source_platform = '"'"'tiktok'"'"'
limit 1
for update skip locked;
'
EXPLAIN_BROWSER_LOOKUP='
explain (analyze, buffers)
select c.id
from public.adu_configs c
where c.sync_status = '"'"'browser_pending'"'"'
  and c.source_platform = '"'"'tiktok'"'"'
limit 1
for update skip locked;
'

setup_cluster /var/lib/postgresql/16/test-adu-config-sync-idx-a 55441 testconfigsyncidx

PSQL_A <<SQL
$SEED_SCHEMA
SQL

# Live pickup RPC definitions first, as on production.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-config-sync-idx-a/sock' -p 55441 -d testconfigsyncidx -v ON_ERROR_STOP=1 -q -f '$STAGE/pickup-defs.sql'"

PSQL_A <<SQL
$SEED_PILE
$SEED_PICK_POOL
SQL

# --- (1) BEFORE: both lookups must seq-scan --------------------------------
echo "=== EXPLAIN BEFORE (no new index) — pending ==="
PSQL_A <<SQL > /tmp/adu-config-sync-idx-before.plan
$EXPLAIN_LOOKUP
SQL
cat /tmp/adu-config-sync-idx-before.plan
grep -Eq '(^ *|-> *)Seq Scan on adu_configs' /tmp/adu-config-sync-idx-before.plan || {
  echo "NEGATIVE CONTROL FAILED: before-plan has no Seq Scan on adu_configs — some index already serves the pickup?"
  exit 1
}
grep -q "idx_adu_configs_sync_status_platform" /tmp/adu-config-sync-idx-before.plan && {
  echo "NEGATIVE CONTROL FAILED: before-plan mentions the new index, which does not exist yet"
  exit 1
}
echo "before-plan seq-scans, as expected (no index leads with sync_status)"

echo "=== EXPLAIN BEFORE (no new index) — browser_pending ==="
PSQL_A <<SQL > /tmp/adu-config-sync-idx-before-browser.plan
$EXPLAIN_BROWSER_LOOKUP
SQL
cat /tmp/adu-config-sync-idx-before-browser.plan
grep -Eq '(^ *|-> *)Seq Scan on adu_configs' /tmp/adu-config-sync-idx-before-browser.plan || {
  echo "NEGATIVE CONTROL FAILED: browser before-plan has no Seq Scan on adu_configs"
  exit 1
}
echo "browser before-plan seq-scans too"

# --- (2) identity check BEFORE ----------------------------------------------
# KIND of pick only: one row, right platform, username from the
# pending set for that platform, and the picked row is now
# 'processing'. The picked id itself is deliberately never asserted
# (no ORDER BY — the pick is unspecified).
PSQL_A <<'SQL' > /tmp/adu-config-sync-idx-before.pick
select 'pending:' || source_username || ':' || source_platform
  from public.get_next_pending_adu_config('tiktok');
select 'browser:' || source_username || ':' || source_platform
  from public.get_next_browser_pending_adu_config('tiktok');
select 'penddef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_pending_adu_config';
select 'bpenddef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_browser_pending_adu_config';
select 'pendsecdef:' || p.prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_pending_adu_config';
select 'bpendsecdef:' || p.prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_browser_pending_adu_config';
SQL
cat /tmp/adu-config-sync-idx-before.pick
grep -Eq "^ *pending:pend-tik-[123]:tiktok$" /tmp/adu-config-sync-idx-before.pick || {
  echo "BEFORE PICK FAILED: pending pickup did not return a pending TikTok source"
  exit 1
}
grep -Eq "^ *browser:bpend-tik-[12]:tiktok$" /tmp/adu-config-sync-idx-before.pick || {
  echo "BEFORE PICK FAILED: browser_pending pickup did not return a browser-pending TikTok source"
  exit 1
}
PSQL_A <<'SQL'
do $$
declare v_processing int; v_pending int; v_bprocessing int; v_bpending int;
begin
  select count(*) into v_processing from public.adu_configs
   where sync_status = 'processing' and source_username like 'pend-tik-%';
  select count(*) into v_pending from public.adu_configs
   where sync_status = 'pending' and source_username like 'pend-tik-%';
  select count(*) into v_bprocessing from public.adu_configs
   where sync_status = 'processing' and source_username like 'bpend-tik-%';
  select count(*) into v_bpending from public.adu_configs
   where sync_status = 'browser_pending' and source_username like 'bpend-tik-%';
  if v_processing <> 1 or v_pending <> 2 then
    raise exception 'BEFORE PICK FAILED: pending TikTok pool is % processing / % pending (expected 1 / 2)', v_processing, v_pending;
  end if;
  if v_bprocessing <> 1 or v_bpending <> 1 then
    raise exception 'BEFORE PICK FAILED: browser_pending TikTok pool is % processing / % pending (expected 1 / 1)', v_bprocessing, v_bpending;
  end if;
  raise notice 'BEFORE PICK: exactly one pending + one browser_pending TikTok source marked processing';
end $$;
SQL
echo "before identity check passed (kind of pick, not a specific id)"

# Reset the picked rows so the after-check runs on identical state.
PSQL_A <<SQL
update public.adu_configs set sync_status = 'pending'
 where sync_status = 'processing' and source_username like 'pend-tik-%';
update public.adu_configs set sync_status = 'browser_pending'
 where sync_status = 'processing' and source_username like 'bpend-tik-%';
SQL

# --- (3) apply the forward migration (twice: idempotent) --------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-config-sync-idx-a/sock' -p 55441 -d testconfigsyncidx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-config-sync-idx-a/sock' -p 55441 -d testconfigsyncidx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_configs_sync_status_platform';
  if v_def is null then raise exception 'index idx_adu_configs_sync_status_platform missing after migration'; end if;
  if v_def not like '%(sync_status, source_platform)%' then raise exception 'index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_adu_configs_sync_status_platform';
  if v_count <> 1 then raise exception 'index created % times (expected 1)', v_count; end if;
  raise notice 'INDEX EXISTS WITH RIGHT DEFINITION: %', v_def;
end $$;
SQL

# --- (4) AFTER: both lookups must use the new index, no Seq Scan ------------
echo "=== EXPLAIN AFTER (new index) — pending ==="
PSQL_A <<SQL > /tmp/adu-config-sync-idx-after.plan
$EXPLAIN_LOOKUP
SQL
cat /tmp/adu-config-sync-idx-after.plan
grep -q "idx_adu_configs_sync_status_platform" /tmp/adu-config-sync-idx-after.plan || {
  echo "AFTER PLAN FAILED: new index not used by the pending pickup lookup"
  exit 1
}
grep -Eq '(^ *|-> *)Seq Scan on adu_configs' /tmp/adu-config-sync-idx-after.plan && {
  echo "AFTER PLAN FAILED: plan still seq-scans adu_configs despite the new index"
  cat /tmp/adu-config-sync-idx-after.plan
  exit 1
}
echo "after-plan uses the new index with no Seq Scan"

echo "=== EXPLAIN AFTER (new index) — browser_pending ==="
PSQL_A <<SQL > /tmp/adu-config-sync-idx-after-browser.plan
$EXPLAIN_BROWSER_LOOKUP
SQL
cat /tmp/adu-config-sync-idx-after-browser.plan
grep -q "idx_adu_configs_sync_status_platform" /tmp/adu-config-sync-idx-after-browser.plan || {
  echo "AFTER PLAN FAILED: new index not used by the browser_pending pickup lookup"
  exit 1
}
grep -Eq '(^ *|-> *)Seq Scan on adu_configs' /tmp/adu-config-sync-idx-after-browser.plan && {
  echo "AFTER PLAN FAILED: browser plan still seq-scans adu_configs despite the new index"
  cat /tmp/adu-config-sync-idx-after-browser.plan
  exit 1
}
echo "browser after-plan uses the new index with no Seq Scan"

# --- (5) identity check AFTER: same KIND of pick, RPCs byte-identical -------
PSQL_A <<'SQL' > /tmp/adu-config-sync-idx-after.pick
select 'pending:' || source_username || ':' || source_platform
  from public.get_next_pending_adu_config('tiktok');
select 'browser:' || source_username || ':' || source_platform
  from public.get_next_browser_pending_adu_config('tiktok');
select 'penddef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_pending_adu_config';
select 'bpenddef:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_browser_pending_adu_config';
select 'pendsecdef:' || p.prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_pending_adu_config';
select 'bpendsecdef:' || p.prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_next_browser_pending_adu_config';
SQL
cat /tmp/adu-config-sync-idx-after.pick
grep -Eq "^ *pending:pend-tik-[123]:tiktok$" /tmp/adu-config-sync-idx-after.pick || {
  echo "AFTER PICK FAILED: pending pickup did not return a pending TikTok source"
  exit 1
}
grep -Eq "^ *browser:bpend-tik-[12]:tiktok$" /tmp/adu-config-sync-idx-after.pick || {
  echo "AFTER PICK FAILED: browser_pending pickup did not return a browser-pending TikTok source"
  exit 1
}
PSQL_A <<'SQL'
do $$
declare v_processing int; v_pending int; v_bprocessing int; v_bpending int;
begin
  select count(*) into v_processing from public.adu_configs
   where sync_status = 'processing' and source_username like 'pend-tik-%';
  select count(*) into v_pending from public.adu_configs
   where sync_status = 'pending' and source_username like 'pend-tik-%';
  select count(*) into v_bprocessing from public.adu_configs
   where sync_status = 'processing' and source_username like 'bpend-tik-%';
  select count(*) into v_bpending from public.adu_configs
   where sync_status = 'browser_pending' and source_username like 'bpend-tik-%';
  if v_processing <> 1 or v_pending <> 2 then
    raise exception 'AFTER PICK FAILED: pending TikTok pool is % processing / % pending (expected 1 / 2)', v_processing, v_pending;
  end if;
  if v_bprocessing <> 1 or v_bpending <> 1 then
    raise exception 'AFTER PICK FAILED: browser_pending TikTok pool is % processing / % pending (expected 1 / 1)', v_bprocessing, v_bpending;
  end if;
  raise notice 'AFTER PICK: exactly one pending + one browser_pending TikTok source marked processing';
end $$;
SQL
# The picked id may legitimately differ before/after (no ORDER BY),
# so only the RPC fingerprints are compared — the pick itself is
# asserted by kind above, never by id.
for key in penddef bpenddef pendsecdef bpendsecdef; do
  before="$(grep -E "^ *$key:" /tmp/adu-config-sync-idx-before.pick)"
  after="$(grep -E "^ *$key:" /tmp/adu-config-sync-idx-after.pick)"
  if [ "$before" != "$after" ]; then
    echo "PARITY FAILED for $key:"
    echo "  before: $before"
    echo "  after:  $after"
    exit 1
  fi
done
echo "pickup RPC definitions and SECURITY DEFINER posture identical before/after (index-only)"

# --- (6) rollback proof: drop the index, the lookup seq-scans again ---------
PSQL_A <<SQL
drop index if exists public.idx_adu_configs_sync_status_platform;
SQL
PSQL_A <<SQL > /tmp/adu-config-sync-idx-rollback.plan
$EXPLAIN_LOOKUP
SQL
grep -Eq '(^ *|-> *)Seq Scan on adu_configs' /tmp/adu-config-sync-idx-rollback.plan || {
  echo "ROLLBACK CHECK FAILED: after dropping the index the plan still does not seq-scan"
  exit 1
}
grep -q "idx_adu_configs_sync_status_platform" /tmp/adu-config-sync-idx-rollback.plan && {
  echo "ROLLBACK CHECK FAILED: dropped index still in plan"
  exit 1
}
echo "rollback check passed: dropping the index brings the Seq Scan back"

echo "ALL ADU-CONFIG-SYNC-STATUS-INDEX MIGRATION TESTS PASSED"
