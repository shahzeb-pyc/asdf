#!/usr/bin/env bash
# Live migration test for ADU optimization Stream F1 (grouped counts):
# `adu_config_counts` RPC.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds minimal adu_configs /
# adu_reels / adu_posting_jobs tables, applies the forward migration,
# and asserts:
#   - the function exists, is SECURITY DEFINER, and is executable by
#     service_role ONLY (authenticated/anon cannot execute it — proven
#     by has_function_privilege AND by a real denied call as
#     authenticated);
#   - the grouped counts are PARITY-EXACT with the old per-config
#     count queries on the same fixture data (computed independently
#     in the test, not by re-reading the function);
#   - edge cases: zero-post config returns a zeros row; terminally
#     failed reel is NOT double-subtracted; crash-window failed job
#     IS subtracted; today-boundary jobs in America/New_York vs UTC
#     vs an invalid timezone (UTC fallback);
#   - another workspace's config ids return no rows;
#   - the 50-id cap binds (51 ids in -> 50 rows out);
#   - idempotent re-apply; reverse drops the function, rows untouched.
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-opt-f1-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113140000_adu_hub_counts.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113140000_adu_hub_counts.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-adu-opt-f1-stage
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
  stop_cluster /var/lib/postgresql/16/test-adu-opt-f1
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f1/sock' -p 55445 -d testaduf1 -v ON_ERROR_STOP=1 -q"
}
PSQL_TA() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f1/sock' -p 55445 -d testaduf1 -tA -c '$1'"
}

setup_cluster /var/lib/postgresql/16/test-adu-opt-f1 55445 testaduf1

# Roles the migration's grants name (absent in a fresh cluster).
PSQL <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
SQL

# Minimal tables: only the columns the RPC and the fixtures touch,
# with the real types and the real 'failed' reel status
# (20261108180000_adu_statuses).
PSQL <<'SQL'
create table public.adu_configs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  destination_id uuid,
  source_platform text not null default 'facebook',
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
create table public.adu_reels (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.adu_configs(id) on delete cascade,
  source_reel_id text not null,
  caption text,
  media_url text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'downloaded', 'download_failed', 'posted', 'skipped', 'failed')),
  downloaded_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.adu_posting_jobs (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.adu_configs(id) on delete cascade,
  reel_id uuid not null references public.adu_reels(id) on delete cascade,
  schedule_slot_at timestamptz,
  status text not null default 'pending_publish'
    check (status in ('pending_publish', 'publishing', 'published', 'failed_to_publish', 'publish_error', 'integrity_error')),
  published_at timestamptz,
  created_at timestamptz not null default now()
);
SQL

# Fixtures. "Today" is the TS semantics (startOfDayInTimezone): the
# config's LOCAL calendar date, at 00:00:00Z — NOT true local midnight.
# Boundary jobs are placed relative to each config's own midnight so
# the expectations hold whatever time of day the test runs:
#   ny_midnight  = date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'
#   utc_midnight = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
#   A (America/New_York): reels pending/processing/downloaded/failed/posted;
#     published +1h (today) and -1h (yesterday) off NY midnight;
#     failed job on the FAILED reel +1h (terminally failed: must NOT
#     subtract); failed jobs on the PROCESSING reel +2h (today, crash
#     window) and -1h (yesterday, crash window).
#   B (UTC): 1 pending reel; published jobs +1h (today) and -1h
#     (yesterday) off UTC midnight.
#   C (UTC): no reels, no jobs -> zeros row.
#   D (invalid timezone 'Not/AZone'): 1 published job +1h off UTC
#     midnight -> UTC fallback midnight, so published_today = 1.
#   E (other workspace): 1 published job -> never returned for ws1.
PSQL <<'SQL'
insert into public.adu_configs (id, workspace_id, timezone, posts_per_day) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'America/New_York', 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'UTC', 2),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'UTC', 2),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'Not/AZone', 2),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', 'UTC', 2);
insert into public.adu_reels (id, config_id, source_reel_id, status) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'r-a1', 'pending'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'r-a2', 'processing'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'r-a3', 'downloaded'),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'r-a4', 'failed'),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'r-a5', 'posted'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'r-b1', 'pending'),
  ('e0000000-0000-0000-0000-000000000001', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'r-e1', 'posted');
insert into public.adu_posting_jobs (config_id, reel_id, status, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000005', 'published',
    (select date_trunc('day', now() at time zone 'America/New_York') at time zone 'UTC' + interval '1 hour')),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000005', 'published',
    (select date_trunc('day', now() at time zone 'America/New_York') at time zone 'UTC' - interval '1 hour')),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000004', 'failed_to_publish',
    (select date_trunc('day', now() at time zone 'America/New_York') at time zone 'UTC' + interval '1 hour')),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000002', 'failed_to_publish',
    (select date_trunc('day', now() at time zone 'America/New_York') at time zone 'UTC' + interval '2 hours')),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000002', 'failed_to_publish',
    (select date_trunc('day', now() at time zone 'America/New_York') at time zone 'UTC' - interval '1 hour')),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000001', 'published',
    (select date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '1 hour')),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000001', 'published',
    (select date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '1 hour')),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'a0000000-0000-0000-0000-000000000005', 'published',
    (select date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '1 hour')),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'e0000000-0000-0000-0000-000000000001', 'published',
    (select date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '1 hour'));
