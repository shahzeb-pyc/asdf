#!/usr/bin/env bash
# Live migration test for the posting-slot list indexes (spec 231):
# listing the active Facebook posting slots
# (`list_active_facebook_posting_slots`, current signature
# `list_active_facebook_posting_slots(p_section text DEFAULT NULL)`)
# filters destinations by platform ('facebook') and status ('active'),
# joins the account to require an active account, then joins the
# posting slots where the slot is active. The pre-existing indexes
# lead with workspace/account (destinations) and destination_id alone
# (posting_slots), so the routine seq-scans both tables. The new
# migration adds:
#   idx_destinations_platform_status on destinations (platform, status)
#   idx_posting_slots_destination_active on posting_slots (destination_id, is_active)
#
# The routine definition is NOT copied into this script: it is
# extracted at run time from the live repo migration that defines it
# (20261113060000_claim_rpc_section.sql, which redefined the routine
# with the social_accounts join and the p_section parameter), so the
# EXPLAINs below always run the TRUE current body, never a stale
# copy. The body EXPLAIN substitutes NULL for p_section (the
# worker-tick call shape); the identity check calls the routine
# itself.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), with two databases:
#   shape A — 50,000 destinations / 100,000 slots (2 per destination,
#     1 active), 15,000 facebook-active destinations, routine returns
#     15,000 rows. Asserts the destinations index in the full routine
#     body plan.
#   shape B — 50,000 destinations (500 facebook-active) / 500,000
#     slots (10 per destination, 1 active: the realistic production
#     shape, where deactivated slots accumulate), routine returns 500
#     rows. Asserts the slots index in the per-destination probe
#     shape of the join (the planner keeps a hash join + sequential
#     scan over the slots table for the full body at these scales, so
#     the full-body plan is NOT where the slots index shows up; the
#     probe is the access path a nested-loop join would use).
# Then, per shape:
#   (1) EXPLAINs the routine body BEFORE the migration and asserts
#       it seq-scans (negative control: no new index can appear);
#   (2) calls the routine and records its output + the routine
#       definition + grants fingerprint;
#   (3) applies the forward migration, asserts both indexes exist
#       with the right definitions, re-applies it (idempotent);
#   (4) EXPLAINs again AFTER and asserts the new index is used
#       (shape A: Bitmap Index Scan on idx_destinations_platform_status
#       with both columns in the Index Cond; shape B probe: Index
#       Scan using idx_posting_slots_destination_active with both
#       columns in the Index Cond, where BEFORE used the old
#       idx_posting_slots_destination_id with a Filter on is_active);
#   (5) calls the routine again and asserts the output, the routine
#       definition and the grants are byte-identical to before
#       (the migration is index-only);
#   (6) drops both indexes inline (rollback proof) and asserts the
#       Seq Scans / old index come back.
# Nothing touches the live database. Plan shapes + costs only: no
# wall-clock millisecond improvement is claimed.
#
#   bash supabase/migrations/tests/posting-slot-list-indexes-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261122210000_posting_slot_list_indexes.sql"
ROUTINE_SRC="$ROOT/supabase/migrations/20261113060000_claim_rpc_section.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$ROUTINE_SRC" ] || { echo "ROUTINE SOURCE NOT FOUND: $ROUTINE_SRC"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-posting-slot-list-idx-stage
CLUSTER=/var/lib/postgresql/16/test-posting-slot-list-idx
PORT=55441
DB_A=testslotlista
DB_B=testslotlistb
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$ROUTINE_SRC" "$STAGE/routine-src.sql"
chown -R postgres:postgres "$STAGE"

# --- Extract the TRUE current routine from the repo migration -----------
# The CREATE OR REPLACE block for the (p_section text DEFAULT NULL)
# signature, verbatim, plus the REVOKE that closes that migration file
# (there is no GRANT TO service_role for this routine anywhere in the
# repo migrations; the fingerprint check below pins the grants as-is).
awk '/^CREATE OR REPLACE FUNCTION public\.list_active_facebook_posting_slots\(p_section text DEFAULT NULL\)/{f=1} f{print} /^\$function\$;/{if (f) exit}' \
  "$STAGE/routine-src.sql" > "$STAGE/routine.sql"
grep -q "CREATE OR REPLACE FUNCTION public.list_active_facebook_posting_slots(p_section text DEFAULT NULL)" "$STAGE/routine.sql" || {
  echo "ROUTINE EXTRACTION FAILED: signature line not found in $ROUTINE_SRC"
  exit 1
}
grep -q "JOIN public.social_accounts sa ON sa.id = d.account_id" "$STAGE/routine.sql" || {
  echo "ROUTINE EXTRACTION FAILED: expected social_accounts join not in extracted routine (stale source?)"
  exit 1
}
grep -q "sa.status = 'active'" "$STAGE/routine.sql" || {
  echo "ROUTINE EXTRACTION FAILED: expected sa.status filter not in extracted routine (stale source?)"
  exit 1
}
grep -q "p_section IS NULL OR d.section = p_section" "$STAGE/routine.sql" || {
  echo "ROUTINE EXTRACTION FAILED: expected p_section filter not in extracted routine (stale source?)"
  exit 1
}
echo "REVOKE EXECUTE ON FUNCTION public.list_active_facebook_posting_slots(TEXT) FROM PUBLIC, anon, authenticated;" >> "$STAGE/routine.sql"

# The body SELECT of the extracted routine, with NULL substituted for
# p_section (the worker-tick call shape, p_section NULL). The
# EXPLAIN runs this text, i.e. the true current body.
awk '/^AS \$function\$/{f=1; next} /^\$function\$;/{if (f) exit} f{print}' \
  "$STAGE/routine.sql" > "$STAGE/body-raw.sql"
sed 's/p_section/NULL/g' "$STAGE/body-raw.sql" > "$STAGE/body-select.sql"
grep -q "JOIN public.social_accounts sa ON sa.id = d.account_id" "$STAGE/body-select.sql" || {
  echo "BODY EXTRACTION FAILED: social_accounts join missing from body"
  exit 1
}
grep -q "d.section = NULL" "$STAGE/body-select.sql" || {
  echo "BODY EXTRACTION FAILED: p_section substitution did not happen"
  exit 1
}
{ echo 'explain (analyze, buffers)'; cat "$STAGE/body-select.sql"; } > "$STAGE/explain-body.sql"

# Per-destination active-slot probe: the inner access path of the
# join (one destination, its active slots). Destination 1 exists in
# both seed shapes.
cat > "$STAGE/explain-probe.sql" <<'EOF'
prepare probe(uuid) as select s.id from public.posting_slots s where s.destination_id = $1 and s.is_active = true;
explain (analyze, buffers) execute probe(md5('d1')::uuid);
deallocate probe;
EOF

# Routine output + definition + grants fingerprint, one file per run
# (compared byte-for-byte before/after).
cat > "$STAGE/identity.sql" <<'EOF'
select 'rows:' || count(*) from public.list_active_facebook_posting_slots();
select destination_id::text || '|' || slot_id::text || '|' || time_of_day || '|' || timezone || '|' || coalesce(array_to_string(kind, ','), '') from public.list_active_facebook_posting_slots() order by 1;
select 'sig:' || pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_active_facebook_posting_slots';
select 'routine:' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_active_facebook_posting_slots';
select 'secdef:' || p.prosecdef::text || ':svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':pub=' || has_function_privilege('public', p.oid, 'EXECUTE')::text || ':anon=' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || ':auth=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_active_facebook_posting_slots';
EOF
chown -R postgres:postgres "$STAGE"

setup_cluster() { # $1=workdir $2=port
  local workdir="$1" port="$2"
  rm -rf "$workdir"
  mkdir -p "$workdir" "$workdir/sock"
  chown -R postgres:postgres "$workdir"
  chmod 700 "$workdir"
  su postgres -c "$PG_BIN/initdb -D '$workdir/data' -U postgres --auth=trust" >/dev/null
  su postgres -c "$PG_BIN/pg_ctl -D '$workdir/data' -o \"-k '$workdir/sock' -p $port -c listen_addresses=''\" -l '$workdir/log' start" >/dev/null
}

stop_cluster() { # $1=workdir
  local workdir="$1"
  if [ -d "$workdir/data" ]; then
    su postgres -c "$PG_BIN/pg_ctl -D '$workdir/data' -m immediate stop" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}

cleanup() {
  stop_cluster "$CLUSTER"
  rm -rf "$STAGE"
}
trap cleanup EXIT

SOCK="$CLUSTER/sock"
PSQL() { # $1=db $2... = psql args
  local db="$1"; shift
  su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $db -v ON_ERROR_STOP=1 -q $*"
}

# Minimal tables mirroring the live schema (unified schema migration
# 20261022120000): text platform/status (the live platform column is
# an enum, which behaves the same for this filter), the pre-existing
# indexes that lead with workspace/account/destination_id, and the
# section column the routine filters on when p_section is given.
# No foreign keys: index behaviour is what is under test.
SEED_SCHEMA='
create table public.social_accounts (
  id uuid primary key,
  workspace_id uuid not null,
  platform text not null,
  status varchar(20) not null default '"'"'active'"'"'
);
create table public.destinations (
  id uuid primary key,
  workspace_id uuid not null,
  account_id uuid not null,
  platform text not null,
  external_destination_id varchar(255) not null,
  name varchar(255) not null,
  timezone varchar(50) not null default '"'"'UTC'"'"',
  status varchar(30) not null default '"'"'active'"'"',
  section text
);
create index idx_destinations_account_id on public.destinations (account_id);
create index idx_destinations_workspace_id on public.destinations (workspace_id);
create table public.posting_slots (
  id uuid primary key,
  destination_id uuid not null,
  kind text[] not null default array['"'"'text'"'"','"'"'image'"'"','"'"'reel'"'"','"'"'video'"'"','"'"'story'"'"'],
  time_of_day time not null,
  is_active boolean not null default true
);
create index idx_posting_slots_destination_id on public.posting_slots (destination_id);
'

# Shape A: 50,000 destinations (15,000 facebook-active), 2 slots each
# (1 active, 1 inactive) = 100,000 slots. Routine returns 15,000 rows.
SEED_A='
insert into public.social_accounts values ('"'"'11111111-0000-0000-0000-000000000001'"'"','"'"'22222222-0000-0000-0000-000000000001'"'"','"'"'facebook'"'"','"'"'active'"'"');
insert into public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, timezone, status, section)
select md5('"'"'d'"'"' || g)::uuid, '"'"'22222222-0000-0000-0000-000000000001'"'"', '"'"'11111111-0000-0000-0000-000000000001'"'"',
 case when g <= 15000 then '"'"'facebook'"'"' when g % 3 = 0 then '"'"'instagram'"'"' when g % 3 = 1 then '"'"'facebook'"'"' else '"'"'threads'"'"' end,
 '"'"'ext-'"'"' || g, '"'"'page-'"'"' || g, '"'"'UTC'"'"',
 case when g <= 15000 then '"'"'active'"'"' when g % 3 = 1 then '"'"'disconnected'"'"' else '"'"'active'"'"' end,
 '"'"'schedule'"'"'
