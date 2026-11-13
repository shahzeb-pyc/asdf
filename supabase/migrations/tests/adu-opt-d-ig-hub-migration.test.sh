#!/usr/bin/env bash
# Live migration test for ADU optimization Stream D (F20):
# Instagram hub list/stats RPC pair.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds minimal adu_configs +
# destinations tables, applies the forward migration, asserts the RPCs
# page/search/filter/sort in the database (never in memory), never
# leak Facebook or other-workspace configs, and are executable only
# by service_role, re-applies the forward migration (idempotent),
# applies the reverse migration, asserts the functions are gone and
# the rows are untouched. Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-opt-d-ig-hub-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113130000_instagram_adu_hub.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113130000_instagram_adu_hub.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-opt-d-stage
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
  stop_cluster /var/lib/postgresql/16/test-adu-opt-d
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-d/sock' -p 55445 -d testadud -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-d/sock' -p 55445 -d testadud -tA -c '$1'"
}

setup_cluster /var/lib/postgresql/16/test-adu-opt-d 55445 testadud

# Minimal tables: only the columns the RPCs touch, with the real types.
# The Supabase roles must exist before the migration's GRANTs run.
PSQL <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  platform text not null,
  section text,
  name text,
  external_destination_id text,
  account_id uuid
);
create table public.adu_configs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  destination_id uuid,
  source_platform text not null default 'instagram',
  source_username text not null default '',
  timezone text not null default 'UTC',
  posts_per_day integer not null default 1,
  schedule_type text not null default 'dailyrandom',
  posting_times text[] not null default '{}',
  status text not null default 'active',
  sync_status text not null default 'pending',
  starting_followers integer not null default 0,
  current_followers integer not null default 0,
  followers_updated_at timestamptz,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
SQL

# 12 Instagram configs in workspace 1 (two pages of 9), one paused,
# one whose source_username carries the search term, one whose
# destination name carries it; plus one Facebook config in workspace 1
# and one Instagram config in workspace 2 — neither may ever appear.
PSQL <<'SQL'
insert into public.destinations (id, workspace_id, platform, section, name, external_destination_id) values
  ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Yoga Daily', 'ig-yoga'),
  ('a0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Fit Life', 'ig-fit'),
  ('a0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Cook With Me', 'ig-cook'),
  ('a0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Travel Bits', 'ig-travel'),
  ('a0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Tech Talks', 'ig-tech'),
  ('a0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Garden Joy', 'ig-garden'),
  ('a0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Pet Pals', 'ig-pets'),
  ('a0000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Music Room', 'ig-music'),
  ('a0000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Art Daily', 'ig-art'),
  ('a0000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Book Club', 'ig-books'),
  ('a0000000-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Film Fans', 'ig-film'),
  ('a0000000-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', 'instagram', 'adu', 'Yoga Flows', 'ig-yogaflows'),
  ('a0000000-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111', 'facebook', 'adu', 'FB Page', 'fb-page'),
  ('a0000000-0000-0000-0000-000000000014', '22222222-2222-2222-2222-222222222222', 'instagram', 'adu', 'Other WS', 'ig-other');
