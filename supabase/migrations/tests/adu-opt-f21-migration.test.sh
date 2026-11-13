#!/usr/bin/env bash
# Live migration test for ADU optimization F21: collapse the three hub
# RPC pairs (facebook / threads / instagram) into one
# platform-parameterised pair (adu_hub_list / adu_hub_stats).
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), applies the #246 base
# (20261113150000) first, snapshots the old per-platform results,
# applies the forward migration, and asserts:
#   - the six old functions are dropped and the unified pair exists
#     with p_platform REQUIRED (no default) and the correct grants
#     (plain, NOT security definer; service_role only — proven by
#     has_function_privilege AND by a real denied call as
#     authenticated, 42501);
#   - PLATFORM ISOLATION, both directions: the Facebook-direction
#     leak is proven at base (old adu_hub_list returns Instagram /
#     Threads configs) and closed after (unified 'facebook' returns
#     only Facebook configs); Instagram/Threads hubs never leaked
#     and still do not;
#   - PARITY vs the old per-platform bodies: unified 'instagram'
#     and 'threads' return exactly the old rows (id sets equal both
#     ways); unified 'facebook' returns exactly the old Facebook
#     rows minus the leaked ones; stats agree the same way;
#   - hide-disconnected is preserved in the unified function
#     (disconnected hidden, paused stays, error/rate_limited stay);
#   - paging, search, sorts, stats on a 12-row workspace;
#   - idempotent re-apply; reverse restores the six #246 bodies
#     exactly (old signatures back, unified signatures gone, the
#     leak returns behaviourally, rows untouched).
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-opt-f21-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE="$ROOT/supabase/migrations/20261113150000_adu_hub_hide_disconnected.sql"
MIGRATION="$ROOT/supabase/migrations/20261113170000_adu_hub_platform.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113170000_adu_hub_platform.sql"

[ -f "$BASE" ] || { echo "BASE NOT FOUND: $BASE"; exit 1; }
[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-opt-f21-stage
mkdir -p "$STAGE"
cp "$BASE" "$STAGE/base.sql"
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
  stop_cluster /var/lib/postgresql/16/test-adu-opt-f21
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f21/sock' -p 55446 -d testaduf21 -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f21/sock' -p 55446 -d testaduf21 -tA -c '$1'"
}

setup_cluster /var/lib/postgresql/16/test-adu-opt-f21 55446 testaduf21