from generate_series(1, 50000) g;
insert into public.posting_slots (id, destination_id, time_of_day, is_active)
select md5('"'"'s'"'"' || g || '"'"'-'"'"' || k)::uuid, md5('"'"'d'"'"' || g)::uuid, ('"'"'08:00'"'"'::time + (k || '"'"' hours'"'"')::interval), (k = 1)
from generate_series(1, 50000) g, generate_series(1, 2) k;
analyze public.destinations;
analyze public.posting_slots;
analyze public.social_accounts;
'

# Shape B: 50,000 destinations (500 facebook-active), 10 slots each
# (1 active, 9 inactive) = 500,000 slots. Routine returns 500 rows.
SEED_B='
insert into public.social_accounts values ('"'"'11111111-0000-0000-0000-000000000001'"'"','"'"'22222222-0000-0000-0000-000000000001'"'"','"'"'facebook'"'"','"'"'active'"'"');
insert into public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, timezone, status, section)
select md5('"'"'d'"'"' || g)::uuid, '"'"'22222222-0000-0000-0000-000000000001'"'"', '"'"'11111111-0000-0000-0000-000000000001'"'"',
 case when g <= 500 then '"'"'facebook'"'"' when g % 3 = 0 then '"'"'instagram'"'"' when g % 3 = 1 then '"'"'facebook'"'"' else '"'"'threads'"'"' end,
 '"'"'ext-'"'"' || g, '"'"'page-'"'"' || g, '"'"'UTC'"'"',
 case when g <= 500 then '"'"'active'"'"' when g % 3 = 1 then '"'"'disconnected'"'"' else '"'"'active'"'"' end,
 '"'"'schedule'"'"'
