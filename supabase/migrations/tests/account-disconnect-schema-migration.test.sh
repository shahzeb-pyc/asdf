#!/usr/bin/env bash
# Live migration test for the account disconnect schema fix (spec 248):
# disconnecting ANY account failed because disconnectAccountRow
# (apps/web/src/lib/connect/disconnect.ts) sets status='disconnected'
# and encrypted_access_token=NULL, while live prod's
# social_accounts_status_check allows only
# ('active','expired','revoked','error') and the token column is
# NOT NULL — proven live 2026-11-25 with rolled-back transactions
# (status-only UPDATE -> CheckViolation, token-only UPDATE ->
# NotNullViolation). Either blocker alone breaks every disconnect.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres`
# system user (postgres refuses to run as root), seeds a minimal
# social_accounts table in the exact pre-migration shape (4-value
# CHECK, NOT NULL token) plus one active row, then:
#   (0) reproduces the bug on the pre-migration schema: the
#       status-only UPDATE fails with CheckViolation, the
#       token-only UPDATE fails with NotNullViolation, and the exact
#       disconnectAccountRow UPDATE fails; the row is unchanged;
#   (1) applies the forward migration twice (idempotent) and asserts
#       the CHECK now lists 'disconnected' (exactly one such
#       constraint) and the token column is nullable;
#   (2) asserts the exact disconnectAccountRow UPDATE now succeeds
#       and the row reads back status='disconnected' with both
#       tokens and the expiry NULL;
#   (3) asserts a bogus status value is still rejected by the CHECK;
#   (4) restores the row, applies the reverse migration, and asserts
#       the CHECK is back to the 4-value list, the token is NOT NULL
#       again, and the disconnect UPDATE fails again (rollback proof).
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/account-disconnect-schema-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261125080000_account_disconnect_schema.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261125080000_account_disconnect_schema.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-account-disconnect-stage
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
  stop_cluster /var/lib/postgresql/16/test-account-disconnect-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-account-disconnect-a/sock' -p 55444 -d testdisconnect -v ON_ERROR_STOP=1 -q -t -A"
}
PSQL_A_FILE() { # $1=file
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-account-disconnect-a/sock' -p 55444 -d testdisconnect -v ON_ERROR_STOP=1 -q -f '$1'"
}

