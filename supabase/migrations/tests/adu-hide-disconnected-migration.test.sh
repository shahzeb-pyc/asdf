#!/usr/bin/env bash
# Live migration test for the ADU hide-disconnected fix
# (20261113150000_adu_hub_hide_disconnected.sql).
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), builds the minimal schema the
# six hub RPCs touch (destinations + adu_configs), applies the 1B
# section migration first (the forward migration redefines its
# functions) plus the Instagram pair migration (20261113130000, whose
# functions the forward also redefines), applies the forward migration,
# asserts the disconnected exclusion, applies the reverse migration,
# and asserts the old behaviour is back. Nothing touches the live
# database.
#
#   bash supabase/migrations/tests/adu-hide-disconnected-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113150000_adu_hub_hide_disconnected.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113150000_adu_hub_hide_disconnected.sql"
BASELINE="$ROOT/supabase/migrations/20261112180000_adu_hub_section_label.sql"
IG_MIGRATION="$ROOT/supabase/migrations/20261113130000_instagram_adu_hub.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
[ -f "$BASELINE" ] || { echo "BASELINE NOT FOUND: $BASELINE"; exit 1; }
[ -f "$IG_MIGRATION" ] || { echo "IG MIGRATION NOT FOUND: $IG_MIGRATION"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-hide-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/reverse.sql"
cp "$BASELINE" "$STAGE/baseline.sql"
cp "$IG_MIGRATION" "$STAGE/ig.sql"
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
  stop_cluster /var/lib/postgresql/16/test-adu-hide-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-hide-a/sock' -p 55437 -d testaduhide -v ON_ERROR_STOP=1 -q"
}

setup_cluster /var/lib/postgresql/16/test-adu-hide-a 55437 testaduhide

