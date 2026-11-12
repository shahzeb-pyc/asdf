#!/usr/bin/env bash
# Live migration test for spec 174 PR 2B (subscription_usage section).
#
# Spins up throwaway PostgreSQL 16 clusters as the `postgres` system
# user (postgres refuses to run as root), seeds a minimal
# pre-migration subscription_usage table, applies the forward
# migration, asserts the backfill + new key, applies the reverse
# migration, asserts the rollback — then repeats the forward apply
# on a second cluster seeded with an unknown feature and asserts
# it FAILS loudly. Nothing touches the live database.
#
#   bash supabase/migrations/tests/174-2b-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the servers and removing the
# clusters.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261113050000_subscription_usage_section.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261113050000_subscription_usage_section.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-174-2b-stage
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
  stop_cluster /var/lib/postgresql/16/test-174-2b-a
  stop_cluster /var/lib/postgresql/16/test-174-2b-b
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-2b-a/sock' -p 55434 -d test174b -v ON_ERROR_STOP=1 -q"
}
PSQL_TA_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-2b-a/sock' -p 55434 -d test174b -tA -c '$1'"
}
PSQL_B() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-2b-b/sock' -p 55435 -d test174b -v ON_ERROR_STOP=1 -q"
}

# ================= RUN A: happy path + reverse =================
setup_cluster /var/lib/postgresql/16/test-174-2b-a 55434 test174b

PSQL_A <<'SQL'
create table public.subscription_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  platform text not null
    check (platform in ('facebook', 'instagram', 'threads', 'x', 'tiktok', 'youtube')),
  destination_key text not null,
  feature text not null,
  destination_id uuid,
  created_at timestamptz not null default now()
);
create unique index idx_subscription_usage_user_platform_destination
  on public.subscription_usage (user_id, platform, destination_key);
create index idx_subscription_usage_user_platform
  on public.subscription_usage (user_id, platform);
SQL

# Seed: one row per feature (the old key forbids two rows per key —
# the counts-twice shape can only exist AFTER the migration), one
# legacy publish-now row, one NULL destination_id.
PSQL_A <<'SQL'
insert into public.subscription_usage (user_id, platform, destination_key, feature, destination_id, created_at) values
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-a', 'destination-queue', '10000000-0000-0000-0000-000000000001', '2026-11-01 10:00:00+00'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-b', 'tiktok-mirror', '10000000-0000-0000-0000-000000000002', now()),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-c', 'auto-repost', '10000000-0000-0000-0000-000000000003', now()),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-d', 'publish-now', '10000000-0000-0000-0000-000000000004', now()),
  ('66666666-6666-6666-6666-666666666666', 'instagram', 'acct-1', 'auto-download-upload', '10000000-0000-0000-0000-000000000005', now()),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-e', 'destination-queue', null, now());
SQL

echo "seeded: usage=$(PSQL_TA_A 'select count(*) from subscription_usage') (expect 6)"

# --- apply the forward migration (its own assertions run inside) --------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-2b-a/sock' -p 55434 -d test174b -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'"

# --- forward assertions --------------------------------------------------
PSQL_A <<'SQL'
do $$
declare v int;
begin
  -- backfill: one section per feature, every row labelled
  select count(*) into v from subscription_usage where section = 'schedule';
  if v <> 2 then raise exception 'schedule rows % <> 2', v; end if;
  select count(*) into v from subscription_usage where section = 'adu';
  if v <> 1 then raise exception 'adu rows % <> 1', v; end if;
  select count(*) into v from subscription_usage where section = 'mirror';
  if v <> 2 then raise exception 'mirror rows % <> 2', v; end if;
  select count(*) into v from subscription_usage where section = 'publish_now';
  if v <> 1 then raise exception 'publish_now rows % <> 1', v; end if;
  select count(*) into v from subscription_usage where section is null;
  if v <> 0 then raise exception '% rows left with NULL section', v; end if;
  -- the counts-twice shape: the same key registers in a SECOND
  -- section only after the migration (the old key forbade it
  -- before). This row stays, so the reverse must collapse it.
  insert into subscription_usage (user_id, platform, destination_key, feature, destination_id, section)
  values ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-a', 'auto-download-upload', '10000000-0000-0000-0000-000000000001', 'adu');
  select count(distinct section) into v from subscription_usage
  where destination_key = 'page-a';
  if v <> 2 then raise exception 'page-a spans % sections <> 2', v; end if;
  -- the NULL-destination_id row still backfilled (link is not the key)
  select count(*) into v from subscription_usage
  where destination_key = 'page-e' and section = 'schedule' and destination_id is null;
  if v <> 1 then raise exception 'NULL-destination_id row not backfilled'; end if;
  -- column is NOT NULL with the four-value CHECK
  select count(*) into v from information_schema.columns
  where table_schema = 'public' and table_name = 'subscription_usage'
    and column_name = 'section' and is_nullable = 'NO';
  if v <> 1 then raise exception 'section column is not NOT NULL'; end if;
  -- new key in place, old key gone, section index present
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'subscription_usage'
    and indexname = 'idx_subscription_usage_user_platform_section_destination';
  if v <> 1 then raise exception 'new section-scoped unique index missing'; end if;
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'subscription_usage'
    and indexname = 'idx_subscription_usage_user_platform_destination';
  if v <> 0 then raise exception 'old unique index still present'; end if;
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'subscription_usage'
    and indexname = 'idx_subscription_usage_user_platform_section';
  if v <> 1 then raise exception 'section index missing'; end if;

  -- NEGATIVE: same key + same section conflicts ...
  begin
    insert into subscription_usage (user_id, platform, destination_key, feature, destination_id, section)
    values ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-a', 'destination-queue', '10000000-0000-0000-0000-000000000001', 'schedule');
    raise exception 'duplicate (user, platform, section, key) was allowed';
  exception when unique_violation then null;
  end;
  -- ... but the same key in a THIRD section is allowed (counts twice/thrice)
  insert into subscription_usage (user_id, platform, destination_key, feature, destination_id, section)
  values ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-a', 'tiktok-mirror', '10000000-0000-0000-0000-000000000001', 'mirror');
  delete from subscription_usage where destination_key = 'page-a' and section = 'mirror' and feature = 'tiktok-mirror';
  -- NEGATIVE: NULL section is refused
  begin
    insert into subscription_usage (user_id, platform, destination_key, feature, destination_id, section)
    values ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-z', 'destination-queue', null, null);
    raise exception 'NULL section insert was allowed';
  exception when not_null_violation then null;
  end;
  -- NEGATIVE: a section outside the four values is refused
  begin
    insert into subscription_usage (user_id, platform, destination_key, feature, destination_id, section)
    values ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-z', 'destination-queue', null, 'other');
    raise exception 'out-of-range section insert was allowed';
  exception when check_violation then null;
  end;

  raise notice 'FORWARD MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "forward migration + assertions passed"

