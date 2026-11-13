#!/usr/bin/env bash
# Live migration test for the ADU duplicate-minting fix, downloader half
# (spec adu-reel-download-claim-clear): mark_adu_reel_downloaded must
# clear download_claimed_at.
#
# Spins up throwaway PostgreSQL 16 clusters as the `postgres` system
# user (postgres refuses to run as root), seeds a minimal adu_reels
# table plus the OLD mark/reset functions, applies the forward
# migration, asserts the claim is cleared + grants survive + the
# stale-reset cycle is broken, applies the reverse migration, asserts
# the rollback — then repeats the same assertions on a second cluster
# running the OLD mark function and asserts they FAIL (the negative
# control proves the test catches the bug). Nothing touches the live
# database.
#
#   bash supabase/migrations/tests/adu-reel-download-claim-clear-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the servers and removing the
# clusters.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113120000_mark_adu_reel_downloaded_clear_claim.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113120000_mark_adu_reel_downloaded_clear_claim.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
# The reverse file IS the old (pre-fix) definition, so it doubles as
# the old-code fixture for the negative control.
STAGE=/var/lib/postgresql/16/test-adu-claim-clear-stage
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
  stop_cluster /var/lib/postgresql/16/test-adu-claim-clear-a
  stop_cluster /var/lib/postgresql/16/test-adu-claim-clear-b
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-clear-a/sock' -p 55436 -d testclaim -v ON_ERROR_STOP=1 -q"
}
PSQL_B() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-clear-b/sock' -p 55437 -d testclaim -v ON_ERROR_STOP=1 -q"
}

# Minimal adu_reels shape the two functions touch, plus the
# reset_stale function verbatim from 20261030130000 (the cycle's
# other half). The roles exist only so the grant-closure assertions
# can run (the production hardening file creates them too).
SEED_SCHEMA='
create table public.adu_reels (
  id uuid primary key,
  status text not null,
  media_object_key text,
  media_size_bytes bigint,
  media_content_type text,
  media_sha256 text,
  media_url text,
  caption text,
  downloaded_at timestamptz,
  download_retries int not null default 0,
  download_claimed_at timestamptz
);
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create or replace function public.reset_stale_adu_reel_downloads(p_stale_minutes int default 40)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reset_count integer;
begin
  update public.adu_reels
  set
    status = '"'"'pending'"'"',
    download_claimed_at = null
  where status = '"'"'processing'"'"'
    and download_claimed_at is not null
    and download_claimed_at < now() - make_interval(mins => p_stale_minutes)
    and download_retries < 3;
  get diagnostics v_reset_count = row_count;
  return v_reset_count;
end;
$$;
'

