#!/usr/bin/env bash
# Live migration test for allowing @fbuploadpro.com email addresses
# (spec 261): public.users is guarded by canonicalize_user_email()
# plus the check_users_gmail_only CHECK constraint, both of which reject
# any email that is not @gmail.com / @googlemail.com. Proven live
# 2026-11-27: creating mpersonal@fbuploadpro.com succeeded in Auth but
# the public.users INSERT failed with 'Only @gmail.com or @googlemail.com
# email addresses are permitted', leaving the auth user orphaned.
#
# Spins up a throwaway PostgreSQL 16 cluster as the `postgres`
# system user (postgres refuses to run as root), seeds a minimal
# public.users table in the exact pre-migration shape (Gmail-only
# function + trigger + CHECK) plus the old function definition, then:
#   (0) reproduces the bug on the pre-migration schema: INSERT of a
#       @fbuploadpro.com address fails with the Gmail-only exception
#       (insert path and direct-normalized_email-update path), while a
#       Gmail insert still canonicalizes exactly as today;
#   (1) applies the forward migration twice (idempotent) and asserts
#       the CHECK now accepts the fbuploadpro.com pattern (exactly one
#       such constraint) and the function admits the domain;
#   (2) asserts @fbuploadpro.com inserts succeed with normalized_email
#       kept as-is (lowercased, trimmed; dots kept), direct
#       normalized_email updates to the domain succeed, and Gmail
#       canonicalization is byte-identical to before;
#   (3) asserts other domains are still rejected with the unchanged
#       message, and an empty @fbuploadpro.com username is rejected;
#   (4) applies the reverse migration and asserts the CHECK is back to
#       Gmail-only and the @fbuploadpro.com insert fails again
#       (rollback proof).
# Nothing touches the live database.
#
#   bash supabase/migrations/tests/allow-fbuploadpro-email-domain-migration.test.sh
#
# Exit code 0 = all assertions passed. Any failure aborts the script
# (set -euo pipefail) after stopping the server and removing the
# cluster.
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261127190200_allow_fbuploadpro_email_domain.sql"
REVERSE="$ROOT/supabase/migrations/reverse/20261127190200_allow_fbuploadpro_email_domain.sql"

[ -f "$MIGRATION" ] || { echo "MIGRATION NOT FOUND: $MIGRATION"; exit 1; }
[ -f "$REVERSE" ] || { echo "REVERSE NOT FOUND: $REVERSE"; exit 1; }
id postgres >/dev/null 2>&1 || { echo "no postgres system user"; exit 1; }
[ -x "$PG_BIN/initdb" ] || { echo "no postgres 16 binaries at $PG_BIN"; exit 1; }

# The postgres user cannot read the worktree (/home/hatch is not
# world-traversable), so stage the migration files where it can read them.
STAGE=/var/lib/postgresql/16/test-allow-fbuploadpro-stage
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
  stop_cluster /var/lib/postgresql/16/test-allow-fbuploadpro-a
  rm -rf "$STAGE"
}
trap cleanup EXIT

PSQL_A() {
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-allow-fbuploadpro-a/sock' -p 55445 -d testfbuploadpro -v ON_ERROR_STOP=1 -q -t -A"
}
PSQL_A_FILE() { # $1=file
  su postgres -c "$PG_BIN/psql -h '/var/lib/postgresql/16/test-allow-fbuploadpro-a/sock' -p 55445 -d testfbuploadpro -v ON_ERROR_STOP=1 -q -f '$1'"
}

# Minimal public.users shape plus the PRE-migration Gmail-only function,
# trigger and CHECK (verbatim from
# 20261014025531_fix_normalized_email_trigger_and_check_constraint.sql).
cat > "$STAGE/seed.sql" <<'SEEDSQL'
create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text null,
  normalized_email text null,
  name text null,
  created_at timestamptz not null default now()
);
CREATE OR REPLACE FUNCTION canonicalize_user_email()
RETURNS TRIGGER AS $$
DECLARE
  v_raw_email TEXT;
  v_username TEXT;
  v_domain TEXT;
  v_clean_username TEXT;
