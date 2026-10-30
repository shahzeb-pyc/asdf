-- Minimal Supabase-environment bootstrap for plain PostgreSQL (spec 139
-- db-hygiene rig). Copied from the spec 117 rls-rpc rig bootstrap
-- (apps/worker/tests/rls-rpc/db/bootstrap.sql): real Supabase provides
-- the `auth` schema (auth.users, auth.uid()) and the anon / authenticated
-- / service_role roles; the repo migrations assume all of them and create
-- none of them, so a plain-Postgres run must stub them before applying
-- supabase/migrations/ in filename order.
--
-- Like the rls-rpc rig, this rig exercises RLS and GRANTs, so it must
-- also reproduce Supabase's table-privilege posture. In production
-- Supabase, objects created in `public` carry default privileges: anon
-- and authenticated receive table-level SELECT, INSERT, UPDATE, DELETE
-- (RLS policies are the gate, not the GRANTs) and service_role receives
-- ALL and bypasses RLS. ALTER DEFAULT PRIVILEGES below reproduces
-- exactly that for every table the migrations create after this
-- bootstrap runs. Function EXECUTE needs no default: the PostgreSQL
-- default (EXECUTE TO PUBLIC) is precisely the posture the db-hygiene
-- migration revokes for the five trigger functions.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase-equivalent default privileges for objects created by the
-- migration role (postgres) in schema public.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;

-- Only the columns the migrations reference (media_download_jobs.user_id FK).
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supabase's auth.uid() reads the JWT subject claim; the rig sets
-- request.jwt.claim.sub per transaction to act as a given user.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