SQL
# Note: D's job points at A's posted reel as its reel_id only because
# the jobs table requires a reel; the count queries filter by
# config_id, so the reel's owner is irrelevant to D's counts.
# (D has no reels of its own, so in_pipeline = 0 either way.)

# 51 extra ws1 configs for the 50-id cap check.
PSQL <<'SQL'
insert into public.adu_configs (workspace_id, timezone)
select '11111111-1111-1111-1111-111111111111', 'UTC'
from generate_series(1, 51);
SQL

echo "seeded: configs=$(PSQL_TA 'select count(*) from adu_configs') (expect 56)"

# --- apply the forward migration ----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f1/sock' -p 55445 -d testaduf1 -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions: shape + grants ---------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'adu_config_counts';
  if v <> 1 then raise exception 'adu_config_counts missing'; end if;
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'adu_config_counts' and p.prosecdef;
  if v <> 1 then raise exception 'adu_config_counts is not SECURITY DEFINER'; end if;
  if has_function_privilege('authenticated', 'public.adu_config_counts(uuid, uuid[])', 'execute') then
    raise exception 'authenticated can execute adu_config_counts';
  end if;
  if has_function_privilege('anon', 'public.adu_config_counts(uuid, uuid[])', 'execute') then
    raise exception 'anon can execute adu_config_counts';
  end if;
  if not has_function_privilege('service_role', 'public.adu_config_counts(uuid, uuid[])', 'execute') then
    raise exception 'service_role cannot execute adu_config_counts';
  end if;
  raise notice 'FORWARD SHAPE + GRANTS ASSERTIONS PASSED';
end $$;
SQL

# A real denied call as authenticated (not just the privilege view).
if su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f1/sock' -p 55445 -d testaduf1 -tA -c \"set role authenticated; select * from public.adu_config_counts('11111111-1111-1111-1111-111111111111', array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);\"" 2>/dev/null | grep -q "aaaaaaaa"; then
  echo "GRANT CHECK FAILED: authenticated executed adu_config_counts"
  exit 1
fi
echo "grant check: authenticated call denied"

# --- parity assertions: RPC vs independent per-config counts ------------
# Expected values, hand-computed from the fixtures (see the seed block):
#   A: pipeline 3 (pending/processing/downloaded), published 1,
#      failed 2, failed_in_pipeline 1 (crash-window job on processing
#      reel only), published_today 1 (06:00Z = NY today),
#      failed_today 1 (only the 06:00Z failed job; the 02:00Z one is NY
#      yesterday).
#   B: pipeline 1, published 1, failed 0, failed_in_pipeline 0,
#      published_today 1 (02:00Z = UTC today), failed_today 0.
#   C: all zeros, but the row EXISTS.
#   D: pipeline 0, published 1, failed 0, failed_in_pipeline 0,
#      published_today 1 (invalid timezone -> UTC fallback midnight),
#      failed_today 0.
PSQL <<'SQL'
do $$
declare
  bad int;
begin
  -- Independent per-config counts (the old queries, written out here)
  -- vs the RPC rows on the same fixtures. Any difference fails.
  select count(*) into bad
  from public.adu_configs c
  join lateral (
    select * from public.adu_config_counts(
      '11111111-1111-1111-1111-111111111111', array[c.id])
  ) rpc on true
  cross join lateral (
    select case
      when exists (select 1 from pg_timezone_names where name = c.timezone)
        then date_trunc('day', now() at time zone c.timezone) at time zone 'UTC'
      else date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    end as midnight
  ) m
  where c.id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                 'cccccccc-cccc-cccc-cccc-cccccccccccc',
                 'dddddddd-dddd-dddd-dddd-dddddddddddd')
    and (
      rpc.in_pipeline <> (select count(*) from adu_reels
        where config_id = c.id and status in ('pending','processing','downloaded'))
      or rpc.published <> (select count(*) from adu_posting_jobs
        where config_id = c.id and status = 'published')
      or rpc.failed <> (select count(*) from adu_posting_jobs
        where config_id = c.id
          and status in ('failed_to_publish','publish_error','integrity_error'))
      or rpc.failed_in_pipeline <> (select count(*) from adu_posting_jobs j
        join adu_reels ar on ar.id = j.reel_id
        where j.config_id = c.id
          and j.status in ('failed_to_publish','publish_error','integrity_error')
          and ar.status in ('pending','processing','downloaded'))
      or rpc.published_today <> (select count(*) from adu_posting_jobs
        where config_id = c.id and status = 'published'
          and created_at >= m.midnight)
      or rpc.failed_today <> (select count(*) from adu_posting_jobs
        where config_id = c.id
          and status in ('failed_to_publish','publish_error','integrity_error')
          and created_at >= m.midnight)
    );
  if bad <> 0 then raise exception 'parity mismatch on % configs', bad; end if;
  raise notice 'PARITY VS PER-CONFIG COUNTS PASSED';
