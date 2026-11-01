-- Migration: 20261101150000_signup_profile_rpc.sql
-- Description: Fix signup failing with "new row violates row-level security
-- policy for table users".
--
-- Root cause: the signup route creates the public.users profile row with a
-- PostgREST write issued before any session exists. public.users has RLS
-- enabled and only one policy (users_self_access, FOR ALL TO authenticated
-- WITH CHECK auth.uid() = id, from 20261013140000) and no policy for anon,
-- so the write succeeds only while the server's Supabase client actually
-- holds the service-role key (which bypasses RLS). When that client runs
-- under a non-service key (silent anon fallback in non-production runtimes,
-- or a mis-synced key value), the upsert fails with exactly the reported
-- RLS error, while login still works (GoTrue sign-in + metadata fallback).
--
-- Fix: move profile creation into the database, behind two narrowly
-- validated SECURITY DEFINER functions called by the server route. The
-- route's key no longer decides whether signup can create its row.
-- This deliberately does NOT widen RLS: no policy is added or changed,
-- anon gets no table INSERT, and neither function accepts role/status
-- input — creation forces 'user'/'active', and the update function cannot
-- touch role, status, or referral at all. The existing guard trigger
-- (guard_users_role_status) and column REVOKEs stay in place untouched.
--
-- Direct-call threat note: these functions are EXECUTE-granted to anon
-- because the server route must be able to call them with whatever key
-- its client holds. A direct caller who already knows an unconfirmed
-- user's UUID + email could create that user's profile row with
-- attacker-chosen name/phone — but cannot obtain a session from it
-- (the OTP goes to the victim's email, and the app session requires OTP
-- verification), creation is first-writer-wins, and the guards below
-- (unconfirmed only, email match, 24h window) bound the abuse window.

-- ---------------------------------------------------------------------------
-- 1. Fresh signup: create users row + workspace row atomically.
--    Idempotent: if the profile already exists it is returned unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_signup_profile(
  p_user_id uuid,
  p_email text,
  p_name text,
  p_phone text,
  p_subdomain text,
  p_referred_by_seller_id uuid DEFAULT NULL,
  p_referred_by_code text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  email text,
  name text,
  phone text,
  role text,
  status text,
  subdomain text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
-- PL/pgSQL: this function RETURNS TABLE with output columns (id, email,
-- ...) of the same names as public.users columns. Without this directive,
-- SELECT * and other unqualified column references are ambiguous with
-- the output variables. Column resolution is safe here because the body
-- never reads the output variables directly (values leave only via
-- RETURN QUERY); all variable references use distinct p_/v_ names.
#variable_conflict use_column
DECLARE
  v_auth_email text;
  v_auth_confirmed timestamptz;
  v_auth_created timestamptz;
  v_existing public.users%ROWTYPE;
  v_ws_subdomain text;
  v_candidate text;
  v_attempt int := 0;
  v_referral_ok boolean := false;
BEGIN
  -- Guard 1: the auth user must exist.
  SELECT a.email, a.email_confirmed_at, a.created_at
    INTO v_auth_email, v_auth_confirmed, v_auth_created
    FROM auth.users a
   WHERE a.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signup profile: auth user not found' USING ERRCODE = 'P0001';
  END IF;

  -- Guard 2: the profile email must be the auth user's email.
  IF lower(v_auth_email) <> lower(p_email) THEN
    RAISE EXCEPTION 'signup profile: email mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- Guard 3: only unconfirmed, freshly created auth users (the signup
  -- moment). A confirmed account can never be created or overwritten
  -- through this function.
  IF v_auth_confirmed IS NOT NULL THEN
    RAISE EXCEPTION 'signup profile: auth user already confirmed' USING ERRCODE = 'P0001';
  END IF;
  IF v_auth_created < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'signup profile: auth user too old' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency: first writer wins; a re-call returns the existing row.
  SELECT * INTO v_existing FROM public.users u WHERE u.id = p_user_id;
  IF FOUND THEN
    SELECT w.subdomain INTO v_ws_subdomain
      FROM public.workspaces w
     WHERE w.owner_id = p_user_id
     ORDER BY w.created_at ASC
     LIMIT 1;
    RETURN QUERY SELECT
      v_existing.id,
      v_existing.email::text,
      v_existing.name::text,
      v_existing.phone::text,
      v_existing.role::text,
      v_existing.status::text,
      COALESCE(v_ws_subdomain, p_subdomain);
    RETURN;
  END IF;

  -- Referral is re-validated here (defence in depth; the route resolves
  -- the code first). On mismatch the row is created WITHOUT attribution
  -- rather than failing signup.
  IF p_referred_by_seller_id IS NOT NULL AND p_referred_by_code IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.referral_codes rc
       WHERE rc.seller_id = p_referred_by_seller_id
         AND rc.code = p_referred_by_code
    ) INTO v_referral_ok;
  END IF;

  INSERT INTO public.users (
    id, email, normalized_email, name, phone, role, status,
    referred_by_seller_id, referred_by_code
  ) VALUES (
    p_user_id, p_email, p_email, p_name, p_phone, 'user', 'active',
    CASE WHEN v_referral_ok THEN p_referred_by_seller_id ELSE NULL END,
    CASE WHEN v_referral_ok THEN p_referred_by_code ELSE NULL END
  )
  ON CONFLICT (id) DO NOTHING;
  -- Re-read with a qualified select (no RETURNING clause: RETURNING
  -- column names would be ambiguous with this function's RETURNS TABLE
  -- output columns of the same names). This also covers the race where
  -- a concurrent create won the ON CONFLICT.
  SELECT * INTO v_existing FROM public.users u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signup profile: profile creation failed' USING ERRCODE = 'P0001';
  END IF;

  -- Workspace: the route's resolved subdomain first, random-suffix
  -- retries on unique violation (same policy as the old code path).
  SELECT w.subdomain INTO v_ws_subdomain
    FROM public.workspaces w
   WHERE w.owner_id = p_user_id
   ORDER BY w.created_at ASC
   LIMIT 1;

  IF v_ws_subdomain IS NULL THEN
    v_candidate := COALESCE(NULLIF(p_subdomain, ''), split_part(p_email, '@', 1));
    WHILE v_attempt < 5 LOOP
      BEGIN
        INSERT INTO public.workspaces (owner_id, name, subdomain)
        VALUES (
          p_user_id,
          COALESCE(NULLIF(p_name, ''), split_part(p_email, '@', 1)),
          v_candidate
        );
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_attempt := v_attempt + 1;
        v_candidate := COALESCE(NULLIF(p_subdomain, ''), split_part(p_email, '@', 1))
          || '-' || substr(md5(random()::text), 1, 6);
      END;
    END LOOP;
    -- Confirm with a qualified select (same RETURNING-ambiguity reason
    -- as above); a concurrent winner's row counts as success.
    SELECT w.subdomain INTO v_ws_subdomain
      FROM public.workspaces w
     WHERE w.owner_id = p_user_id
     ORDER BY w.created_at ASC
     LIMIT 1;
    IF v_ws_subdomain IS NULL THEN
      RAISE EXCEPTION 'signup profile: workspace provisioning failed' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_existing.id,
    v_existing.email::text,
    v_existing.name::text,
    v_existing.phone::text,
    v_existing.role::text,
    v_existing.status::text,
    v_ws_subdomain;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Re-signup of an unconfirmed account: update name/phone only.