PSQL <<'SQL'
create table public.destinations (
  id uuid primary key, workspace_id uuid not null, account_id uuid,
  platform text not null, external_destination_id text,
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

# The 1B baseline first: the forward migration redefines its functions.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-hide-a/sock' -p 55437 -d testaduhide -v ON_ERROR_STOP=1 -q -f '$STAGE/baseline.sql'"

# The Instagram pair migration next: the forward migration redefines its
# functions too. Its revoke/grant needs the Supabase roles to exist.
PSQL <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
SQL
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-hide-a/sock' -p 55437 -d testaduhide -v ON_ERROR_STOP=1 -q -f '$STAGE/ig.sql'"

# Seed: workspace A (Facebook) holds one config per destination status —
# active, disconnected, disconnected+paused, error, rate_limited — all
# with config status 'active', so a status filter cannot hide the
# disconnected one on its own. Workspace B (Threads) holds one active
# and one disconnected config. Follower figures are distinct per row so
# the stats sums prove exactly which rows are counted.
PSQL <<'SQL'
insert into public.destinations values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-active', 'Active Page', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-disc', 'Disconnected Page', 'UTC', 'disconnected', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-paused', 'Paused Page', 'UTC', 'disconnected', '{"fb_status": "paused"}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-error', 'Error Page', 'UTC', 'error', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-rl', 'Rate Limited Page', 'UTC', 'rate_limited', '{}'::jsonb, 'adu'),
  ('a0000000-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'facebook', 'fb-sched', 'Schedule Copy', 'UTC', 'disconnected', '{}'::jsonb, 'schedule'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'threads', 'th-active', 'Active Threads', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('b0000000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'threads', 'th-disc', 'Disconnected Threads', 'UTC', 'disconnected', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-active', 'Active IG', 'UTC', 'active', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-disc', 'Disconnected IG', 'UTC', 'disconnected', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-paused', 'Paused IG', 'UTC', 'disconnected', '{"fb_status": "paused"}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-error', 'Error IG', 'UTC', 'error', '{}'::jsonb, 'adu'),
  ('c0000000-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'instagram', 'ig-rl', 'Rate Limited IG', 'UTC', 'rate_limited', '{}'::jsonb, 'adu');
insert into public.adu_configs (id, workspace_id, destination_id, source_platform, source_username, timezone, starting_followers, current_followers) values
  ('c0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000001', 'tiktok', 'active_src', 'UTC', 100, 150),
  ('c0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000002', 'tiktok', 'disc_src', 'UTC', 100, 150),
  ('c0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000003', 'tiktok', 'paused_src', 'UTC', 200, 260),
  ('c0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000004', 'tiktok', 'error_src', 'UTC', 300, 290),
  ('c0000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000005', 'tiktok', 'rl_src', 'UTC', 400, 500),
  ('c0000000-0000-0000-0000-000000000006', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000001', 'tiktok', 'th_active_src', 'UTC', 50, 80),
  ('c0000000-0000-0000-0000-000000000007', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000002', 'tiktok', 'th_disc_src', 'UTC', 50, 80),
  ('d0000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000001', 'instagram', 'ig_active_src', 'UTC', 100, 150),
  ('d0000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000002', 'instagram', 'ig_disc_src', 'UTC', 100, 150),
  ('d0000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000003', 'instagram', 'ig_paused_src', 'UTC', 200, 260),
  ('d0000000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000004', 'instagram', 'ig_error_src', 'UTC', 300, 290),
  ('d0000000-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000005', 'instagram', 'ig_rl_src', 'UTC', 400, 500);
SQL

echo "seeded"

# --- baseline sanity: before the fix, the disconnected rows ARE listed --
PSQL <<'SQL'
do $$
declare
  v int;
begin
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0);
  if v <> 5 then raise exception 'baseline: adu_hub_list returned % rows <> 5', v; end if;
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0);
  if v <> 5 then raise exception 'baseline: instagram_adu_hub_list returned % rows <> 5', v; end if;
end $$;
SQL

# --- apply the forward migration ------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-hide-a/sock' -p 55437 -d testaduhide -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions ----------------------------------------------------
PSQL <<'SQL'
do $$
declare
  v int;
  v_big bigint;
  v_name text;
begin
  -- Facebook list: 4 of 5 — disconnected is gone; paused, error and
  -- rate_limited stay (the Pages rule, exactly).
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0);
  if v <> 4 then raise exception 'adu_hub_list returned % rows <> 4', v; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0)
    where source_username = 'disc_src';
  if v <> 0 then raise exception 'disconnected config still listed'; end if;
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0)
    where source_username in ('paused_src', 'error_src', 'rl_src');
  if v <> 3 then raise exception 'paused/error/rate_limited configs missing: %', v; end if;
  -- total_count agrees with the visible rows (pagination stays exact).
  select total_count into v_big from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0) limit 1;
  if v_big <> 4 then raise exception 'adu_hub_list total_count % <> 4', v_big; end if;
  -- The config-status filter cannot resurrect the disconnected row:
  -- its config status is 'active', so p_status='active' would list it
  -- without the destination predicate.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'active', null, 50, 0);
  if v <> 4 then raise exception 'adu_hub_list(active) returned % rows <> 4', v; end if;
  -- Search by the disconnected page's name finds nothing.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Disconnected Page', null, null, 50, 0);
  if v <> 0 then raise exception 'search found the disconnected page'; end if;

  -- Facebook stats: same 4 rows — followers sum 150+260+290+500 = 1200,
  -- net gained (floored at 0) 50+60+0+100 = 210.
  select total_count into v from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null);
  if v <> 4 then raise exception 'adu_hub_stats total_count % <> 4', v; end if;
  select total_followers_sum into v_big from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null);
  if v_big <> 1200 then raise exception 'adu_hub_stats followers sum % <> 1200', v_big; end if;
  select net_gained_sum into v_big from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null);
  if v_big <> 210 then raise exception 'adu_hub_stats net gained % <> 210', v_big; end if;

  -- Threads list + stats: only the active config survives.
  select count(*) into v from public.threads_adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null, null, 50, 0);
  if v <> 1 then raise exception 'threads_adu_hub_list returned % rows <> 1', v; end if;
  select count(*) into v from public.threads_adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null, null, 50, 0)
    where source_username = 'th_disc_src';
  if v <> 0 then raise exception 'disconnected Threads config still listed'; end if;
  select total_count into v from public.threads_adu_hub_stats('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null);
  if v <> 1 then raise exception 'threads_adu_hub_stats total_count % <> 1', v; end if;
  select total_followers_sum into v_big from public.threads_adu_hub_stats('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null);
  if v_big <> 80 then raise exception 'threads_adu_hub_stats followers sum % <> 80', v_big; end if;

  -- Instagram list + stats: 4 of 5 — disconnected is gone; paused,
  -- error and rate_limited stay (the Pages rule, exactly).
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0);
  if v <> 4 then raise exception 'instagram_adu_hub_list returned % rows <> 4', v; end if;
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0)
    where source_username = 'ig_disc_src';
  if v <> 0 then raise exception 'disconnected IG config still listed'; end if;
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0)
    where source_username in ('ig_paused_src', 'ig_error_src', 'ig_rl_src');
  if v <> 3 then raise exception 'paused/error/rate_limited IG configs missing: %', v; end if;
  select total_count into v_big from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0) limit 1;
  if v_big <> 4 then raise exception 'instagram_adu_hub_list total_count % <> 4', v_big; end if;
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, 'active', null, 50, 0);
  if v <> 4 then raise exception 'instagram_adu_hub_list(active) returned % rows <> 4', v; end if;
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Disconnected IG', null, null, 50, 0);
  if v <> 0 then raise exception 'search found the disconnected IG page'; end if;
  select total_count into v from public.instagram_adu_hub_stats('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null);
  if v <> 4 then raise exception 'instagram_adu_hub_stats total_count % <> 4', v; end if;
  select total_followers_sum into v_big from public.instagram_adu_hub_stats('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null);
  if v_big <> 1200 then raise exception 'instagram_adu_hub_stats followers sum % <> 1200', v_big; end if;
  select net_gained_sum into v_big from public.instagram_adu_hub_stats('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null);
  if v_big <> 210 then raise exception 'instagram_adu_hub_stats net gained % <> 210', v_big; end if;

  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "forward migration + assertions passed"

# --- apply the reverse migration -------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-hide-a/sock' -p 55437 -d testaduhide -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- reverse assertions ------------------------------------------------------
PSQL <<'SQL'
do $$
declare
  v int;
begin
  -- Old behaviour is back: the disconnected rows are listed again.
  select count(*) into v from public.adu_hub_list('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, 50, 0);
  if v <> 5 then raise exception 'reverse: adu_hub_list returned % rows <> 5', v; end if;
  select total_count into v from public.adu_hub_stats('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null);
  if v <> 5 then raise exception 'reverse: adu_hub_stats total_count % <> 5', v; end if;
  select count(*) into v from public.threads_adu_hub_list('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null, null, 50, 0);
  if v <> 2 then raise exception 'reverse: threads_adu_hub_list returned % rows <> 2', v; end if;
  select total_count into v from public.threads_adu_hub_stats('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, null);
  if v <> 2 then raise exception 'reverse: threads_adu_hub_stats total_count % <> 2', v; end if;
  select count(*) into v from public.instagram_adu_hub_list('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null, null, 50, 0);
  if v <> 5 then raise exception 'reverse: instagram_adu_hub_list returned % rows <> 5', v; end if;
  select total_count into v from public.instagram_adu_hub_stats('cccccccc-cccc-cccc-cccc-cccccccccccc', null, null);
  if v <> 5 then raise exception 'reverse: instagram_adu_hub_stats total_count % <> 5', v; end if;

  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "reverse migration + assertions passed"
echo "adu-hide-disconnected migration test: ALL PASSED"