from generate_series(1, 50000) g;
insert into public.posting_slots (id, destination_id, time_of_day, is_active)
select md5('"'"'s'"'"' || g || '"'"'-'"'"' || k)::uuid, md5('"'"'d'"'"' || g)::uuid, ('"'"'06:00'"'"'::time + (k || '"'"' hours'"'"')::interval), (k = 1)
from generate_series(1, 50000) g, generate_series(1, 10) k;
analyze public.destinations;
analyze public.posting_slots;
analyze public.social_accounts;
'

# Assert both indexes exist with the right definitions, exactly once.
# $1 = db
assert_indexes() {
  PSQL "$1" <<'SQL'
do $$
declare
  v_def text;
  v_count int;
begin
  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and indexname = 'idx_destinations_platform_status';
  if v_def is null then raise exception 'index idx_destinations_platform_status missing after migration'; end if;
  if v_def not like '%(platform, status)%' then raise exception 'destinations index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_destinations_platform_status';
  if v_count <> 1 then raise exception 'destinations index created % times (expected 1)', v_count; end if;
  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and indexname = 'idx_posting_slots_destination_active';
  if v_def is null then raise exception 'index idx_posting_slots_destination_active missing after migration'; end if;
  if v_def not like '%(destination_id, is_active)%' then raise exception 'slots index definition wrong: %', v_def; end if;
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and indexname = 'idx_posting_slots_destination_active';
  if v_count <> 1 then raise exception 'slots index created % times (expected 1)', v_count; end if;
  raise notice 'BOTH INDEXES EXIST WITH RIGHT DEFINITIONS';
end $$;
SQL
}

