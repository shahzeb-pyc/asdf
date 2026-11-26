#!/usr/bin/env bash
# Live migration test for the mirror counts index (spec 234, plan
# item 10): the list card's Posted/Failed counts and the detail
# view's Posted/Failed/Skipped counts filter mirror_posts on
# mirror_id + status, but the existing index idx_mirror_posts_mirror
# is on (mirror_id, created_at DESC) — it carries no status, so
# every row of the mirror is heap-fetched just to evaluate the
# status filter. The new index (mirror_id, status) serves the
# equality filter, so the planner reads only the mirror's rows
# through the index instead of seq-scanning the table. (The
# planner legitimately picks a Bitmap Index Scan for a mirror
# holding ~21% of the table; the spec requires only that the
# count uses the new index, not a particular scan shape.)
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), applies the live base
# migration 20261029160000_tiktok_mirrors.sql as-is (tables + the two
# existing mirror_posts indexes), seeds one target mirror with a
# 50k-row pile (49,000 pending / 500 posted / 400 failed / 100
# skipped) plus 19 filler mirrors x 10k rows so the target is ~21%
# of a ~240k-row table, then:
#   (1) EXPLAINs the list + detail count queries BEFORE the
#       migration and asserts neither uses the new index (negative
#       control — it does not exist yet);
#   (2) records the per-mirror-per-status counts (identity baseline);
#   (3) applies the forward migration, asserts the index exists
#       with the right definition, re-applies it (idempotent);
#   (4) EXPLAINs both count queries AFTER and asserts each plan uses
#       the new index (any scan shape using it — a Bitmap Index Scan
#       is the planner's legitimate choice for a mirror holding ~21%
#       of the table);
#   (5) re-records the per-mirror-per-status counts and asserts they
#       are byte-identical to the baseline (counts unchanged);
#   (6) drops the index inline (rollback proof) and asserts the
#       list count plan no longer mentions it.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/mirror-count-index-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122223000_mirror_posts_mirror_status_index.sql"
BASE="$ROOT/supabase/migrations/20261029160000_tiktok_mirrors.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$BASE" ] || { echo "BASE MIGRATION NOT FOUND: $BASE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-mirror-count-idx-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$BASE" "$STAGE/base.sql"
chown -R postgres:postgres "$STAGE"

WORKDIR=/var/lib/postgresql/16/test-mirror-count-idx-a
PORT=55442

setup_cluster() {
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR" "$WORKDIR/sock"
  chown -R postgres:postgres "$WORKDIR"
  chmod 700 "$WORKDIR"
  su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o \"-k '$WORKDIR/sock' -p $PORT -c listen_addresses=''\" -l '$WORKDIR/log' start" >/dev/null
  su postgres -c "$PG_BIN/createdb -h '$WORKDIR/sock' -p $PORT testmirroridx" >/dev/null
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
  su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testmirroridx -v ON_ERROR_STOP=1 -q -t -A"
}

# The base migration's mirrors table references workspaces; the stub
# is all it needs (no other table from the base migration is used).
SEED_SCHEMA='
create table public.workspaces (id uuid primary key);
insert into public.workspaces (id) values ('"'"'11111111-0000-0000-0000-000000000001'"'"');
'

# Target mirror T (the 50k-row pile) + small mirror B (deterministic
# handful) + 19 filler mirrors so T is ~21% of the table, not ~100%:
# a count over a mirror holding the whole table would seq-scan
# before AND after, which proves nothing about the index.
SEED_MIRRORS='
insert into public.mirrors (id, workspace_id, source_platform, source_username, target_platform, target_external_id, target_display_name) values
  ('"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'11111111-0000-0000-0000-000000000001'"'"', '"'"'tiktok'"'"', '"'"'targetcreator'"'"', '"'"'facebook'"'"', '"'"'1001'"'"', '"'"'Target Page'"'"'),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'11111111-0000-0000-0000-000000000001'"'"', '"'"'tiktok'"'"', '"'"'smallcreator'"'"', '"'"'facebook'"'"', '"'"'1002'"'"', '"'"'Small Page'"'"');
insert into public.mirrors (id, workspace_id, source_platform, source_username, target_platform, target_external_id, target_display_name)
select ('"'"'aaaaaaaa-0000-0000-0000-'"'"' || lpad(g::text, 12, '"'"'0'"'"'))::uuid, '"'"'11111111-0000-0000-0000-000000000001'"'"', '"'"'tiktok'"'"', '"'"'filler'"'"' || g, '"'"'facebook'"'"', '"'"'200'"'"' || g, '"'"'Filler Page '"'"' || g
  from generate_series(3, 21) g;
'

# T: 49,000 pending / 500 posted / 400 failed / 100 skipped.
# B: 3 posted / 2 failed / 1 skipped / 1 pending (handful).
# Fillers: 10k rows each, 70% pending / 10% posted / 10% failed /
# 10% skipped, so the table is ~240k rows.
SEED_POSTS='
insert into public.mirror_posts (mirror_id, source_post_id, status, created_at)
select '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"',
       '"'"'t-'"'"' || g,
       case when g <= 49000 then '"'"'pending'"'"'
            when g <= 49500 then '"'"'posted'"'"'
            when g <= 49900 then '"'"'failed'"'"'
            else '"'"'skipped'"'"' end,
       now() - interval '"'"'1 day'"'"' + (g || '"'"' seconds'"'"')::interval
  from generate_series(1, 50000) g;
insert into public.mirror_posts (mirror_id, source_post_id, status, created_at) values
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'b-posted-1'"'"', '"'"'posted'"'"', now()),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'b-posted-2'"'"', '"'"'posted'"'"', now()),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'b-posted-3'"'"', '"'"'posted'"'"', now()),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'b-failed-1'"'"', '"'"'failed'"'"', now()),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'b-failed-2'"'"', '"'"'failed'"'"', now()),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'b-skipped-1'"'"', '"'"'skipped'"'"', now()),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'b-pending-1'"'"', '"'"'pending'"'"', now());
insert into public.mirror_posts (mirror_id, source_post_id, status, created_at)
select ('"'"'aaaaaaaa-0000-0000-0000-'"'"' || lpad(m::text, 12, '"'"'0'"'"'))::uuid,
       '"'"'f-'"'"' || m || '"'"'-'"'"' || g,
       case when g % 10 < 7 then '"'"'pending'"'"'
            when g % 10 = 7 then '"'"'posted'"'"'
            when g % 10 = 8 then '"'"'failed'"'"'
            else '"'"'skipped'"'"' end,
       now() - interval '"'"'1 day'"'"' + (g || '"'"' seconds'"'"')::interval
  from generate_series(3, 21) m, generate_series(1, 10000) g;
