#!/usr/bin/env bash
# Live migration test for the TikTok top-30 / newest-first claim order
# (spec 203): adu_reels gains discovery_rank + view_count, and both
# live claim RPCs (TikTok + non-TikTok) pick
#   ORDER BY created_at DESC, discovery_rank ASC NULLS LAST, id ASC
# instead of the old `ORDER BY r.id ASC` (random UUID = arbitrary).
# created_at separates runs (newest sync first); rank orders inside
# each run. A cross-run case (two runs' rows interleaved in the
# table) asserts the new run's ranks 1..N are claimed before the
# old run's ranks 1..N — rank-first order would interleave them.
#
# Spins up throwaway PostgreSQL 16 clusters as the `postgres` system
# user (postgres refuses to run as root), seeds minimal adu_configs /
# adu_reels tables plus the OLD split claim definitions, applies the
# forward migration, asserts the columns + index + grants + claim
# order (newest-sync-first with rank order inside each run, legacy
# unranked rows last, for BOTH claims), applies the reverse migration,
# asserts the rollback restores the old order — then repeats the claim
# assertions on a second cluster running the OLD definitions and
# asserts they FAIL (the negative control proves the test catches the
# bug). Nothing touches the live database.
#
#   bash supabase/migrations/tests/adu-discovery-rank-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the servers and removing the
# clusters.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261117183523_adu_discovery_rank.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261117183523_adu_discovery_rank.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
# The reverse file IS the old (pre-203) definition, so it doubles as
# the old-code fixture for the negative control.
STAGE=/var/lib/postgresql/16/test-adu-discovery-rank-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/old.sql"
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
  stop_cluster /var/lib/postgresql/16/test-adu-discovery-rank-a
  stop_cluster /var/lib/postgresql/16/test-adu-discovery-rank-b
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-discovery-rank-a/sock' -p 55438 -d testrank -v ON_ERROR_STOP=1 -q"
}
PSQL_B() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-discovery-rank-b/sock' -p 55439 -d testrank -v ON_ERROR_STOP=1 -q"
}

# Minimal shapes the two claim RPCs touch. The roles exist only so
# the grant-closure assertions can run (the production hardening
# file creates them too).
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