setup_cluster "$CLUSTER" $PORT

# Roles are cluster-global: create once (guarded, so re-runs are safe).
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d postgres -v ON_ERROR_STOP=1 -q -c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END \\\$\\\$;\""
su postgres -c "$PG_BIN/createdb -h '$SOCK' -p $PORT $DB_A" >/dev/null
su postgres -c "$PG_BIN/createdb -h '$SOCK' -p $PORT $DB_B" >/dev/null

# ============================ SHAPE A =====================================
PSQL $DB_A <<SQL
$SEED_SCHEMA
SQL
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_A -v ON_ERROR_STOP=1 -q -f '$STAGE/routine.sql'"
PSQL $DB_A <<SQL
$SEED_A
SQL

# --- (A1) BEFORE: the routine body must seq-scan both tables --------------
echo "=== SHAPE A: EXPLAIN BEFORE (no new indexes) ==="
PSQL $DB_A -f "'$STAGE/explain-body.sql'" > /tmp/slot-list-idx-a-before.plan
cat /tmp/slot-list-idx-a-before.plan
grep -q "Seq Scan on destinations d" /tmp/slot-list-idx-a-before.plan || {
  echo "NEGATIVE CONTROL FAILED (A): before-plan has no Seq Scan on destinations"
  exit 1
}
grep -q "Seq Scan on posting_slots s" /tmp/slot-list-idx-a-before.plan || {
  echo "NEGATIVE CONTROL FAILED (A): before-plan has no Seq Scan on posting_slots"
  exit 1
}
grep -q "idx_destinations_platform_status\|idx_posting_slots_destination_active" /tmp/slot-list-idx-a-before.plan && {
  echo "NEGATIVE CONTROL FAILED (A): before-plan mentions a new index, which does not exist yet"
  exit 1
}
echo "before-plan (A) seq-scans both tables, as expected"

# --- (A2) routine output + definition + grants, before --------------------
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_A -t -A -q -f '$STAGE/identity.sql'" > /tmp/slot-list-idx-a-before.out
grep -q "^rows:15000$" /tmp/slot-list-idx-a-before.out || {
  echo "BEFORE IDENTITY FAILED (A): routine did not return 15000 rows"
  exit 1
}
grep -q "^sig:p_section text$" /tmp/slot-list-idx-a-before.out || {
  echo "SIGNATURE CHECK FAILED (A): routine signature is not (p_section text DEFAULT NULL)"
  exit 1
}
echo "routine (A) returns 15000 rows, signature (p_section text DEFAULT NULL)"

# --- (A3) apply the forward migration (twice: idempotent) -----------------
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_A -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_A -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice to shape A (idempotent)"
assert_indexes $DB_A

# --- (A4) AFTER: the destinations index must be used ----------------------
echo "=== SHAPE A: EXPLAIN AFTER (new indexes) ==="
PSQL $DB_A -f "'$STAGE/explain-body.sql'" > /tmp/slot-list-idx-a-after.plan
cat /tmp/slot-list-idx-a-after.plan
grep -q "Bitmap Index Scan on idx_destinations_platform_status" /tmp/slot-list-idx-a-after.plan || {
  echo "AFTER PLAN FAILED (A): destinations index not used by the routine body"
  exit 1
}
grep -q "Index Cond: ((platform = 'facebook'::text) AND ((status)::text = 'active'::text))" /tmp/slot-list-idx-a-after.plan || {
  echo "AFTER PLAN FAILED (A): destinations index cond does not cover both columns"
  exit 1
}
echo "after-plan (A) uses idx_destinations_platform_status on both columns"