--    Never touches role, status, or referral. Raises when there is no
--    profile row or the auth user is already confirmed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_unconfirmed_signup_profile(
  p_user_id uuid,
  p_email text,
  p_name text,
  p_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_auth_email text;
  v_auth_confirmed timestamptz;
  v_row_count int;
BEGIN
  SELECT a.email, a.email_confirmed_at
    INTO v_auth_email, v_auth_confirmed
    FROM auth.users a
   WHERE a.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signup profile: auth user not found' USING ERRCODE = 'P0001';
  END IF;
  IF lower(v_auth_email) <> lower(p_email) THEN
    RAISE EXCEPTION 'signup profile: email mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_auth_confirmed IS NOT NULL THEN
    RAISE EXCEPTION 'signup profile: auth user already confirmed' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.users u
     SET name = p_name,
         phone = p_phone,
         updated_at = now()
   WHERE u.id = p_user_id
     AND lower(u.email) = lower(p_email);
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count = 0 THEN
    RAISE EXCEPTION 'signup profile: profile not found' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Least privilege: only the roles the server route can run as.
REVOKE ALL ON FUNCTION public.create_signup_profile(uuid, text, text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_signup_profile(uuid, text, text, text, text, uuid, text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_unconfirmed_signup_profile(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_unconfirmed_signup_profile(uuid, text, text, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.create_signup_profile(uuid, text, text, text, text, uuid, text) IS
  'Signup profile creation (fix 2026-11-01): creates the public.users row + workspace row for a just-created, unconfirmed auth user. Forces role user / status active; never accepts role/status input; idempotent first-writer-wins.';
COMMENT ON FUNCTION public.update_unconfirmed_signup_profile(uuid, text, text, text) IS
  'Unconfirmed re-signup detail update (fix 2026-11-01): updates name/phone only for an unconfirmed auth user. Cannot touch role, status, or referral.';