# Configs: T, T2 and T3 are TikTok, F is Facebook. All active +
# synced with a buffer target, so all are hungry (buffer empty).
# T3 is the cross-run config (buffer 10, so all six of its rows can
# be claimed in sequence).
SEED_CONFIGS='
insert into public.adu_configs (id, status, sync_status, source_platform, source_username, posts_per_day) values
  ('"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'courtroom62'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'otherhandle'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'facebook'"'"', '"'"'somepage'"'"', 5),
  ('"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'active'"'"', '"'"'synced'"'"', '"'"'tiktok'"'"', '"'"'crossrun'"'"', 10);
'

# Pre-migration rows (unranked): the UUIDs are chosen so the OLD
# `ORDER BY r.id ASC` and the NEW order DISAGREE — the smallest id
# is the oldest unranked row, the largest id is the newest unranked
# row. If the test asserted the same reel under both orders, it
# could not catch the bug.
SEED_UNRANKED_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'00000000-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'u1-oldest'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'50000000-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'u2'"'"', now() - interval '"'"'1 hour'"'"'),
  ('"'"'10000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'t2-oldest'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'90000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'t2-newest'"'"', now()),
  ('"'"'00000000-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'pending'"'"', '"'"'f-unranked'"'"', now() - interval '"'"'2 hours'"'"');
'

# Post-migration rows (ranked, as the spec-203 scraper inserts them):
# rank 1 has the LARGEST id, so the old order would pick it last.
SEED_RANKED_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, discovery_rank, view_count, created_at) values
  ('"'"'ffffffff-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'k1-top-views'"'"', 1, 9999, now()),
  ('"'"'eeeeeeee-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'k2'"'"', 2, 500, now() - interval '"'"'1 minute'"'"'),
  ('"'"'ffffffff-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'pending'"'"', '"'"'fk1-top-views'"'"', 1, 7777, now());
'

# Cross-run rows for config T3: an OLD run (created_at a day ago,
# ranks 1-3) and a NEW run (created_at now, ranks 1-3), interleaved
# in the table. One INSERT per run, so each run's rows share one
# created_at — exactly as the production scraper inserts them.
# The new run's ranks must be claimed strictly before the old run's
# ranks; rank-first order would interleave them (new 1, old 1,
# new 2, old 2, ...).
SEED_CROSS_RUN_REELS='
insert into public.adu_reels (id, config_id, status, source_reel_id, discovery_rank, view_count, created_at) values
  ('"'"'20000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-old1'"'"', 1, 111, now() - interval '"'"'1 day'"'"'),
  ('"'"'21000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-old2'"'"', 2, 222, now() - interval '"'"'1 day'"'"'),
  ('"'"'22000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-old3'"'"', 3, 333, now() - interval '"'"'1 day'"'"');
insert into public.adu_reels (id, config_id, status, source_reel_id, discovery_rank, view_count, created_at) values
  ('"'"'80000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-new1'"'"', 1, 999, now()),
  ('"'"'81000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-new2'"'"', 2, 888, now()),
  ('"'"'82000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-new3'"'"', 3, 777, now());
'

# The same reels as above, but without rank columns (Run B has no
# migration applied, so the columns do not exist there). The ranked
# rows keep their large ids: under the old order they sort last.
SEED_ALL_REELS_NO_RANK='
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'00000000-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'u1-oldest'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'50000000-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'u2'"'"', now() - interval '"'"'1 hour'"'"'),
  ('"'"'ffffffff-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'k1-top-views'"'"', now()),
  ('"'"'eeeeeeee-0000-0000-0000-000000000001'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000001'"'"', '"'"'pending'"'"', '"'"'k2'"'"', now() - interval '"'"'1 minute'"'"'),
  ('"'"'10000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'t2-oldest'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'90000000-0000-0000-0000-000000000002'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000002'"'"', '"'"'pending'"'"', '"'"'t2-newest'"'"', now()),
  ('"'"'00000000-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'pending'"'"', '"'"'f-unranked'"'"', now() - interval '"'"'2 hours'"'"'),
  ('"'"'ffffffff-0000-0000-0000-000000000003'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"', '"'"'pending'"'"', '"'"'fk1-top-views'"'"', now());
'

# The same T3 rows, but without rank columns (Run B has no
# migration applied, so the columns do not exist there). Under the
# old `ORDER BY r.id ASC` the claim sequence is oldest-first by id:
# old 1, old 2, old 3, new 1, new 2, new 3.
SEED_CROSS_RUN_REELS_NO_RANK='
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'20000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-old1'"'"', now() - interval '"'"'1 day'"'"'),
  ('"'"'21000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-old2'"'"', now() - interval '"'"'1 day'"'"'),
  ('"'"'22000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-old3'"'"', now() - interval '"'"'1 day'"'"');
insert into public.adu_reels (id, config_id, status, source_reel_id, created_at) values
  ('"'"'80000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-new1'"'"', now()),
  ('"'"'81000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-new2'"'"', now()),
  ('"'"'82000000-0000-0000-0000-000000000004'"'"', '"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"', '"'"'pending'"'"', '"'"'x-new3'"'"', now());
'

# ================= RUN A: happy path + reverse =================
setup_cluster /var/lib/postgresql/16/test-adu-discovery-rank-a 55438 testrank

PSQL_A <<SQL
$SEED_SCHEMA
SQL

# Old (pre-203) split claim definitions first, so the forward
# migration is proven to apply cleanly over them — as it will on
# production.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-discovery-rank-a/sock' -p 55438 -d testrank -v ON_ERROR_STOP=1 -q -f '$STAGE/old.sql'"

PSQL_A <<SQL
$SEED_CONFIGS
$SEED_UNRANKED_REELS
SQL

# --- apply the forward migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-discovery-rank-a/sock' -p 55438 -d testrank -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# Ranked rows arrive after the migration, as the spec-203 scraper
# inserts them.
PSQL_A <<SQL
$SEED_RANKED_REELS
SQL

# Cross-run rows arrive the same way (one INSERT per run).
PSQL_A <<SQL
$SEED_CROSS_RUN_REELS
SQL

# --- cross-run sequence: newest sync strictly first ----------------------
# Claim six times and record config T3's pick each time. The new
# run's ranks 1..3 must all come before the old run's ranks 1..3.
# (The other configs are claimed alongside; their picks are
# irrelevant here and are reset below.)
PSQL_A <<'SQL'
do $$
declare
  v_seq uuid[] := '{}';
  v_one uuid;
begin
  for i in 1..6 loop
    select reel_id into v_one
      from public.claim_tiktok_buffer_downloads(10)
     where config_id = 'aaaaaaaa-0000-0000-0000-000000000004';
    if v_one is null then
      raise exception 'cross-run: claim % returned no reel for T3', i;
    end if;
    v_seq := v_seq || v_one;
  end loop;
  if v_seq <> array[
    '80000000-0000-0000-0000-000000000004'::uuid,
    '81000000-0000-0000-0000-000000000004'::uuid,
    '82000000-0000-0000-0000-000000000004'::uuid,
    '20000000-0000-0000-0000-000000000004'::uuid,
    '21000000-0000-0000-0000-000000000004'::uuid,
    '22000000-0000-0000-0000-000000000004'::uuid
  ] then
    raise exception 'cross-run: claim sequence % is not newest-sync-first with rank order inside each run', v_seq;
  end if;
  raise notice 'CROSS-RUN CLAIM SEQUENCE PASSED: %', v_seq;
end $$;
SQL

echo "cross-run sequence passed"

# Reset everything the sequence test claimed, so the forward
# assertions below run on a pristine state.
PSQL_A <<SQL
update public.adu_reels
   set status = 'pending', download_retries = 0, download_claimed_at = null;
SQL

# --- forward assertions --------------------------------------------------
PSQL_A <<'SQL'
do $$
declare
  v_rank_type text; v_view_type text; v_index boolean;
  v_secdef boolean; v_pub boolean; v_anon boolean; v_auth boolean; v_svc boolean;
  v_claimed uuid[];
  v_status text; v_retries int; v_views bigint;
begin
  -- (1) columns + index exist, with the right types.
  select data_type into v_rank_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'adu_reels' and column_name = 'discovery_rank';
  if v_rank_type is distinct from 'integer' then raise exception 'discovery_rank missing or wrong type (%)', v_rank_type; end if;
  select data_type into v_view_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'adu_reels' and column_name = 'view_count';
  if v_view_type is distinct from 'bigint' then raise exception 'view_count missing or wrong type (%)', v_view_type; end if;
  select exists(select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_adu_reels_config_status_rank')
    into v_index;
  if not v_index then raise exception 'index idx_adu_reels_config_status_rank missing'; end if;

  -- (2) grants survive CREATE OR REPLACE, for BOTH claims: still
  -- SECURITY DEFINER, still closed to public/anon/authenticated,
  -- still open to service_role.
  for v_secdef, v_pub, v_anon, v_auth, v_svc in
    select p.prosecdef,
           has_function_privilege('public', p.oid, 'EXECUTE'),
           has_function_privilege('anon', p.oid, 'EXECUTE'),
           has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           has_function_privilege('service_role', p.oid, 'EXECUTE')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('claim_tiktok_buffer_downloads', 'claim_non_tiktok_buffer_downloads')
  loop
    if v_secdef is not true then raise exception 'claim is not SECURITY DEFINER after migration'; end if;
    if v_pub or v_anon or v_auth then raise exception 'grant closure broken: public/anon/authenticated can execute a claim'; end if;
    if v_svc is not true then raise exception 'service_role lost EXECUTE after migration'; end if;
  end loop;

  -- (3) TikTok claim: newest sync first, rank order inside a sync.
  -- Config T must yield its rank-1 reel (newest created_at AND
  -- rank 1 — the old order would pick it LAST); config T2, which
  -- has only unranked reels, must yield its NEWEST reel (largest
  -- id again — the old order would pick the oldest). Legacy
  -- unranked rows sort after new runs; the precise cross-run rule
  -- is asserted in the sequence test above.
  select array_agg(reel_id) into v_claimed from public.claim_tiktok_buffer_downloads(10);
  if not ('ffffffff-0000-0000-0000-000000000001' = any(v_claimed)) then
    raise exception 'TikTok claim did not pick the rank-1 reel (claimed %) ', v_claimed;
  end if;
  if not ('90000000-0000-0000-0000-000000000002' = any(v_claimed)) then
    raise exception 'TikTok claim did not pick the newest unranked reel (claimed %)', v_claimed;
  end if;
  if '00000000-0000-0000-0000-000000000001' = any(v_claimed) then
    raise exception 'TikTok claim picked the oldest unranked reel over the ranked one';
  end if;
  if '10000000-0000-0000-0000-000000000002' = any(v_claimed) then
    raise exception 'TikTok claim picked the oldest unranked reel over the newest one';
  end if;

  -- (4) the claim marks the picked reel processing, bumps retries,
  -- and the view count survived on the ranked row.
  select status, download_retries, view_count into v_status, v_retries, v_views
    from public.adu_reels where id = 'ffffffff-0000-0000-0000-000000000001';
  if v_status <> 'processing' then raise exception 'claimed reel status % <> processing', v_status; end if;
  if v_retries <> 1 then raise exception 'claimed reel retries % <> 1', v_retries; end if;
  if v_views <> 9999 then raise exception 'ranked reel view_count % <> 9999', v_views; end if;

  -- (5) non-TikTok claim: same order rule (newest sync first,
  -- rank inside a sync). Config F must yield its rank-1 reel,
  -- not its oldest unranked reel.
  select array_agg(reel_id) into v_claimed from public.claim_non_tiktok_buffer_downloads(10);
  if not ('ffffffff-0000-0000-0000-000000000003' = any(v_claimed)) then
    raise exception 'non-TikTok claim did not pick the rank-1 reel (claimed %)', v_claimed;
  end if;
  if '00000000-0000-0000-0000-000000000003' = any(v_claimed) then
    raise exception 'non-TikTok claim picked the oldest unranked reel over the ranked one';
  end if;

  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "forward migration + assertions passed"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-discovery-rank-a/sock' -p 55438 -d testrank -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- rollback assertions -------------------------------------------------
PSQL_A <<'SQL'
do $$
declare
  v_rank_type text; v_index boolean;
  v_secdef boolean; v_svc boolean;
  v_claimed uuid[];
begin
  -- the columns and the index are gone.
  select data_type into v_rank_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'adu_reels' and column_name = 'discovery_rank';
  if v_rank_type is not null then raise exception 'after reverse: discovery_rank still present'; end if;
  select exists(select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_adu_reels_config_status_rank')
    into v_index;
  if v_index then raise exception 'after reverse: rank index still present'; end if;

  -- grants still hold after the reverse too.
  for v_secdef, v_svc in
    select p.prosecdef, has_function_privilege('service_role', p.oid, 'EXECUTE')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('claim_tiktok_buffer_downloads', 'claim_non_tiktok_buffer_downloads')
  loop
    if v_secdef is not true or v_svc is not true then raise exception 'after reverse: grants broken'; end if;
  end loop;

  -- reset the reels the forward claims picked, then claim again:
  -- the OLD order is back, so the smallest ids win.
  update public.adu_reels
     set status = 'pending', download_retries = 0, download_claimed_at = null;
  select array_agg(reel_id) into v_claimed from public.claim_tiktok_buffer_downloads(10);
  if not ('00000000-0000-0000-0000-000000000001' = any(v_claimed)) then
    raise exception 'after reverse: TikTok claim did not revert to id order (claimed %)', v_claimed;
  end if;
  if not ('10000000-0000-0000-0000-000000000002' = any(v_claimed)) then
    raise exception 'after reverse: TikTok claim did not revert to id order for T2 (claimed %)', v_claimed;
  end if;
  if not ('20000000-0000-0000-0000-000000000004' = any(v_claimed)) then
    raise exception 'after reverse: TikTok claim did not revert to id order for T3 (claimed %)', v_claimed;
  end if;
  select array_agg(reel_id) into v_claimed from public.claim_non_tiktok_buffer_downloads(10);
  if not ('00000000-0000-0000-0000-000000000003' = any(v_claimed)) then
    raise exception 'after reverse: non-TikTok claim did not revert to id order (claimed %)', v_claimed;
  end if;

  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "reverse migration + rollback assertions passed"

# ================= RUN B: negative control (old code must fail) =================
setup_cluster /var/lib/postgresql/16/test-adu-discovery-rank-b 55439 testrank

PSQL_B <<SQL
$SEED_SCHEMA
SQL

# Old split claim definitions only — the forward migration is
# deliberately NOT applied here.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-discovery-rank-b/sock' -p 55439 -d testrank -v ON_ERROR_STOP=1 -q -f '$STAGE/old.sql'"

PSQL_B <<SQL
$SEED_CONFIGS
$SEED_ALL_REELS_NO_RANK
SQL

PSQL_B <<SQL
$SEED_CROSS_RUN_REELS_NO_RANK
SQL

# Cross-run negative control: on old code the claim sequence for
# T3 is id order — old run first (oldest-first by id), NOT the new
# order. This proves the sequence test catches the interleaving
# bug specifically (rank-first order would interleave instead).
PSQL_B <<'SQL'
do $$
declare
  v_seq uuid[] := '{}';
  v_one uuid;
begin
  for i in 1..6 loop
    select reel_id into v_one
      from public.claim_tiktok_buffer_downloads(10)
     where config_id = 'aaaaaaaa-0000-0000-0000-000000000004';
    if v_one is null then
      raise exception 'cross-run negative control: claim % returned no reel for T3', i;
    end if;
    v_seq := v_seq || v_one;
  end loop;
  if v_seq <> array[
    '20000000-0000-0000-0000-000000000004'::uuid,
    '21000000-0000-0000-0000-000000000004'::uuid,
    '22000000-0000-0000-0000-000000000004'::uuid,
    '80000000-0000-0000-0000-000000000004'::uuid,
    '81000000-0000-0000-0000-000000000004'::uuid,
    '82000000-0000-0000-0000-000000000004'::uuid
  ] then
    raise exception 'cross-run negative control: old code sequence % is not id order', v_seq;
  end if;
  if v_seq = array[
    '80000000-0000-0000-0000-000000000004'::uuid,
    '81000000-0000-0000-0000-000000000004'::uuid,
    '82000000-0000-0000-0000-000000000004'::uuid,
    '20000000-0000-0000-0000-000000000004'::uuid,
    '21000000-0000-0000-0000-000000000004'::uuid,
    '22000000-0000-0000-0000-000000000004'::uuid
  ] then
    raise exception 'cross-run negative control: old code produced the new order?!';
  end if;
  raise notice 'CROSS-RUN NEGATIVE CONTROL PASSED: old code claims %', v_seq;
end $$;
SQL

echo "cross-run negative control passed: old code does not claim newest-sync-first"

# Reset everything the sequence claimed, so the negative control
# below runs on a pristine state.
PSQL_B <<SQL
update public.adu_reels
   set status = 'pending', download_retries = 0, download_claimed_at = null;
SQL

# The same "ranked reel is claimed first" assertion as Run A (3):
# on old code it MUST fail — otherwise the test cannot catch the bug.
if PSQL_B <<'SQL' 2>/tmp/adu-discovery-rank-negative.log; then
do $$
declare v_claimed uuid[];
begin
  select array_agg(reel_id) into v_claimed from public.claim_tiktok_buffer_downloads(10);
  if not ('ffffffff-0000-0000-0000-000000000001' = any(v_claimed)) then
    raise exception 'TikTok claim did not pick the rank-1 reel (claimed %) ', v_claimed;
  end if;
end $$;
SQL
  echo "NEGATIVE CONTROL FAILED: old claim picked the rank-1 reel"
  exit 1
fi
grep -q "did not pick the rank-1 reel" /tmp/adu-discovery-rank-negative.log || {
  echo "NEGATIVE CONTROL FAILED: old code failed, but not on the rank assertion"
  cat /tmp/adu-discovery-rank-negative.log
  exit 1
}
echo "negative control passed: old claim does not pick the rank-1 reel"

# And the old order is visible directly: the smallest ids win.
PSQL_B <<'SQL'
do $$
declare v_claimed uuid[];
begin
  select array_agg(reel_id) into v_claimed from public.claim_non_tiktok_buffer_downloads(10);
  if not ('00000000-0000-0000-0000-000000000003' = any(v_claimed)) then
    raise exception 'old code: non-TikTok claim did not pick the smallest id (claimed %)', v_claimed;
  end if;
  raise notice 'OLD ORDER CONFIRMED ON OLD CODE';
end $$;
SQL

echo "ALL ADU-DISCOVERY-RANK MIGRATION TESTS PASSED"