# --- (A5) routine output, definition and grants byte-identical ------------
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_A -t -A -q -f '$STAGE/identity.sql'" > /tmp/slot-list-idx-a-after.out
if ! cmp -s /tmp/slot-list-idx-a-before.out /tmp/slot-list-idx-a-after.out; then
  echo "PARITY FAILED (A): routine output/definition/grants differ before/after"
  diff /tmp/slot-list-idx-a-before.out /tmp/slot-list-idx-a-after.out | head -20
  exit 1
fi
echo "routine output, definition and grants identical before/after (A)"

# --- (A6) rollback proof: drop both indexes, Seq Scans return -------------
PSQL $DB_A <<SQL
drop index if exists public.idx_destinations_platform_status;
drop index if exists public.idx_posting_slots_destination_active;
SQL
PSQL $DB_A -f "'$STAGE/explain-body.sql'" > /tmp/slot-list-idx-a-rollback.plan
grep -q "Seq Scan on destinations d" /tmp/slot-list-idx-a-rollback.plan || {
  echo "ROLLBACK CHECK FAILED (A): after dropping the indexes the plan has no Seq Scan on destinations"
  exit 1
}
grep -q "Seq Scan on posting_slots s" /tmp/slot-list-idx-a-rollback.plan || {
  echo "ROLLBACK CHECK FAILED (A): after dropping the indexes the plan has no Seq Scan on posting_slots"
  exit 1
}
grep -q "idx_destinations_platform_status\|idx_posting_slots_destination_active" /tmp/slot-list-idx-a-rollback.plan && {
  echo "ROLLBACK CHECK FAILED (A): dropped index still in plan"
  exit 1
}
echo "rollback check passed (A): dropping the indexes brings the Seq Scans back"

# ============================ SHAPE B =====================================
PSQL $DB_B <<SQL
$SEED_SCHEMA
SQL
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_B -v ON_ERROR_STOP=1 -q -f '$STAGE/routine.sql'"
PSQL $DB_B <<SQL
$SEED_B
SQL

# --- (B1) BEFORE: body seq-scans; probe uses the OLD destination index ----
echo "=== SHAPE B: EXPLAIN BEFORE (no new indexes) ==="
PSQL $DB_B -f "'$STAGE/explain-body.sql'" > /tmp/slot-list-idx-b-before.plan
cat /tmp/slot-list-idx-b-before.plan
grep -q "Seq Scan on destinations d" /tmp/slot-list-idx-b-before.plan || {
  echo "NEGATIVE CONTROL FAILED (B): before-plan has no Seq Scan on destinations"
  exit 1
}
grep -q "Seq Scan on posting_slots s" /tmp/slot-list-idx-b-before.plan || {
  echo "NEGATIVE CONTROL FAILED (B): before-plan has no Seq Scan on posting_slots"
  exit 1
}
grep -q "idx_destinations_platform_status\|idx_posting_slots_destination_active" /tmp/slot-list-idx-b-before.plan && {
  echo "NEGATIVE CONTROL FAILED (B): before-plan mentions a new index, which does not exist yet"
  exit 1
}
PSQL $DB_B -f "'$STAGE/explain-probe.sql'" > /tmp/slot-list-idx-b-before.probe
cat /tmp/slot-list-idx-b-before.probe
grep -q "idx_posting_slots_destination_id" /tmp/slot-list-idx-b-before.probe || {
  echo "NEGATIVE CONTROL FAILED (B): before-probe does not use the old destination_id index"
  exit 1
}
grep -q "Filter: is_active" /tmp/slot-list-idx-b-before.probe || {
  echo "NEGATIVE CONTROL FAILED (B): before-probe does not filter is_active in the heap (old index cannot cover it)"
  exit 1
}
grep -q "idx_posting_slots_destination_active" /tmp/slot-list-idx-b-before.probe && {
  echo "NEGATIVE CONTROL FAILED (B): before-probe mentions the new index, which does not exist yet"
  exit 1
}
echo "before-plan (B) seq-scans; before-probe uses the old index with a heap Filter on is_active"