analyze public.mirror_posts;
'

# The exact list-card count from fetchMirrorPostCounts (legacy SQL
# path), over mirrors T + B; and the exact detail count from
# fetchMirrorDashboardCounts (legacy SQL path) for mirror T.
# EXPLAIN (ANALYZE, BUFFERS) so the PR body can quote real
# before/after numbers.
EXPLAIN_LIST='
explain (analyze, buffers)
select mirror_id,
       count(*) filter (where status = '"'"'posted'"'"')::int as posted,
       count(*) filter (where status = '"'"'failed'"'"')::int as failed
  from mirror_posts
 where mirror_id = any(array['"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"']::uuid[])
 group by mirror_id;
'
EXPLAIN_DETAIL='
explain (analyze, buffers)
select count(*) filter (where status = '"'"'posted'"'"')::int as posted,
       count(*) filter (where status = '"'"'failed'"'"')::int as failed,
       count(*) filter (where status = '"'"'skipped'"'"')::int as skipped
  from mirror_posts
 where mirror_id = '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"';
'
IDENTITY_QUERY="select mirror_id::text || ':' || status || ':' || count(*) from public.mirror_posts group by mirror_id, status order by mirror_id, status;"

setup_cluster

PSQL <<SQL
$SEED_SCHEMA
SQL

# Live base migration first, as on production.
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testmirroridx -v ON_ERROR_STOP=1 -q -f '$STAGE/base.sql'"

PSQL <<SQL
$SEED_MIRRORS
$SEED_POSTS
SQL