BEGIN
  IF NEW.email IS NOT NULL THEN
    v_raw_email := trim(NEW.email);
    v_username := split_part(v_raw_email, '@', 1);
    v_domain := lower(split_part(v_raw_email, '@', 2));
    IF v_domain NOT IN ('gmail.com', 'googlemail.com') THEN
      RAISE EXCEPTION 'Only @gmail.com or @googlemail.com email addresses are permitted';
    END IF;
    v_username := split_part(v_username, '+', 1);
    v_username := lower(v_username);
    v_clean_username := regexp_replace(v_username, '[^a-z0-9]', '', 'g');
    IF v_clean_username = '' THEN
      RAISE EXCEPTION 'Email username cannot be empty';
    END IF;
    NEW.normalized_email := v_clean_username || '@gmail.com';
  ELSIF NEW.normalized_email IS NOT NULL THEN
    v_raw_email := trim(NEW.normalized_email);
    v_username := split_part(v_raw_email, '@', 1);
    v_domain := lower(split_part(v_raw_email, '@', 2));
    IF v_domain NOT IN ('gmail.com', 'googlemail.com') THEN
      RAISE EXCEPTION 'Only @gmail.com or @googlemail.com email addresses are permitted';
    END IF;
    v_username := split_part(v_username, '+', 1);
    v_username := lower(v_username);
    v_clean_username := regexp_replace(v_username, '[^a-z0-9]', '', 'g');
    IF v_clean_username = '' THEN
      RAISE EXCEPTION 'Email username cannot be empty';
    END IF;
    NEW.normalized_email := v_clean_username || '@gmail.com';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_canonicalize_user_email ON users;
CREATE TRIGGER trg_canonicalize_user_email
BEFORE INSERT OR UPDATE OF email, normalized_email ON users
FOR EACH ROW
EXECUTE FUNCTION canonicalize_user_email();
ALTER TABLE users DROP CONSTRAINT IF EXISTS check_users_gmail_only;
ALTER TABLE users ADD CONSTRAINT check_users_gmail_only
  CHECK (normalized_email IS NULL OR normalized_email ~ '^[a-z0-9]+@gmail\.com$');
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_normalized_email ON users(normalized_email);
SEEDSQL
chown -R postgres:postgres "$STAGE"

setup_cluster /var/lib/postgresql/16/test-allow-fbuploadpro-a 55445 testfbuploadpro

PSQL_A_FILE "$STAGE/seed.sql"

# --- (0) reproduce the bug on the pre-migration schema -----------------------
if PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-insert.out 2>&1
insert into public.users (id, email, name)
values ('11111111-1111-1111-1111-111111111111', 'mpersonal@fbuploadpro.com', 'M Personal');
SQL
then
  echo "BUG-REPRO CHECK FAILED: @fbuploadpro.com INSERT succeeded before the migration"
  exit 1
fi
grep -q 'Only @gmail.com or @googlemail.com email addresses are permitted' /tmp/allow-fbuploadpro-insert.out || {
  echo "BUG-REPRO CHECK FAILED: @fbuploadpro.com INSERT failed, but not on the Gmail-only exception:"
  cat /tmp/allow-fbuploadpro-insert.out
  exit 1
}
echo "pre-migration: @fbuploadpro.com INSERT fails with the Gmail-only exception (bug reproduced)"

# Direct normalized_email update path is blocked the same way. It only
# reaches the normalized_email branch when the row's email is NULL
# (with an email set, the trigger recomputes from email instead) —
# so the probe row carries email NULL.
PSQL_A <<'SQL'
insert into public.users (id, email, name)
values ('22222222-2222-2222-2222-222222222222', NULL, 'Null Email User');
SQL
if PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-norm-update.out 2>&1
update public.users set normalized_email = 'mpersonal@fbuploadpro.com'
 where id = '22222222-2222-2222-2222-222222222222';