# --- (B2) routine output + definition + grants, before --------------------
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_B -t -A -q -f '$STAGE/identity.sql'" > /tmp/slot-list-idx-b-before.out
grep -q "^rows:500$" /tmp/slot-list-idx-b-before.out || {
  echo "BEFORE IDENTITY FAILED (B): routine did not return 500 rows"
  exit 1
}
echo "routine (B) returns 500 rows"

# --- (B3) apply the forward migration (twice: idempotent) -----------------
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_B -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_B -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
echo "forward migration applied twice to shape B (idempotent)"
assert_indexes $DB_B

# --- (B4) AFTER: probe must use the new slots index on both columns ------
echo "=== SHAPE B: EXPLAIN PROBE AFTER (new indexes) ==="
PSQL $DB_B -f "'$STAGE/explain-probe.sql'" > /tmp/slot-list-idx-b-after.probe
cat /tmp/slot-list-idx-b-after.probe
grep -q "Index Scan using idx_posting_slots_destination_active" /tmp/slot-list-idx-b-after.probe || {
  echo "AFTER PLAN FAILED (B): probe does not use the new slots index"
  exit 1
}
grep -Eq "Index Cond:.*destination_id.*is_active = true" /tmp/slot-list-idx-b-after.probe || {
  echo "AFTER PLAN FAILED (B): slots index cond does not cover both columns"
  exit 1
}
grep -q "Filter: is_active" /tmp/slot-list-idx-b-after.probe && {
  echo "AFTER PLAN FAILED (B): probe still filters is_active in the heap instead of the index"
  exit 1
}
echo "after-probe (B) uses idx_posting_slots_destination_active on both columns, no heap Filter"

# --- (B5) AFTER: body must use the destinations index too -----------------
echo "=== SHAPE B: EXPLAIN BODY AFTER (new indexes) ==="
PSQL $DB_B -f "'$STAGE/explain-body.sql'" > /tmp/slot-list-idx-b-after.plan
cat /tmp/slot-list-idx-b-after.plan
grep -q "Bitmap Index Scan on idx_destinations_platform_status" /tmp/slot-list-idx-b-after.plan || {
  echo "AFTER PLAN FAILED (B): destinations index not used by the routine body"
  exit 1
}
grep -q "Index Cond: ((platform = 'facebook'::text) AND ((status)::text = 'active'::text))" /tmp/slot-list-idx-b-after.plan || {
  echo "AFTER PLAN FAILED (B): destinations index cond does not cover both columns"
  exit 1
}
echo "after-plan (B) uses idx_destinations_platform_status on both columns"

# --- (B6) routine output, definition and grants byte-identical ------------
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d $DB_B -t -A -q -f '$STAGE/identity.sql'" > /tmp/slot-list-idx-b-after.out
if ! cmp -s /tmp/slot-list-idx-b-before.out /tmp/slot-list-idx-b-after.out; then
  echo "PARITY FAILED (B): routine output/definition/grants differ before/after"
  diff /tmp/slot-list-idx-b-before.out /tmp/slot-list-idx-b-after.out | head -20
  exit 1
fi
echo "routine output, definition and grants identical before/after (B)"

# --- (B7) rollback proof: drop both indexes, old probe path returns -------
PSQL $DB_B <<SQL
drop index if exists public.idx_destinations_platform_status;
drop index if exists public.idx_posting_slots_destination_active;
SQL
PSQL $DB_B -f "'$STAGE/explain-probe.sql'" > /tmp/slot-list-idx-b-rollback.probe
grep -q "idx_posting_slots_destination_id" /tmp/slot-list-idx-b-rollback.probe || {
  echo "ROLLBACK CHECK FAILED (B): after dropping the index the probe does not use the old index again"
  exit 1
}
grep -q "idx_posting_slots_destination_active" /tmp/slot-list-idx-b-rollback.probe && {
  echo "ROLLBACK CHECK FAILED (B): dropped index still in probe plan"
  exit 1
}
PSQL $DB_B -f "'$STAGE/explain-body.sql'" > /tmp/slot-list-idx-b-rollback.plan
grep -q "Seq Scan on destinations d" /tmp/slot-list-idx-b-rollback.plan || {
  echo "ROLLBACK CHECK FAILED (B): after dropping the indexes the body plan has no Seq Scan on destinations"
  exit 1
}
echo "rollback check passed (B): dropping the indexes brings the old probe path and Seq Scans back"

echo "ALL POSTING-SLOT-LIST-INDEXES MIGRATION TESTS PASSED"