# Minimal tables: only the columns the RPCs touch, with the real types.
# The Supabase roles must exist before the migration's GRANTs run.
PSQL <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
-- destinations.platform is the real public.platform ENUM
-- (20261022120000), not text: the F21 predicate must work against
-- the enum — a text fixture hid the 42883 `platform = text`
-- operator failure until the rig ran the full schema.
create type public.platform as enum ('facebook', 'instagram', 'threads', 'youtube', 'x', 'tiktok');
create table public.destinations (
  id uuid primary key, workspace_id uuid not null, account_id uuid,
  platform public.platform not null, external_destination_id text,
  name text, timezone text, status text not null, metadata jsonb not null default '{}'::jsonb,
  section text
);
create table public.adu_configs (
  id uuid primary key, workspace_id uuid not null, destination_id uuid,
  source_platform text not null, source_username text not null,
  timezone text not null, posts_per_day int not null default 1,
  schedule_type text not null default 'dailyrandom', posting_times text[],
  status text not null default 'active', sync_status text not null default 'synced',
  starting_followers int not null default 0, current_followers int not null default 0,
  followers_updated_at timestamptz, display_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
SQL

# The #246 base first: the forward migration redefines its functions.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f21/sock' -p 55446 -d testaduf21 -v ON_ERROR_STOP=1 -q -f '$STAGE/base.sql'"

# Seed — the hide-test fixture, plus the leak fixtures and a 12-row
# paging workspace:
# - Workspace A (facebook): one config per destination status —
#   active, disconnected, disconnected+paused, error, rate_limited —
#   plus an Instagram config and a Threads config on adu-section
#   destinations (the FB-direction leak), plus a config on a
#   schedule-section destination (never in any hub).
# - Workspace B (threads): one active, one disconnected, plus a
#   Facebook config (never leaks into the Threads hub).
# - Workspace C (instagram): active, disconnected, paused, error,
#   rate_limited, plus a Facebook config (never leaks into the IG hub).
# - Workspace D (facebook): 12 configs for paging/search/sorts.
# Follower figures are distinct per row so the stats sums prove
# exactly which rows are counted.
PSQL <<'SQL'
insert into public.destinations values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-active', 'Active Page', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-disc', 'Disconnected Page', 'UTC', 'disconnected', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-paused', 'Paused Page', 'UTC', 'disconnected', '{"fb_status": "paused"}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-error', 'Error Page', 'UTC', 'error', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-rl', 'Rate Limited Page', 'UTC', 'rate_limited', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-sched', 'Schedule Copy', 'UTC', 'disconnected', '{}'::jsonb, 'schedule'),
  ('a0000000-0000-0000-0000-000000000007', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'instagram', 'ig-leak', 'IG Leak', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'threads', 'th-leak', 'Threads Leak', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'threads', 'th-active', 'Active Threads', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('b0000000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'threads', 'th-disc', 'Disconnected Threads', 'UTC', 'disconnected', '{}'::jsonb, 'adu'),
  ('b0000000-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'facebook', 'fb-leak-b', 'FB Leak B', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-active', 'Active IG', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-disc', 'Disconnected IG', 'UTC', 'disconnected', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-paused', 'Paused IG', 'UTC', 'disconnected', '{"fb_status": "paused"}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-error', 'Error IG', 'UTC', 'error', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-rl', 'Rate Limited IG', 'UTC', 'rate_limited', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000006', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'facebook', 'fb-leak-c', 'FB Leak C', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d1', 'D Page 1', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d2', 'D Page 2', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000003', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d3', 'D Page 3', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000004', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d4', 'D Page 4', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000005', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d5', 'D Page 5', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000006', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d6', 'D Page 6', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000007', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d7', 'D Page 7', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000008', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d8', 'D Page 8', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000009', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d9', 'D Page 9', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000010', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d10', 'D Page 10', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000011', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d11', 'D Page 11', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('d0000000-0000-0000-0000-000000000012', 'dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'facebook', 'fb-d12', 'D Page 12', 'UTC', 'active', '{}'::jsonb, 'adu');
insert into public.adu_configs (id, workspace_id, destination_id, source_platform, source_username, timezone, starting_followers, current_followers, created_at) values
  ('c0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000001', 'tiktok', 'active_src', 'UTC', 100, 150, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000002', 'tiktok', 'disc_src', 'UTC', 100, 150, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000003', 'tiktok', 'paused_src', 'UTC', 200, 260, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000004', 'tiktok', 'error_src', 'UTC', 300, 290, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000005', 'tiktok', 'rl_src', 'UTC', 400, 500, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000006', 'tiktok', 'sched_src', 'UTC', 0, 5555, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000007', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000007', 'instagram', 'ig_leak_src', 'UTC', 100, 9999, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000008', 'tiktok', 'th_leak_src', 'UTC', 0, 8888, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000009', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000001', 'tiktok', 'th_active_src', 'UTC', 50, 80, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000010', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000002', 'tiktok', 'th_disc_src', 'UTC', 50, 80, '2026-11-01 10:00:00+00'),
  ('c0000000-0000-0000-0000-000000000011', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000003', 'facebook', 'fb_leak_b_src', 'UTC', 0, 6666, '2026-11-01 10:00:00+00'),
  ('d0000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000001', 'instagram', 'ig_active_src', 'UTC', 100, 150, '2026-11-01 10:00:00+00'),
  ('d0000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000002', 'instagram', 'ig_disc_src', 'UTC', 100, 150, '2026-11-01 10:00:00+00'),
  ('d0000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000003', 'instagram', 'ig_paused_src', 'UTC', 200, 260, '2026-11-01 10:00:00+00'),
  ('d0000000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000004', 'instagram', 'ig_error_src', 'UTC', 300, 290, '2026-11-01 10:00:00+00'),
  ('d0000000-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000005', 'instagram', 'ig_rl_src', 'UTC', 400, 500, '2026-11-01 10:00:00+00'),
  ('d0000000-0000-0000-0000-000000000006', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000006', 'facebook', 'fb_leak_c_src', 'UTC', 0, 7777, '2026-11-01 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000001', 'tiktok', 'yoga_morning', 'UTC', 0, 10, '2026-11-01 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000002', 'tiktok', 'd_src_2', 'UTC', 0, 20, '2026-11-02 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000003', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000003', 'tiktok', 'd_src_3', 'UTC', 0, 30, '2026-11-03 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000004', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000004', 'tiktok', 'd_src_4', 'UTC', 0, 40, '2026-11-04 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000005', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000005', 'tiktok', 'd_src_5', 'UTC', 0, 50, '2026-11-05 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000006', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000006', 'tiktok', 'd_src_6', 'UTC', 0, 60, '2026-11-06 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000007', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000007', 'tiktok', 'd_src_7', 'UTC', 0, 70, '2026-11-07 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000008', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000008', 'tiktok', 'd_src_8', 'UTC', 0, 80, '2026-11-08 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000009', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000009', 'tiktok', 'd_src_9', 'UTC', 0, 90, '2026-11-09 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000010', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000010', 'tiktok', 'd_src_10', 'UTC', 0, 100, '2026-11-10 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000011', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000011', 'tiktok', 'd_src_11', 'UTC', 0, 110, '2026-11-11 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000012', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000012', 'tiktok', 'studio_yoga', 'UTC', 0, 120, '2026-11-12 10:00:00+00');
SQL

echo "seeded: configs=$(PSQL_TA 'select count(*) from adu_configs') (expect 29)"

# --- baseline: prove the leak exists at the #246 base ----------------------
# Old adu_hub_list(A) returns 6 rows: 4 visible Facebook configs PLUS
# the Instagram and Threads configs on adu-section destinations.
# The Instagram/Threads hubs do not leak the other way.
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0);
  if v <> 6 then raise exception 'baseline: adu_hub_list(A) returned % rows <> 6 (leak not present?)', v; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0)
    where source_username in ('ig_leak_src', 'th_leak_src');
  if v <> 2 then raise exception 'baseline: leaked rows % <> 2', v; end if;
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0);
  if v <> 4 then raise exception 'baseline: instagram_adu_hub_list(C) returned % rows <> 4', v; end if;
  select count(*) into v from public.threads_adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null, null, 50, 0);
  if v <> 1 then raise exception 'baseline: threads_adu_hub_list(B) returned % rows <> 1', v; end if;
  raise notice 'BASELINE LEAK PROVEN';
end $$;
SQL

# Snapshot the old per-platform results for the parity comparison.
PSQL <<'SQL'
create table snap_fb_a as select * from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0);
create table snap_ig_c as select * from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0);
create table snap_th_b as select * from public.threads_adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null, null, 50, 0);
create table snap_fb_stats_a as select * from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null);
create table snap_ig_stats_c as select * from public.instagram_adu_hub_stats('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null);
create table snap_th_stats_b as select * from public.threads_adu_hub_stats('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null);
SQL

# --- apply the forward migration ------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f21/sock' -p 55446 -d testaduf21 -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions: shape + grants -----------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  -- The six old functions are gone; the unified pair exists with the
  -- new signatures (list takes 7 args, stats 4 — p_platform second).
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('threads_adu_hub_list', 'threads_adu_hub_stats',
       'instagram_adu_hub_list', 'instagram_adu_hub_stats');
  if v <> 0 then raise exception 'old threads/instagram hub RPCs remain: %', v; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'adu_hub_list'
      and pg_get_function_arguments(p.oid) like 'p_workspace_id uuid, p_platform text%';
  if v <> 1 then raise exception 'unified adu_hub_list with p_platform missing'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'adu_hub_list'
      and pg_get_function_arguments(p.oid) not like '%p_platform%';
  if v <> 0 then raise exception 'old 6-arg adu_hub_list overload remains'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'adu_hub_stats'
      and pg_get_function_arguments(p.oid) like 'p_workspace_id uuid, p_platform text%';
  if v <> 1 then raise exception 'unified adu_hub_stats with p_platform missing'; end if;
  -- p_platform is REQUIRED: no default on the second argument
  -- (the trailing args carry defaults; only p_platform must not).
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'adu_hub_list'
      and pg_get_function_arguments(p.oid) like '%p_platform text DEFAULT%';
  if v <> 0 then raise exception 'p_platform has a default (must be required)'; end if;
  -- Plain (NOT security definer), grant closure on the unified pair.
  select count(*) into v from pg_proc
    where proname in ('adu_hub_list', 'adu_hub_stats') and prosecdef;
  if v <> 0 then raise exception 'unified hub RPC is SECURITY DEFINER'; end if;
  if has_function_privilege('anon', 'public.adu_hub_list(uuid, text, text, text, text, integer, integer)', 'execute') then
    raise exception 'anon can execute adu_hub_list';
  end if;
  if has_function_privilege('authenticated', 'public.adu_hub_stats(uuid, text, text, text)', 'execute') then
    raise exception 'authenticated can execute adu_hub_stats';
  end if;
  if not has_function_privilege('service_role', 'public.adu_hub_list(uuid, text, text, text, text, integer, integer)', 'execute') then
    raise exception 'service_role cannot execute adu_hub_list';
  end if;
  if not has_function_privilege('service_role', 'public.adu_hub_stats(uuid, text, text, text)', 'execute') then
    raise exception 'service_role cannot execute adu_hub_stats';
  end if;
  raise notice 'FORWARD SHAPE + GRANTS ASSERTIONS PASSED';
end $$;
SQL

# A real denied call as authenticated (not just the privilege view).
DENIED_OUT="$(su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f21/sock' -p 55446 -d testaduf21 -tA -c \"set role authenticated; select * from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 9, 0);\"" 2>&1 || true)"
if ! echo "$DENIED_OUT" | grep -qi "permission denied"; then
  echo "GRANT CHECK FAILED: authenticated call was not denied with permission denied: $DENIED_OUT"
  exit 1
fi
if echo "$DENIED_OUT" | grep -q "active_src"; then
  echo "GRANT CHECK FAILED: authenticated executed adu_hub_list"
  exit 1
fi
echo "grant check: authenticated call denied (permission denied)"

# --- forward assertions: isolation + parity + hide ------------------------
PSQL <<'SQL'
do $$
declare
  v int; v_big bigint; v_stats text;
  v_fb_missing int; v_fb_extra int; v_ig_missing int; v_ig_extra int;
  v_th_missing int; v_th_extra int;
begin
  -- PLATFORM ISOLATION, Facebook direction: the leak is closed.
  -- Unified 'facebook' on A returns exactly the 4 visible Facebook
  -- configs; the leaked Instagram/Threads rows are gone.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 50, 0);
  if v <> 4 then raise exception 'unified facebook(A) returned % rows <> 4', v; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 50, 0)
    where source_username in ('ig_leak_src', 'th_leak_src', 'disc_src', 'sched_src');
  if v <> 0 then raise exception 'unified facebook(A) still leaks or shows a hidden row'; end if;
  select total_count into v_big from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 50, 0) limit 1;
  if v_big <> 4 then raise exception 'unified facebook(A) total_count % <> 4', v_big; end if;
  -- The leaked rows are reachable through their own platform only.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'instagram', null, null, null, 50, 0);
  if v <> 1 then raise exception 'unified instagram(A) returned % rows <> 1', v; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'threads', null, null, null, 50, 0);
  if v <> 1 then raise exception 'unified threads(A) returned % rows <> 1', v; end if;
  -- Instagram/Threads hubs: the Facebook configs on the same
  -- workspace never appear, and vice versa.
  select count(*) into v from public.adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', 'instagram', null, null, null, 50, 0);
  if v <> 4 then raise exception 'unified instagram(C) returned % rows <> 4', v; end if;
  select count(*) into v from public.adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', 'facebook', null, null, null, 50, 0);
  if v <> 1 then raise exception 'unified facebook(C) returned % rows <> 1', v; end if;
  select count(*) into v from public.adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'threads', null, null, null, 50, 0);
  if v <> 1 then raise exception 'unified threads(B) returned % rows <> 1', v; end if;
  select count(*) into v from public.adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'facebook', null, null, null, 50, 0);
  if v <> 1 then raise exception 'unified facebook(B) returned % rows <> 1', v; end if;
  -- Unknown platform and unknown workspace return zero rows.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bogus', null, null, null, 50, 0);
  if v <> 0 then raise exception 'unknown platform returned % rows <> 0', v; end if;
  select count(*) into v from public.adu_hub_list('99999999-9999-4999-8999-999999999999', 'facebook', null, null, null, 50, 0);
  if v <> 0 then raise exception 'unknown workspace returned % rows <> 0', v; end if;

  -- PARITY vs the old per-platform bodies (id sets, both directions).
  -- Facebook: unified rows == old rows on Facebook destinations.
  select count(*) into v_fb_missing from (
    select s.id from snap_fb_a s
    join public.destinations d on d.id = s.destination_id
    where d.platform = 'facebook'
    except select id from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 50, 0)
  ) m;
  select count(*) into v_fb_extra from (
    select id from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 50, 0)
    except select s.id from snap_fb_a s
    join public.destinations d on d.id = s.destination_id
    where d.platform = 'facebook'
  ) e;
  if v_fb_missing <> 0 or v_fb_extra <> 0 then
    raise exception 'facebook parity failed: missing % extra %', v_fb_missing, v_fb_extra;
  end if;
  -- Instagram: unified rows == old rows exactly.
  select count(*) into v_ig_missing from (
    select id from snap_ig_c except select id from public.adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', 'instagram', null, null, null, 50, 0)
  ) m;
  select count(*) into v_ig_extra from (
    select id from public.adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', 'instagram', null, null, null, 50, 0) except select id from snap_ig_c
  ) e;
  if v_ig_missing <> 0 or v_ig_extra <> 0 then
    raise exception 'instagram parity failed: missing % extra %', v_ig_missing, v_ig_extra;
  end if;
  -- Threads: unified rows == old rows exactly.
  select count(*) into v_th_missing from (
    select id from snap_th_b except select id from public.adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'threads', null, null, null, 50, 0)
  ) m;
  select count(*) into v_th_extra from (
    select id from public.adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'threads', null, null, null, 50, 0) except select id from snap_th_b
  ) e;
  if v_th_missing <> 0 or v_th_extra <> 0 then
    raise exception 'threads parity failed: missing % extra %', v_th_missing, v_th_extra;
  end if;
  -- Stats parity: IG/Threads stats equal the old stats exactly;
  -- Facebook stats equal the visible Facebook rows only
  -- (followers 150+260+290+500 = 1200, net gained 50+60+0+100 = 210).
  select total_count || '/' || total_followers_sum || '/' || net_gained_sum into v_stats
  from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null);
  if v_stats <> '4/1200/210' then raise exception 'facebook stats % <> 4/1200/210', v_stats; end if;
  select total_count || '/' || total_followers_sum || '/' || net_gained_sum into v_stats
  from public.adu_hub_stats('cccccccc-cccc-cccc-cccc-cccccccccccc', 'instagram', null, null);
  if v_stats <> (select total_count || '/' || total_followers_sum || '/' || net_gained_sum from snap_ig_stats_c) then
    raise exception 'instagram stats changed vs old body: %', v_stats;
  end if;
  select total_count || '/' || total_followers_sum || '/' || net_gained_sum into v_stats
  from public.adu_hub_stats('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'threads', null, null);
  if v_stats <> (select total_count || '/' || total_followers_sum || '/' || net_gained_sum from snap_th_stats_b) then
    raise exception 'threads stats changed vs old body: %', v_stats;
  end if;
  select total_count || '/' || total_followers_sum || '/' || net_gained_sum into v_stats
  from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'instagram', null, null);
  if v_stats <> '1/9999/9899' then raise exception 'instagram(A) stats % <> 1/9999/9899', v_stats; end if;
  select total_count || '/' || total_followers_sum || '/' || net_gained_sum into v_stats
  from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bogus', null, null);
  if v_stats <> '0/0/0' then raise exception 'bogus-platform stats % <> 0/0/0', v_stats; end if;

  -- HIDE-DISCONNECTED preserved: paused/error/rate_limited stay,
  -- disconnected stays hidden, and the config-status filter and
  -- search cannot resurrect it.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 50, 0)
    where source_username in ('paused_src', 'error_src', 'rl_src');
  if v <> 3 then raise exception 'paused/error/rate_limited configs missing: %', v; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, 'active', null, 50, 0);
  if v <> 4 then raise exception 'facebook(active) returned % rows <> 4', v; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', 'Disconnected Page', null, null, 50, 0);
  if v <> 0 then raise exception 'search found the disconnected page'; end if;
  raise notice 'ISOLATION + PARITY + HIDE ASSERTIONS PASSED';