SQL
then
  echo "BUG-REPRO CHECK FAILED: direct normalized_email UPDATE to @fbuploadpro.com succeeded before the migration"
  exit 1
fi
grep -q 'Only @gmail.com or @googlemail.com email addresses are permitted' /tmp/allow-fbuploadpro-norm-update.out || {
  echo "BUG-REPRO CHECK FAILED: normalized_email UPDATE failed, but not on the Gmail-only exception:"
  cat /tmp/allow-fbuploadpro-norm-update.out
  exit 1
}
echo "pre-migration: direct normalized_email UPDATE to @fbuploadpro.com fails the same way"

# Gmail canonicalization works exactly as today (pre-state to preserve).
PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-gmail-before.out
insert into public.users (id, email, name)
values ('33333333-3333-3333-3333-333333333333', 'Test.User+tag@Gmail.com', 'Gmail User');
select 'norm:' || normalized_email from public.users
 where id = '33333333-3333-3333-3333-333333333333';
SQL
grep -q "norm:testuser@gmail.com" /tmp/allow-fbuploadpro-gmail-before.out || {
  echo "BUG-REPRO CHECK FAILED: Gmail canonicalization is not testuser@gmail.com before the migration:"
  cat /tmp/allow-fbuploadpro-gmail-before.out
  exit 1
}
echo "pre-migration: Gmail insert canonicalizes to testuser@gmail.com"

# --- (1) apply the forward migration twice (idempotent) ----------------------
PSQL_A_FILE "$STAGE/forward.sql"
PSQL_A_FILE "$STAGE/forward.sql"
echo "forward migration applied twice (idempotent)"

PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-after.out
select 'checkdef:' || pg_get_constraintdef(oid) from pg_constraint
 where conname = 'check_users_gmail_only' and conrelid = 'public.users'::regclass;
select 'checkcount:' || count(*) from pg_constraint
 where conname = 'check_users_gmail_only' and conrelid = 'public.users'::regclass;
select 'fn_has_domain:' || (pg_get_functiondef(oid) like '%fbuploadpro.com%') from pg_proc
 where proname = 'canonicalize_user_email';
SQL
grep -q "checkdef:.*fbuploadpro" /tmp/allow-fbuploadpro-after.out || {
  echo "MIGRATION CHECK FAILED: CHECK does not accept fbuploadpro.com:"
  cat /tmp/allow-fbuploadpro-after.out
  exit 1
}
grep -q "checkdef:.*gmail" /tmp/allow-fbuploadpro-after.out || {
  echo "MIGRATION CHECK FAILED: CHECK lost the Gmail pattern:"
  cat /tmp/allow-fbuploadpro-after.out
  exit 1
}
grep -q "checkcount:1" /tmp/allow-fbuploadpro-after.out || {
  echo "MIGRATION CHECK FAILED: check_users_gmail_only exists more than once"
  cat /tmp/allow-fbuploadpro-after.out
  exit 1
}
grep -q "fn_has_domain:t" /tmp/allow-fbuploadpro-after.out || {
  echo "MIGRATION CHECK FAILED: function does not admit fbuploadpro.com:"
  cat /tmp/allow-fbuploadpro-after.out
  exit 1
}
echo "CHECK accepts fbuploadpro.com (exactly once, Gmail pattern kept); function admits the domain"

# --- (2) @fbuploadpro.com inserts succeed, normalized as-is ------------------
PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-row1.out
insert into public.users (id, email, name)
values ('11111111-1111-1111-1111-111111111111', 'mpersonal@fbuploadpro.com', 'M Personal');
select 'norm:' || normalized_email from public.users
 where id = '11111111-1111-1111-1111-111111111111';