# --- apply the reverse migration -----------------------------------------
su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-2b-a/sock' -p 55434 -d test174b -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'"

# --- rollback assertions -------------------------------------------------
PSQL_A <<'SQL'
do $$
declare v int;
begin
  -- 7 rows collapse to 6 (page-a's two rows become one)
  select count(*) into v from subscription_usage;
  if v <> 6 then raise exception 'after reverse: usage rows % <> 6', v; end if;
  -- the survivor is the earlier (schedule) row
  select count(*) into v from subscription_usage
  where destination_key = 'page-a' and feature = 'destination-queue';
  if v <> 1 then raise exception 'after reverse: page-a survivor is not the schedule row'; end if;
  -- the section column is gone
  select count(*) into v from information_schema.columns
  where table_schema = 'public' and table_name = 'subscription_usage' and column_name = 'section';
  if v <> 0 then raise exception 'after reverse: section column still present'; end if;
  -- the old unique key is back and enforced
  select count(*) into v from pg_indexes
  where schemaname = 'public' and tablename = 'subscription_usage'
    and indexname = 'idx_subscription_usage_user_platform_destination';
  if v <> 1 then raise exception 'after reverse: old unique index not restored'; end if;
  begin
    insert into subscription_usage (user_id, platform, destination_key, feature, destination_id)
    values ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-a', 'destination-queue', '10000000-0000-0000-0000-000000000001');
    raise exception 'duplicate (user, platform, key) was allowed after reverse';
  exception when unique_violation then null;
  end;

  raise notice 'REVERSE MIGRATION ASSERTIONS PASSED';
end $$;
SQL

echo "reverse migration + rollback assertions passed"

# ================= RUN B: unknown feature fails loud =================
setup_cluster /var/lib/postgresql/16/test-174-2b-b 55435 test174b

PSQL_B <<'SQL'
create table public.subscription_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  platform text not null,
  destination_key text not null,
  feature text not null,
  destination_id uuid,
  created_at timestamptz not null default now()
);
create unique index idx_subscription_usage_user_platform_destination
  on public.subscription_usage (user_id, platform, destination_key);
insert into public.subscription_usage (user_id, platform, destination_key, feature, destination_id) values
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-a', 'destination-queue', '10000000-0000-0000-0000-000000000001'),
  ('55555555-5555-5555-5555-555555555555', 'facebook', 'page-mystery', 'mystery-feature', '10000000-0000-0000-0000-000000000009');
SQL

# The forward migration MUST fail on the unmapped feature — a row
# with no section must never be silently mislabelled or left NULL.
if su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-174-2b-b/sock' -p 55435 -d test174b -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'" 2>/tmp/174-2b-negative.log; then
  echo "NEGATIVE CONTROL FAILED: migration applied despite an unmapped feature"
  exit 1
fi
grep -q "unmapped feature" /tmp/174-2b-negative.log || {
  echo "NEGATIVE CONTROL FAILED: migration failed, but not on the unmapped-feature assertion"
  cat /tmp/174-2b-negative.log
  exit 1
}
echo "negative control passed: unknown feature fails the migration loudly"

echo "ALL 174-2B MIGRATION TESTS PASSED"