end $$;
SQL
echo "isolation/parity/hide: all database-side assertions passed"

# --- paging / search / sorts on the 12-row workspace -----------------------
PSQL <<'SQL'
do $$
declare
  v_page1 int; v_total bigint; v_page2 int; v_overlap int;
  v_search int; v_search_total bigint;
  v_top_most int; v_top_least int; v_stats text;
begin
  select count(*), max(total_count) into v_page1, v_total
  from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null, 'Newest First', 9, 0);
  if v_page1 <> 9 then raise exception 'page 1 rows % <> 9', v_page1; end if;
  if v_total <> 12 then raise exception 'total_count % <> 12', v_total; end if;
  select count(*) into v_page2
  from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null, 'Newest First', 9, 9);
  if v_page2 <> 3 then raise exception 'page 2 rows % <> 3', v_page2; end if;
  select count(*) into v_overlap from (
    select id from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null, 'Newest First', 9, 0)
    intersect
    select id from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null, 'Newest First', 9, 9)
  ) s;
  if v_overlap <> 0 then raise exception 'pages overlap on % rows', v_overlap; end if;
  -- 'yoga' matches yoga_morning and studio_yoga.
  select count(*), max(total_count) into v_search, v_search_total
  from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', 'yoga', null, 'Newest First', 9, 0);
  if v_search <> 2 then raise exception 'search yoga rows % <> 2', v_search; end if;
  if v_search_total <> 2 then raise exception 'search yoga total % <> 2', v_search_total; end if;
  select current_followers into v_top_most
  from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null, 'Most Followers', 1, 0);
  if v_top_most <> 120 then raise exception 'Most Followers first % <> 120', v_top_most; end if;
  select current_followers into v_top_least
  from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null, 'Least Followers', 1, 0);
  if v_top_least <> 10 then raise exception 'Least Followers first % <> 10', v_top_least; end if;
  -- Stats: 12 rows, followers sum 10+20+...+120 = 780, net gained 780.
  select total_count || '/' || total_followers_sum || '/' || net_gained_sum into v_stats
  from public.adu_hub_stats('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null);
  if v_stats <> '12/780/780' then raise exception 'stats % <> 12/780/780', v_stats; end if;
  -- followers_updated_at is in the unified return shape (FB superset).
  select count(*) into v_page1
  from public.adu_hub_list('dddddddd-dddd-dddd-dddd-dddddddddddd', 'facebook', null, null, 'Newest First', 1, 0)
  where followers_updated_at is null;
  if v_page1 <> 1 then raise exception 'followers_updated_at column missing from unified rows'; end if;
  raise notice 'PAGING/SEARCH/SORT/STATS ASSERTIONS PASSED';
end $$;
SQL
echo "paging/search/sort/stats: all database-side assertions passed"

# --- idempotent re-apply --------------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f21/sock' -p 55446 -d testaduf21 -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('adu_hub_list', 'adu_hub_stats');
  if v <> 2 then raise exception 'after re-apply: % hub RPCs <> 2', v; end if;
  if has_function_privilege('authenticated', 'public.adu_hub_list(uuid, text, text, text, text, integer, integer)', 'execute') then
    raise exception 'after re-apply: authenticated can execute adu_hub_list';
  end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facebook', null, null, null, 50, 0);
  if v <> 4 then raise exception 'after re-apply: facebook(A) returned % rows <> 4', v; end if;
  raise notice 'IDEMPOTENT RE-APPLY PASSED';
end $$;
SQL
echo "forward migration is idempotent"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f21/sock' -p 55446 -d testaduf21 -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- rollback assertions --------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  -- The unified pair is gone; the six #246 bodies are back with their
  -- old signatures (list 6 args, stats 3 args).
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'adu_hub_list'
      and pg_get_function_arguments(p.oid) like '%p_platform%';
  if v <> 0 then raise exception 'after reverse: unified adu_hub_list remains'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('adu_hub_list', 'adu_hub_stats',
       'threads_adu_hub_list', 'threads_adu_hub_stats',
       'instagram_adu_hub_list', 'instagram_adu_hub_stats');
  if v <> 6 then raise exception 'after reverse: % hub RPCs <> 6', v; end if;
  -- Grant closure is re-applied on all six restored functions.
  if has_function_privilege('authenticated', 'public.threads_adu_hub_list(uuid, text, text, text, integer, integer)', 'execute') then
    raise exception 'after reverse: authenticated can execute threads_adu_hub_list';
  end if;
  if not has_function_privilege('service_role', 'public.instagram_adu_hub_stats(uuid, text, text)', 'execute') then
    raise exception 'after reverse: service_role cannot execute instagram_adu_hub_stats';
  end if;
  -- Behaviourally exact: the leak is back (old FB list returns the
  -- Instagram/Threads rows again) and the hide predicate still holds.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0);
  if v <> 6 then raise exception 'after reverse: adu_hub_list(A) returned % rows <> 6', v; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0)
    where source_username = 'disc_src';
  if v <> 0 then raise exception 'after reverse: disconnected config listed again'; end if;
  select count(*) into v from adu_configs;
  if v <> 29 then raise exception 'after reverse: configs rows % <> 29', v; end if;
  select count(*) into v from destinations;
  if v <> 29 then raise exception 'after reverse: destinations rows % <> 29', v; end if;
  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "ALL ADU-OPT-F21 MIGRATION TESTS PASSED"