SQL
grep -q "norm:mpersonal@fbuploadpro.com" /tmp/allow-fbuploadpro-row1.out || {
  echo "FBUploadPro CHECK FAILED: normalized_email is not mpersonal@fbuploadpro.com:"
  cat /tmp/allow-fbuploadpro-row1.out
  exit 1
}
echo "@fbuploadpro.com INSERT succeeds; normalized_email kept as-is"

PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-row2.out
insert into public.users (id, email, name)
values ('44444444-4444-4444-4444-444444444444', 'First.Last+Tag@FbuploadPro.COM', 'Dotted User');
select 'norm:' || normalized_email from public.users
 where id = '44444444-4444-4444-4444-444444444444';
SQL
grep -q "norm:first.last+tag@fbuploadpro.com" /tmp/allow-fbuploadpro-row2.out || {
  echo "FBUploadPro CHECK FAILED: dotted address was not kept as-is (lowercased, dots kept):"
  cat /tmp/allow-fbuploadpro-row2.out
  exit 1
}
echo "dotted + mixed-case @fbuploadpro.com INSERT succeeds; normalized lowercased with dots kept"

PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-norm2.out
update public.users set normalized_email = 'admin@fbuploadpro.com'
 where id = '22222222-2222-2222-2222-222222222222';
select 'norm:' || normalized_email from public.users
 where id = '22222222-2222-2222-2222-222222222222';
SQL
grep -q "norm:admin@fbuploadpro.com" /tmp/allow-fbuploadpro-norm2.out || {
  echo "FBUploadPro CHECK FAILED: direct normalized_email UPDATE to @fbuploadpro.com did not stick:"
  cat /tmp/allow-fbuploadpro-norm2.out
  exit 1
}
echo "direct normalized_email UPDATE to @fbuploadpro.com succeeds (email-NULL row)"

PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-norm3.out
insert into public.users (id, email, normalized_email, name)
values ('66666666-6666-6666-6666-666666666665', NULL, 'Ops@Fbuploadpro.COM', 'Direct Normalized User');
select 'norm:' || normalized_email from public.users
 where id = '66666666-6666-6666-6666-666666666665';
SQL
grep -q "norm:ops@fbuploadpro.com" /tmp/allow-fbuploadpro-norm3.out || {
  echo "FBUploadPro CHECK FAILED: direct normalized_email INSERT was not kept as-is:"
  cat /tmp/allow-fbuploadpro-norm3.out
  exit 1
}
echo "direct normalized_email INSERT on an email-NULL row succeeds, kept as-is"

PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-gmail-after.out
insert into public.users (id, email, name)
values ('55555555-5555-5555-5555-555555555555', 'Other.User+tag@Gmail.com', 'Gmail User 2');
select 'norm:' || normalized_email from public.users
 where id = '55555555-5555-5555-5555-555555555555';
SQL
grep -q "norm:otheruser@gmail.com" /tmp/allow-fbuploadpro-gmail-after.out || {
  echo "GMAIL CHECK FAILED: Gmail canonicalization changed after the migration:"
  cat /tmp/allow-fbuploadpro-gmail-after.out
  exit 1
}
echo "Gmail canonicalization byte-identical after the migration (otheruser@gmail.com)"

# --- (3) other domains still rejected; empty username rejected ---------------
if PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-yahoo.out 2>&1
insert into public.users (id, email, name)
values ('66666666-6666-6666-6666-666666666666', 'someone@yahoo.com', 'Yahoo User');
SQL
then
  echo "NEGATIVE CHECK FAILED: @yahoo.com INSERT was accepted"
  exit 1
fi
grep -q 'Only @gmail.com or @googlemail.com email addresses are permitted' /tmp/allow-fbuploadpro-yahoo.out || {
  echo "NEGATIVE CHECK FAILED: @yahoo.com failed, but not on the unchanged exception:"
  cat /tmp/allow-fbuploadpro-yahoo.out
  exit 1
}
echo "@yahoo.com still rejected with the unchanged message"

if PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-example.out 2>&1
insert into public.users (id, email, name)
values ('77777777-7777-7777-7777-777777777777', 'someone@example.com', 'Example User');
SQL
then
  echo "NEGATIVE CHECK FAILED: @example.com INSERT was accepted"
  exit 1
fi
grep -q 'Only @gmail.com or @googlemail.com email addresses are permitted' /tmp/allow-fbuploadpro-example.out || {
  echo "NEGATIVE CHECK FAILED: @example.com failed, but not on the unchanged exception:"
  cat /tmp/allow-fbuploadpro-example.out
  exit 1
}
echo "@example.com still rejected with the unchanged message"

if PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-empty.out 2>&1
insert into public.users (id, email, name)
values ('88888888-8888-8888-8888-888888888888', '@fbuploadpro.com', 'Empty User');
SQL
then
  echo "NEGATIVE CHECK FAILED: empty @fbuploadpro.com username was accepted"
  exit 1
fi
grep -q 'Email username cannot be empty' /tmp/allow-fbuploadpro-empty.out || {
  echo "NEGATIVE CHECK FAILED: empty username failed, but not on the empty-username exception:"
  cat /tmp/allow-fbuploadpro-empty.out
  exit 1
}
echo "empty @fbuploadpro.com username rejected with 'Email username cannot be empty'"

# --- (4) rollback proof: remove the fixture @fbuploadpro.com rows, apply
# reverse, fbuploadpro fails again -----------------------------------------
# (The reverse migration deliberately refuses to re-add the Gmail-only
# CHECK while any @fbuploadpro.com row exists — same stop as the spec 248
# reverse, which requires the row restored first.)
PSQL_A <<'SQL'
delete from public.users where id in (
  '11111111-1111-1111-1111-111111111111',
  '44444444-4444-4444-4444-444444444444',
  '22222222-2222-2222-2222-222222222222',
  '66666666-6666-6666-6666-666666666665'
);
SQL
PSQL_A_FILE "$STAGE/reverse.sql"
PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-rollback.out
select 'checkdef:' || pg_get_constraintdef(oid) from pg_constraint
 where conname = 'check_users_gmail_only' and conrelid = 'public.users'::regclass;
SQL
grep -q "checkdef:.*gmail" /tmp/allow-fbuploadpro-rollback.out || {
  echo "ROLLBACK CHECK FAILED: CHECK lost the Gmail pattern after the reverse migration:"
  cat /tmp/allow-fbuploadpro-rollback.out
  exit 1
}
if grep -q "checkdef:.*fbuploadpro" /tmp/allow-fbuploadpro-rollback.out; then
  echo "ROLLBACK CHECK FAILED: CHECK still accepts fbuploadpro.com after the reverse migration:"
  cat /tmp/allow-fbuploadpro-rollback.out
  exit 1
fi
if PSQL_A <<'SQL' > /tmp/allow-fbuploadpro-rollback-fail.out 2>&1
insert into public.users (id, email, name)
values ('99999999-9999-9999-9999-999999999999', 'late@fbuploadpro.com', 'Late User');
SQL
then
  echo "ROLLBACK CHECK FAILED: @fbuploadpro.com INSERT succeeded after the reverse migration"
  exit 1
fi
grep -q 'Only @gmail.com or @googlemail.com email addresses are permitted' /tmp/allow-fbuploadpro-rollback-fail.out || {
  echo "ROLLBACK CHECK FAILED: @fbuploadpro.com INSERT failed after reverse, but not on the Gmail-only exception:"
  cat /tmp/allow-fbuploadpro-rollback-fail.out
  exit 1
}
echo "rollback check passed: CHECK back to Gmail-only, @fbuploadpro.com INSERT fails again"

echo "ALL ALLOW-FBUploadPro-EMAIL-DOMAIN MIGRATION TESTS PASSED"