insert into public.adu_configs (workspace_id, destination_id, source_username, status, starting_followers, current_followers, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001', 'yoga_morning', 'active', 100, 500, '2026-11-01 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002', 'fitlife', 'active', 0, 300, '2026-11-02 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003', 'cookwithme', 'paused', 50, 200, '2026-11-03 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000004', 'travelbits', 'active', 10, 150, '2026-11-04 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000005', 'techtalks', 'active', 0, 90, '2026-11-05 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000006', 'gardenjoy', 'active', 20, 80, '2026-11-06 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000007', 'petpals', 'active', 0, 70, '2026-11-07 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000008', 'musicroom', 'active', 0, 60, '2026-11-08 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000009', 'artdaily', 'active', 0, 50, '2026-11-09 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000010', 'bookclub', 'active', 0, 40, '2026-11-10 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000011', 'filmfans', 'active', 0, 30, '2026-11-11 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000012', 'studio_yoga', 'active', 0, 20, '2026-11-12 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000013', 'fbpage', 'active', 0, 9999, '2026-11-01 10:00:00+00'),
  ('22222222-2222-2222-2222-222222222222', 'a0000000-0000-0000-0000-000000000014', 'otherws', 'active', 0, 8888, '2026-11-01 10:00:00+00');
SQL

echo "seeded: configs=$(PSQL_TA 'select count(*) from adu_configs') (expect 14)"

# --- apply the forward migration ----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-d/sock' -p 55445 -d testadud -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions ---------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_proc
  where proname in ('instagram_adu_hub_list', 'instagram_adu_hub_stats')
    and pronamespace = 'public'::regnamespace;
  if v <> 2 then raise exception 'instagram hub RPCs missing: % present', v; end if;
  -- not security definer
  select count(*) into v from pg_proc
  where proname in ('instagram_adu_hub_list', 'instagram_adu_hub_stats') and prosecdef;
  if v <> 0 then raise exception 'instagram hub RPC is SECURITY DEFINER'; end if;
  -- unprivileged callers cannot execute; the server role can
  if has_function_privilege('anon', 'public.instagram_adu_hub_list(uuid, text, text, text, integer, integer)', 'execute') then
    raise exception 'anon can execute instagram_adu_hub_list';
  end if;
  if has_function_privilege('authenticated', 'public.instagram_adu_hub_stats(uuid, text, text)', 'execute') then
    raise exception 'authenticated can execute instagram_adu_hub_stats';
  end if;
  if not has_function_privilege('service_role', 'public.instagram_adu_hub_list(uuid, text, text, text, integer, integer)', 'execute') then
    raise exception 'service_role cannot execute instagram_adu_hub_list';
  end if;
  if not has_function_privilege('service_role', 'public.instagram_adu_hub_stats(uuid, text, text)', 'execute') then
    raise exception 'service_role cannot execute instagram_adu_hub_stats';
  end if;
  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL

WS="11111111-1111-1111-1111-111111111111"

# Page 1: 9 rows, total_count 12. Page 2: the remaining 3, with no
# overlap and no Facebook / other-workspace row. Search, status
# filter, follower sorts and stats are all applied in the database.
PSQL <<'SQL'
do $$
declare
  v_page1 int; v_total bigint; v_page2 int; v_overlap int; v_leak int;
  v_search int; v_search_total bigint; v_paused int;
  v_top_most int; v_top_least int;
  v_stats text;
begin
  select count(*), max(total_count) into v_page1, v_total
  from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, null, 'Newest First', 9, 0);
  if v_page1 <> 9 then raise exception 'page 1 rows % <> 9', v_page1; end if;
  if v_total <> 12 then raise exception 'total_count % <> 12', v_total; end if;
  select count(*) into v_page2
  from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, null, 'Newest First', 9, 9);
  if v_page2 <> 3 then raise exception 'page 2 rows % <> 3', v_page2; end if;
  select count(*) into v_overlap from (
    select id from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, null, 'Newest First', 9, 0)
    intersect
    select id from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, null, 'Newest First', 9, 9)
  ) s;
  if v_overlap <> 0 then raise exception 'pages overlap on % rows', v_overlap; end if;
  select count(*) into v_leak
  from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, null, 'Newest First', 50, 0)
  where current_followers in (9999, 8888);
  if v_leak <> 0 then raise exception 'facebook/other-workspace config leaked'; end if;
  -- 'yoga' matches source_username yoga_morning and studio_yoga
  -- (whose destinations 'Yoga Daily' and 'Yoga Flows' match too).
  select count(*), max(total_count) into v_search, v_search_total
  from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', 'yoga', null, 'Newest First', 9, 0);
  if v_search <> 2 then raise exception 'search yoga rows % <> 2', v_search; end if;
  if v_search_total <> 2 then raise exception 'search yoga total % <> 2', v_search_total; end if;
  select count(*) into v_paused
  from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, 'paused', 'Newest First', 9, 0);
  if v_paused <> 1 then raise exception 'paused rows % <> 1', v_paused; end if;
  select current_followers into v_top_most
  from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, null, 'Most Followers', 1, 0);
  if v_top_most <> 500 then raise exception 'Most Followers first % <> 500', v_top_most; end if;
  select current_followers into v_top_least
  from public.instagram_adu_hub_list('11111111-1111-1111-1111-111111111111', null, null, 'Least Followers', 1, 0);
  if v_top_least <> 20 then raise exception 'Least Followers first % <> 20', v_top_least; end if;
  -- Stats: 12 rows, followers sum 1590, net gained 1410.
  select total_count || '/' || total_followers_sum || '/' || net_gained_sum into v_stats
  from public.instagram_adu_hub_stats('11111111-1111-1111-1111-111111111111', null, null);
  if v_stats <> '12/1590/1410' then raise exception 'stats % <> 12/1590/1410', v_stats; end if;
  raise notice 'LIST/SEARCH/FILTER/SORT/STATS ASSERTIONS PASSED';
end $$;
SQL
echo "paging/search/filter/sort/stats: all database-side assertions passed"

# --- idempotent re-apply --------------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-d/sock' -p 55445 -d testadud -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_proc
  where proname in ('instagram_adu_hub_list', 'instagram_adu_hub_stats');
  if v <> 2 then raise exception 'after re-apply: % hub RPCs <> 2', v; end if;
  raise notice 'IDEMPOTENT RE-APPLY PASSED';
end $$;
SQL
echo "forward migration is idempotent"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-d/sock' -p 55445 -d testadud -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- rollback assertions --------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_proc
  where proname in ('instagram_adu_hub_list', 'instagram_adu_hub_stats');
  if v <> 0 then raise exception 'after reverse: % hub RPCs remain', v; end if;
  select count(*) into v from adu_configs;
  if v <> 14 then raise exception 'after reverse: configs rows % <> 14', v; end if;
  select count(*) into v from destinations;
  if v <> 14 then raise exception 'after reverse: destinations rows % <> 14', v; end if;
  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "ALL ADU-OPT-D MIGRATION TESTS PASSED"