# Minimal social_accounts shape (columns as in the unified schema
# migration 20261022120000 section 4b; platform is text here because
# the migration never touches it) plus one active row with tokens.
# The inline CHECK auto-names itself social_accounts_status_check —
# the same name the live constraint carries.
cat > "$STAGE/seed.sql" <<'SEEDSQL'
create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  platform text not null,
  external_account_id varchar(255) not null,
  display_name varchar(255) not null,
  avatar_url text null,
  encrypted_access_token text not null,
  encrypted_refresh_token text null,
  token_expires_at timestamptz null,
  scopes text[] null,
  status varchar(20) not null default 'active'
    check (status in ('active', 'expired', 'revoked', 'error')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.social_accounts
  (id, workspace_id, platform, external_account_id, display_name,
   encrypted_access_token, encrypted_refresh_token, token_expires_at, status)
values ('11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'facebook', 'fb-user-1', 'Test Account',
        'enc-token-1', 'enc-refresh-1', '2027-01-01 00:00:00+00', 'active');
SEEDSQL
chown -R postgres:postgres "$STAGE"

# The exact disconnectAccountRow UPDATE (apps/web/src/lib/connect/disconnect.ts).
cat > "$STAGE/disconnect.sql" <<'DISCONNECTSQL'
update public.social_accounts
   set status = 'disconnected',
       encrypted_access_token = null,
       encrypted_refresh_token = null,
       token_expires_at = null,
       updated_at = now()
 where id = '11111111-1111-1111-1111-111111111111'
   and workspace_id = '22222222-2222-2222-2222-222222222222'
   and platform = 'facebook';
DISCONNECTSQL
chown -R postgres:postgres "$STAGE"

setup_cluster /var/lib/postgresql/16/test-account-disconnect-a 55444 testdisconnect

PSQL_A_FILE "$STAGE/seed.sql"

# --- (0) reproduce the bug on the pre-migration schema -----------------------
if PSQL_A <<'SQL' > /tmp/account-disconnect-status-only.out 2>&1
update public.social_accounts set status = 'disconnected'
 where id = '11111111-1111-1111-1111-111111111111';
SQL
then
  echo "BUG-REPRO CHECK FAILED: status-only UPDATE to 'disconnected' succeeded before the migration"
  exit 1
fi
grep -q 'violates check constraint "social_accounts_status_check"' /tmp/account-disconnect-status-only.out || {
  echo "BUG-REPRO CHECK FAILED: status-only UPDATE failed, but not on the status CHECK:"
  cat /tmp/account-disconnect-status-only.out
  exit 1
}
echo "pre-migration: status-only UPDATE fails with CheckViolation (blocker 1 reproduced)"

if PSQL_A <<'SQL' > /tmp/account-disconnect-token-only.out 2>&1
update public.social_accounts set encrypted_access_token = null
 where id = '11111111-1111-1111-1111-111111111111';
SQL
then
  echo "BUG-REPRO CHECK FAILED: token-only UPDATE to NULL succeeded before the migration"
  exit 1
fi
grep -q 'null value in column "encrypted_access_token" of relation "social_accounts"' /tmp/account-disconnect-token-only.out || {
  echo "BUG-REPRO CHECK FAILED: token-only UPDATE failed, but not on the NOT NULL:"
  cat /tmp/account-disconnect-token-only.out
  exit 1
}
echo "pre-migration: token-only UPDATE fails with NotNullViolation (blocker 2 reproduced)"

if PSQL_A_FILE "$STAGE/disconnect.sql" > /tmp/account-disconnect-full.out 2>&1; then
  echo "BUG-REPRO CHECK FAILED: exact disconnect UPDATE succeeded before the migration"
  exit 1
fi
echo "pre-migration: exact disconnectAccountRow UPDATE fails (bug reproduced)"

PSQL_A <<'SQL' > /tmp/account-disconnect-row-before.out
select 'row:' || status || '|' || coalesce(encrypted_access_token, 'NULL')
  from public.social_accounts
 where id = '11111111-1111-1111-1111-111111111111';
SQL
grep -q "row:active|enc-token-1" /tmp/account-disconnect-row-before.out || {
  echo "BUG-REPRO CHECK FAILED: row changed despite the failed UPDATEs:"
  cat /tmp/account-disconnect-row-before.out
  exit 1
}
echo "pre-migration: row unchanged after the failed UPDATEs"

# --- (1) apply the forward migration twice (idempotent) ----------------------
PSQL_A_FILE "$STAGE/forward.sql"
PSQL_A_FILE "$STAGE/forward.sql"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL' > /tmp/account-disconnect-after.out
select 'checkdef:' || pg_get_constraintdef(oid) from pg_constraint
 where conname = 'social_accounts_status_check' and conrelid = 'public.social_accounts'::regclass;
select 'checkcount:' || count(*) from pg_constraint
 where conname = 'social_accounts_status_check' and conrelid = 'public.social_accounts'::regclass;
select 'nullable:' || is_nullable from information_schema.columns
 where table_schema = 'public' and table_name = 'social_accounts'
   and column_name = 'encrypted_access_token';
SQL
cat /tmp/account-disconnect-after.out
grep -q "checkdef:.*'disconnected'" /tmp/account-disconnect-after.out || {
  echo "MIGRATION CHECK FAILED: CHECK does not list 'disconnected':"
  cat /tmp/account-disconnect-after.out
  exit 1
}
grep -q "checkcount:1" /tmp/account-disconnect-after.out || {
  echo "MIGRATION CHECK FAILED: status CHECK exists more than once"
  cat /tmp/account-disconnect-after.out
  exit 1
}
grep -q "nullable:YES" /tmp/account-disconnect-after.out || {
  echo "MIGRATION CHECK FAILED: encrypted_access_token is still NOT NULL"
  cat /tmp/account-disconnect-after.out
  exit 1
}
echo "CHECK lists 'disconnected' (exactly once); token column is nullable"

# --- (2) the exact disconnect UPDATE now succeeds ----------------------------
PSQL_A_FILE "$STAGE/disconnect.sql"
PSQL_A <<'SQL' > /tmp/account-disconnect-row-after.out
select 'row:' || status || '|'
  || coalesce(encrypted_access_token, 'NULL') || '|'
  || coalesce(encrypted_refresh_token, 'NULL') || '|'
  || coalesce(token_expires_at::text, 'NULL')
  from public.social_accounts
 where id = '11111111-1111-1111-1111-111111111111';
SQL
grep -q "row:disconnected|NULL|NULL|NULL" /tmp/account-disconnect-row-after.out || {
  echo "DISCONNECT CHECK FAILED: row did not read back disconnected with NULL tokens:"
  cat /tmp/account-disconnect-row-after.out
  exit 1
}
echo "exact disconnectAccountRow UPDATE succeeds; row is disconnected with NULL tokens"

# --- (3) a bogus status is still rejected ------------------------------------
if PSQL_A <<'SQL' > /tmp/account-disconnect-bogus.out 2>&1
update public.social_accounts set status = 'bogus'
 where id = '11111111-1111-1111-1111-111111111111';
SQL
then
  echo "BOGUS-STATUS CHECK FAILED: status 'bogus' was accepted"
  exit 1
fi
grep -q 'violates check constraint "social_accounts_status_check"' /tmp/account-disconnect-bogus.out || {
  echo "BOGUS-STATUS CHECK FAILED: bogus UPDATE failed, but not on the status CHECK:"
  cat /tmp/account-disconnect-bogus.out
  exit 1
}
echo "bogus status still rejected with CheckViolation"

# --- (4) rollback proof: restore the row, apply reverse, disconnect fails ----
PSQL_A <<'SQL'
update public.social_accounts
   set status = 'active',
       encrypted_access_token = 'enc-token-1',
       encrypted_refresh_token = 'enc-refresh-1',
       token_expires_at = '2027-01-01 00:00:00+00'
 where id = '11111111-1111-1111-1111-111111111111';
SQL
PSQL_A_FILE "$STAGE/reverse.sql"
PSQL_A <<'SQL' > /tmp/account-disconnect-rollback.out
select 'checkdef:' || pg_get_constraintdef(oid) from pg_constraint
 where conname = 'social_accounts_status_check' and conrelid = 'public.social_accounts'::regclass;
select 'nullable:' || is_nullable from information_schema.columns
 where table_schema = 'public' and table_name = 'social_accounts'
   and column_name = 'encrypted_access_token';
SQL
grep -q "checkdef:.*'active'.*'expired'.*'revoked'.*'error'" /tmp/account-disconnect-rollback.out || {
  echo "ROLLBACK CHECK FAILED: CHECK is not back to the 4-value list:"
  cat /tmp/account-disconnect-rollback.out
  exit 1
}
if grep -q "checkdef:.*'disconnected'" /tmp/account-disconnect-rollback.out; then
  echo "ROLLBACK CHECK FAILED: CHECK still lists 'disconnected' after the reverse migration:"
  cat /tmp/account-disconnect-rollback.out
  exit 1
fi
grep -q "nullable:NO" /tmp/account-disconnect-rollback.out || {
  echo "ROLLBACK CHECK FAILED: token column is not NOT NULL again"
  cat /tmp/account-disconnect-rollback.out
  exit 1
}
if PSQL_A_FILE "$STAGE/disconnect.sql" > /tmp/account-disconnect-rollback-fail.out 2>&1; then
  echo "ROLLBACK CHECK FAILED: disconnect UPDATE succeeded after the reverse migration"
  exit 1
fi
echo "rollback check passed: CHECK back to 4 values, token NOT NULL, disconnect fails again"

echo "ALL ACCOUNT-DISCONNECT MIGRATION TESTS PASSED"