end $$;
SQL

# Hand-computed expectations (these pin the today-boundary and
# timezone behaviour the independent counts above cannot pin alone):
#   A: pipeline 3, published 2, failed 3, failed_in_pipeline 2
#      (both crash-window jobs on the processing reel; the failed job
#      on the failed reel does NOT subtract), published_today 1
#      (only the +1h job), failed_today 2 (the +1h terminal job and
#      the +2h crash-window job; the -1h crash-window job is yesterday).
#   B: pipeline 1, published 2, failed 0, failed_in_pipeline 0,
#      published_today 1 (only the +1h job), failed_today 0.
#   C: all zeros, row present.
#   D: pipeline 0, published 1, published_today 1 (invalid timezone
#      -> UTC fallback midnight), everything else 0.
PSQL <<'SQL'
do $$
declare
  bad int;
begin
  create temp table expected_counts(
    config_id uuid, in_pipeline bigint, published bigint, failed bigint,
    failed_in_pipeline bigint, published_today bigint, failed_today bigint);
  insert into expected_counts values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 3, 2, 3, 2, 1, 2),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, 2, 0, 0, 1, 0),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 0, 0, 0, 0, 0, 0),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', 0, 1, 0, 0, 1, 0);
  select count(*) into bad
  from expected_counts e
  left join public.adu_config_counts(
    '11111111-1111-1111-1111-111111111111'::uuid,
    array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          'cccccccc-cccc-cccc-cccc-cccccccccccc',
          'dddddddd-dddd-dddd-dddd-dddddddddddd']::uuid[]) rpc
    on rpc.config_id = e.config_id
  where rpc.config_id is null
     or rpc.in_pipeline <> e.in_pipeline
     or rpc.published <> e.published
     or rpc.failed <> e.failed
     or rpc.failed_in_pipeline <> e.failed_in_pipeline
     or rpc.published_today <> e.published_today
     or rpc.failed_today <> e.failed_today;
  if bad <> 0 then raise exception 'hand-computed expectation mismatch on % rows', bad; end if;
  raise notice 'HAND-COMPUTED EXPECTATIONS PASSED';
end $$;
SQL

# Cross-workspace: E's id requested under ws1 returns no row; under ws2
# it returns exactly E's row.
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from public.adu_config_counts(
    '11111111-1111-1111-1111-111111111111'::uuid,
    array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee']::uuid[]);
  if v <> 0 then raise exception 'cross-workspace: ws1 saw E (% rows)', v; end if;
  select published into v from public.adu_config_counts(
    '22222222-2222-2222-2222-222222222222'::uuid,
    array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee']::uuid[]);
  if v <> 1 then raise exception 'cross-workspace: ws2 E published=% (expect 1)', v; end if;
  raise notice 'CROSS-WORKSPACE ASSERTIONS PASSED';
end $$;
SQL

# 50-id cap: 51 ws1 ids in -> 50 rows out.
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from public.adu_config_counts(
    '11111111-1111-1111-1111-111111111111'::uuid,
    (select array_agg(id) from (select id from adu_configs
      where workspace_id = '11111111-1111-1111-1111-111111111111' limit 51) s));
  if v <> 50 then raise exception 'cap: 51 ids in -> % rows (expect 50)', v; end if;
  raise notice 'CAP ASSERTION PASSED';
end $$;
SQL

# --- idempotent re-apply --------------------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f1/sock' -p 55445 -d testaduf1 -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'adu_config_counts';
  if v <> 1 then raise exception 'after re-apply: adu_config_counts count % <> 1', v; end if;
  if has_function_privilege('authenticated', 'public.adu_config_counts(uuid, uuid[])', 'execute') then
    raise exception 'after re-apply: authenticated can execute';
  end if;
  raise notice 'IDEMPOTENT RE-APPLY PASSED';
end $$;
SQL
echo "forward migration is idempotent"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-opt-f1/sock' -p 55445 -d testaduf1 -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- rollback assertions --------------------------------------------------
PSQL <<'SQL'
do $$
declare v int;
begin
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'adu_config_counts';
  if v <> 0 then raise exception 'after reverse: adu_config_counts still exists'; end if;
  select count(*) into v from adu_configs;
  if v <> 56 then raise exception 'after reverse: configs rows % <> 56', v; end if;
  select count(*) into v from adu_posting_jobs;
  if v <> 9 then raise exception 'after reverse: jobs rows % <> 9', v; end if;
  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "ALL ADU-OPT-F1 MIGRATION TESTS PASSED"