# --- (1) BEFORE: neither count may use the new index ----------------------
echo "=== EXPLAIN LIST BEFORE (no new index) ==="
PSQL <<SQL > /tmp/mirror-count-idx-before-list.plan
$EXPLAIN_LIST
SQL
cat /tmp/mirror-count-idx-before-list.plan
echo "=== EXPLAIN DETAIL BEFORE (no new index) ==="
PSQL <<SQL > /tmp/mirror-count-idx-before-detail.plan
$EXPLAIN_DETAIL
SQL
cat /tmp/mirror-count-idx-before-detail.plan
for plan in /tmp/mirror-count-idx-before-list.plan /tmp/mirror-count-idx-before-detail.plan; do
  grep -q "idx_mirror_posts_mirror_status" "$plan" && {
    echo "NEGATIVE CONTROL FAILED: before-plan $plan mentions the new index, which does not exist yet"
    exit 1
  }
done
echo "before-plans do not use the new index, as expected"

# --- (2) identity baseline -------------------------------------------------
PSQL <<SQL > /tmp/mirror-count-idx-before.identity
$IDENTITY_QUERY
SQL
cat /tmp/mirror-count-idx-before.identity
grep -q "aaaaaaaa-0000-0000-0000-000000000001:posted:500" /tmp/mirror-count-idx-before.identity || {
  echo "SEED FAILED: target mirror does not have 500 posted rows"
  exit 1
}
grep -q "aaaaaaaa-0000-0000-0000-000000000001:pending:49000" /tmp/mirror-count-idx-before.identity || {
  echo "SEED FAILED: target mirror does not have 49000 pending rows"
  exit 1
}

# --- (3) apply the forward migration (twice: idempotent) -------------------
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testmirroridx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '$WORKDIR/sock' -p $PORT -d testmirroridx -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice (idempotent)"

PSQL <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'idx_mirror_posts_mirror_status';
  if v_def is null then raise exception 'index idx_mirror_posts_mirror_status missing after migration'; end if;
  if v_def not like '%(mirror_id, status)%' then raise exception 'index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_mirror_posts_mirror_status';
  if v_count <> 1 then raise exception 'index created % times (expected 1)', v_count; end if;
  raise notice 'INDEX EXISTS WITH RIGHT DEFINITION: %', v_def;
end $$;
SQL

# --- (4) AFTER: both counts must use the new index -------------------------
echo "=== EXPLAIN LIST AFTER (new index) ==="
PSQL <<SQL > /tmp/mirror-count-idx-after-list.plan
$EXPLAIN_LIST
SQL
cat /tmp/mirror-count-idx-after-list.plan
echo "=== EXPLAIN DETAIL AFTER (new index) ==="
PSQL <<SQL > /tmp/mirror-count-idx-after-detail.plan
$EXPLAIN_DETAIL
SQL
cat /tmp/mirror-count-idx-after-detail.plan
for plan in /tmp/mirror-count-idx-after-list.plan /tmp/mirror-count-idx-after-detail.plan; do
  grep -q "idx_mirror_posts_mirror_status" "$plan" || {
    echo "AFTER PLAN FAILED: $plan does not use the new index"
    exit 1
  }
done
echo "after-plans use the new index"

# --- (5) identity: same counts per mirror and status -----------------------
PSQL <<SQL > /tmp/mirror-count-idx-after.identity
$IDENTITY_QUERY
SQL
if ! cmp -s /tmp/mirror-count-idx-before.identity /tmp/mirror-count-idx-after.identity; then
  echo "IDENTITY FAILED: per-mirror-per-status counts differ before/after"
  diff /tmp/mirror-count-idx-before.identity /tmp/mirror-count-idx-after.identity || true
  exit 1
fi
echo "per-mirror-per-status counts identical before/after"

# --- (6) rollback proof: drop the index, the plan drops it too --------------
PSQL <<SQL
drop index if exists public.idx_mirror_posts_mirror_status;
SQL
PSQL <<SQL > /tmp/mirror-count-idx-rollback-list.plan
$EXPLAIN_LIST
SQL
grep -q "idx_mirror_posts_mirror_status" /tmp/mirror-count-idx-rollback-list.plan && {
  echo "ROLLBACK CHECK FAILED: dropped index still in plan"
  exit 1
}
echo "rollback check passed: dropping the index removes it from the plan"

echo "ALL MIRROR-COUNT-INDEX MIGRATION TESTS PASSED"
