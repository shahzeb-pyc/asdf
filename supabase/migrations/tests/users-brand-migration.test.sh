#!/usr/bin/env bash
# Live migration test for the white-label brand column (spec 191):
# public.users gains `brand` — NOT NULL, default 'fbuploadpro',
# CHECK (brand IN ('fbuploadpro', 'nextrise')).
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres` system
# user (postgres refuses to run as root), seeds a minimal users table
# (the shape the initial migration creates), applies the forward
# migration, asserts the default fills existing rows, the CHECK rejects
# anything else, and a 'nextrise' value inserts cleanly; applies the
# reverse migration and asserts the column is gone. Nothing touches
# the live database.
#
#   bash supabase/migrations/tests/users-brand-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261114161323_users_brand.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261114161323_users_brand.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-users-brand-stage
mkdir -p "$STAGE"
cp "$MIGRATION" "$STAGE/forward.sql"
cp "$REVERSE" "$STAGE/reverse.sql"
chown -R postgres:postgres "$STAGE"

WORKDIR=/var/lib/postgresql/16/test-users-brand
PORT=55441
SOCK="$WORKDIR/sock"

cleanup() {
  su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' stop -m fast" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR" "$SOCK"
chown -R postgres:postgres "$WORKDIR"
chmod 700 "$WORKDIR"
su postgres -c "$PG_BIN/initdb -D '$WORKDIR/data' -U postgres --auth=trust" >/dev/null
su postgres -c "$PG_BIN/pg_ctl -D '$WORKDIR/data' -o '-k $SOCK -p $PORT -c listen_addresses=' -l '$WORKDIR/log' start" >/dev/null
sleep 1

PSQLQ() {
  su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d postgres -v ON_ERROR_STOP=1 -q -t -A"
}

# Minimal users table, as the initial migration creates it.
PSQLQ <<'SQL' >/dev/null
create table public.users (id uuid primary key, email text not null, name text, subdomain text, role text not null default 'user', status text not null default 'active', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
insert into public.users (id, email, subdomain) values ('11111111-1111-1111-1111-111111111111', 'owner@example.com', 'owner');
SQL

# Forward migration.
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d postgres -v ON_ERROR_STOP=1 -q -f '$STAGE/forward.sql'" >/dev/null

# 1. The column exists, NOT NULL, default 'fbuploadpro'.
DEF=$(PSQLQ <<'SQL'
select column_default || '|' || is_nullable from information_schema.columns where table_schema='public' and table_name='users' and column_name='brand';
SQL
)
[ "$DEF" = "'fbuploadpro'::text|NO" ] || { echo "FAIL: brand column default/nullable = $DEF"; exit 1; }

# 2. The existing row got the default.
GOT=$(PSQLQ <<'SQL'
select brand from public.users where email='owner@example.com';
SQL
)
[ "$GOT" = "fbuploadpro" ] || { echo "FAIL: existing row brand = $GOT, want fbuploadpro"; exit 1; }

# 3. 'nextrise' inserts cleanly; anything else is rejected.
PSQLQ <<'SQL' >/dev/null
insert into public.users (id, email, subdomain, brand) values ('22222222-2222-2222-2222-222222222222', 'student@example.com', 'student1', 'nextrise');
SQL
if PSQLQ <<'SQL' >/dev/null 2>&1; then
insert into public.users (id, email, subdomain, brand) values ('33333333-3333-3333-3333-333333333333', 'bad@example.com', 'bad', 'acme');
SQL
  echo "FAIL: CHECK accepted brand 'acme'"
  exit 1
fi
if PSQLQ <<'SQL' >/dev/null 2>&1; then
update public.users set brand = null where email='owner@example.com';
SQL
  echo "FAIL: NOT NULL accepted a NULL brand"
  exit 1
fi

# Reverse migration.
su postgres -c "$PG_BIN/psql -h '$SOCK' -p $PORT -d postgres -v ON_ERROR_STOP=1 -q -f '$STAGE/reverse.sql'" >/dev/null

# 4. The column is gone.
COUNT=$(PSQLQ <<'SQL'
select count(*) from information_schema.columns where table_schema='public' and table_name='users' and column_name='brand';
SQL
)
[ "$COUNT" = "0" ] || { echo "FAIL: brand column still present after reverse"; exit 1; }

echo "users-brand migration test: PASS"