# The grant closure the production hardening file
# (20261030140000) applies to this function.
GRANT_CLOSURE='
revoke execute on function public.mark_adu_reel_downloaded(uuid, text, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.mark_adu_reel_downloaded(uuid, text, bigint, text, text, text, text) to service_role;
'

# ================= RUN A: happy path + reverse =================
setup_cluster /var/lib/postgresql/16/test-adu-claim-clear-a 55436 testclaim

PSQL_A <<SQL
$SEED_SCHEMA
SQL

# Old (pre-fix) mark definition first, so the forward migration is
# proven to apply cleanly over it — as it will on production.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-clear-a/sock' -p 55436 -d testclaim -v ON_ERROR_STOP=1 -q -f '$STAGE/old.sql'"

PSQL_A <<SQL
$GRANT_CLOSURE
SQL

# Seed: R1 is a reel the downloader claimed 2 hours ago and has just
# finished downloading (the exact state mark_adu_reel_downloaded sees
# in production).
PSQL_A <<'SQL'
insert into public.adu_reels (id, status, download_claimed_at, download_retries) values
  ('10000000-0000-0000-0000-000000000001', 'processing', now() - interval '2 hours', 1);
SQL

# --- apply the forward migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-clear-a/sock' -p 55436 -d testclaim -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions --------------------------------------------------
PSQL_A <<'SQL'
do $$
declare
  v_claim timestamptz;
  v_status text;
  v_retries int;
  v_downloaded timestamptz;
  v_secdef boolean;
  v_pub boolean; v_anon boolean; v_auth boolean; v_svc boolean;
  v_reset int;
begin
  -- (1) grants survive CREATE OR REPLACE (the spec's acceptance):
  -- still SECURITY DEFINER, still closed to public/anon/
  -- authenticated, still open to service_role.
  select p.prosecdef,
         has_function_privilege('public', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('service_role', p.oid, 'EXECUTE')
    into v_secdef, v_pub, v_anon, v_auth, v_svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mark_adu_reel_downloaded';
  if v_secdef is not true then raise exception 'mark is not SECURITY DEFINER after migration'; end if;
  if v_pub or v_anon or v_auth then raise exception 'grant closure broken: public/anon/authenticated can execute'; end if;
  if v_svc is not true then raise exception 'service_role lost EXECUTE after migration'; end if;

  -- (2) the fix itself: mark clears the download claim.
  perform public.mark_adu_reel_downloaded(
    '10000000-0000-0000-0000-000000000001', 'obj/key.mp4', 12345,
    'video/mp4', 'deadbeef', 'a caption', 'https://example.invalid/r.mp4');
  select status, download_claimed_at, download_retries, downloaded_at
    into v_status, v_claim, v_retries, v_downloaded
    from public.adu_reels where id = '10000000-0000-0000-0000-000000000001';
  if v_status <> 'downloaded' then raise exception 'reel status % <> downloaded', v_status; end if;
  if v_claim is not null then raise exception 'download_claimed_at NOT cleared by mark (still %)', v_claim; end if;
  if v_retries <> 0 then raise exception 'download_retries % <> 0', v_retries; end if;
  if v_downloaded is null then raise exception 'downloaded_at not stamped'; end if;

  -- (3) the cycle is broken end to end: simulate the worker tick
  -- claiming the just-downloaded reel at a posting slot (the old
  -- tick claim never touches download_claimed_at, so it stays NULL),
  -- then run the downloader's per-loop stale reset — it must NOT
  -- reset the tick-claimed reel.
  update public.adu_reels set status = 'processing'
   where id = '10000000-0000-0000-0000-000000000001';
  v_reset := public.reset_stale_adu_reel_downloads(40);
  if v_reset <> 0 then raise exception 'stale reset claimed % reel(s) it should not have', v_reset; end if;
  select status, download_claimed_at into v_status, v_claim
    from public.adu_reels where id = '10000000-0000-0000-0000-000000000001';
  if v_status <> 'processing' then raise exception 'tick-claimed reel was reset to %', v_status; end if;
  if v_claim is not null then raise exception 'tick-claimed reel gained a claim timestamp'; end if;

  -- (4) the stale reset still works for a genuinely stalled download
  -- (claimed, never completed, timestamp still set): it must reset.
  insert into public.adu_reels (id, status, download_claimed_at, download_retries) values
    ('10000000-0000-0000-0000-000000000002', 'processing', now() - interval '2 hours', 1);
  v_reset := public.reset_stale_adu_reel_downloads(40);
  if v_reset <> 1 then raise exception 'stale reset returned % <> 1 for a stalled download', v_reset; end if;
  select status, download_claimed_at into v_status, v_claim
    from public.adu_reels where id = '10000000-0000-0000-0000-000000000002';
  if v_status <> 'pending' then raise exception 'stalled download not reset to pending (still %)', v_status; end if;
  if v_claim is not null then raise exception 'stalled download kept its claim after reset'; end if;

  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "forward migration + assertions passed"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-clear-a/sock' -p 55436 -d testclaim -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- rollback assertions -------------------------------------------------
PSQL_A <<'SQL'
do $$
declare
  v_claim timestamptz;
  v_status text;
  v_secdef boolean; v_svc boolean;
begin
  -- the old definition is back: mark no longer clears the claim.
  insert into public.adu_reels (id, status, download_claimed_at, download_retries) values
    ('10000000-0000-0000-0000-000000000003', 'processing', now() - interval '2 hours', 1);
  perform public.mark_adu_reel_downloaded(
    '10000000-0000-0000-0000-000000000003', 'obj/key.mp4', 12345,
    'video/mp4', 'deadbeef', 'a caption', 'https://example.invalid/r.mp4');
  select status, download_claimed_at into v_status, v_claim
    from public.adu_reels where id = '10000000-0000-0000-0000-000000000003';
  if v_status <> 'downloaded' then raise exception 'after reverse: reel status % <> downloaded', v_status; end if;
  if v_claim is null then raise exception 'after reverse: claim was cleared (reverse did not restore the old definition)'; end if;
  -- grants still hold after the reverse too.
  select p.prosecdef, has_function_privilege('service_role', p.oid, 'EXECUTE')
    into v_secdef, v_svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mark_adu_reel_downloaded';
  if v_secdef is not true or v_svc is not true then raise exception 'after reverse: grants broken'; end if;

  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "reverse migration + rollback assertions passed"

# ================= RUN B: negative control (old code must fail) =================
setup_cluster /var/lib/postgresql/16/test-adu-claim-clear-b 55437 testclaim

PSQL_B <<SQL
$SEED_SCHEMA
SQL

# Old mark definition only — the forward migration is deliberately
# NOT applied here.
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-adu-claim-clear-b/sock' -p 55437 -d testclaim -v ON_ERROR_STOP=1 -q -f '$STAGE/old.sql'"

PSQL_B <<'SQL'
insert into public.adu_reels (id, status, download_claimed_at, download_retries) values
  ('10000000-0000-0000-0000-000000000001', 'processing', now() - interval '2 hours', 1);
SQL

# The same "mark clears the claim" assertion as Run A (2): on old
# code it MUST fail — otherwise the test cannot catch the bug.
if PSQL_B <<'SQL' 2>/tmp/adu-claim-clear-negative.log; then
do $$
declare v_claim timestamptz;
begin
  perform public.mark_adu_reel_downloaded(
    '10000000-0000-0000-0000-000000000001', 'obj/key.mp4', 12345,
    'video/mp4', 'deadbeef', 'a caption', 'https://example.invalid/r.mp4');
  select download_claimed_at into v_claim
    from public.adu_reels where id = '10000000-0000-0000-0000-000000000001';
  if v_claim is not null then raise exception 'download_claimed_at NOT cleared by mark (still %)', v_claim;
  end if;
end $$;
SQL
  echo "NEGATIVE CONTROL FAILED: old mark definition cleared the claim"
  exit 1
fi
grep -q "NOT cleared by mark" /tmp/adu-claim-clear-negative.log || {
  echo "NEGATIVE CONTROL FAILED: old code failed, but not on the claim assertion"
  cat /tmp/adu-claim-clear-negative.log
  exit 1
}
echo "negative control passed: old mark leaves the claim set"

# And the cycle reproduces on old code: tick-claim the reel, run the
# stale reset, and the claim is undone (reel back to pending).
PSQL_B <<'SQL'
do $$
declare v_reset int; v_status text;
begin
  update public.adu_reels set status = 'processing'
   where id = '10000000-0000-0000-0000-000000000001';
  v_reset := public.reset_stale_adu_reel_downloads(40);
  if v_reset <> 1 then raise exception 'old code: stale reset returned % <> 1 (cycle did not reproduce)', v_reset; end if;
  select status into v_status
    from public.adu_reels where id = '10000000-0000-0000-0000-000000000001';
  if v_status <> 'pending' then raise exception 'old code: tick-claimed reel not reset to pending (still %)', v_status; end if;
  raise notice 'CYCLE REPRODUCED ON OLD CODE';
end $$;
SQL

echo "ALL ADU-REEL-DOWNLOAD-CLAIM-CLEAR MIGRATION TESTS PASSED"
