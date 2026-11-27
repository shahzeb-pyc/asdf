-- Migration: 20261127190200_allow_fbuploadpro_email_domain.sql
-- Description: Allow @fbuploadpro.com email addresses in canonicalize_user_email() (spec 261).
-- The Gmail-only rule blocked admin-created internal accounts: creating
-- mpersonal@fbuploadpro.com succeeded in Auth but the public.users INSERT
-- failed with 'Only @gmail.com or @googlemail.com email addresses are
-- permitted'. This migration admits fbuploadpro.com alongside gmail.com /
-- googlemail.com in both trigger branches and in the CHECK constraint.
-- Gmail behaviour is byte-identical; a @fbuploadpro.com address is kept
-- as-is (lowercased, trimmed) because dots are meaningful outside Gmail.
-- No existing rows are touched. The user-facing rejection message is
-- unchanged (the frontend must not mention this).

-- 1. Update the PL/pgSQL trigger function to admit fbuploadpro.com
CREATE OR REPLACE FUNCTION canonicalize_user_email()
RETURNS TRIGGER AS $$
DECLARE
  v_raw_email TEXT;
  v_username TEXT;
  v_domain TEXT;
  v_clean_username TEXT;
BEGIN
  -- If email is provided/modified, compute canonicalized email
  IF NEW.email IS NOT NULL THEN
    v_raw_email := trim(NEW.email);
    v_username := split_part(v_raw_email, '@', 1);
    v_domain := lower(split_part(v_raw_email, '@', 2));

    -- Enforce the domain restriction: Gmail / Googlemail plus the internal
    -- fbuploadpro.com domain (spec 261). The user-facing message is unchanged.
    IF v_domain NOT IN ('gmail.com', 'googlemail.com', 'fbuploadpro.com') THEN
      RAISE EXCEPTION 'Only @gmail.com or @googlemail.com email addresses are permitted';
    END IF;

    IF v_domain IN ('gmail.com', 'googlemail.com') THEN
      -- Canonicalize: strip plus subaddressing (+), lowercase, and strip non-alphanumeric characters
      v_username := split_part(v_username, '+', 1);
      v_username := lower(v_username);
      v_clean_username := regexp_replace(v_username, '[^a-z0-9]', '', 'g');

      IF v_clean_username = '' THEN
        RAISE EXCEPTION 'Email username cannot be empty';
      END IF;

      NEW.normalized_email := v_clean_username || '@gmail.com';
    ELSE
      -- Internal domain: keep the address as-is (lowercased, trimmed).
      -- Dots are meaningful outside Gmail, so no dot-stripping or cleaning.
      IF v_username = '' THEN
        RAISE EXCEPTION 'Email username cannot be empty';
      END IF;

      NEW.normalized_email := lower(v_raw_email);
    END IF;
  ELSIF NEW.normalized_email IS NOT NULL THEN
    -- If normalized_email was updated directly without email, ensure it is also canonicalized
    v_raw_email := trim(NEW.normalized_email);
    v_username := split_part(v_raw_email, '@', 1);
    v_domain := lower(split_part(v_raw_email, '@', 2));

    -- Enforce the domain restriction: Gmail / Googlemail plus the internal
    -- fbuploadpro.com domain (spec 261). The user-facing message is unchanged.
    IF v_domain NOT IN ('gmail.com', 'googlemail.com', 'fbuploadpro.com') THEN
      RAISE EXCEPTION 'Only @gmail.com or @googlemail.com email addresses are permitted';
    END IF;

    IF v_domain IN ('gmail.com', 'googlemail.com') THEN
      v_username := split_part(v_username, '+', 1);
      v_username := lower(v_username);
      v_clean_username := regexp_replace(v_username, '[^a-z0-9]', '', 'g');

      IF v_clean_username = '' THEN
        RAISE EXCEPTION 'Email username cannot be empty';
      END IF;

      NEW.normalized_email := v_clean_username || '@gmail.com';
    ELSE
      -- Internal domain: keep the address as-is (lowercased, trimmed).
      -- Dots are meaningful outside Gmail, so no dot-stripping or cleaning.
      IF v_username = '' THEN
        RAISE EXCEPTION 'Email username cannot be empty';
      END IF;

      NEW.normalized_email := lower(v_raw_email);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Re-enforce CHECK constraint on normalized_email (name kept): the Gmail
-- pattern is unchanged, and a fbuploadpro.com normalized address is accepted.
-- The fbuploadpro.com pattern is deliberately permissive (lowercase letters,
-- digits, dot, underscore, percent, plus, hyphen) so the trigger can never
-- write a value the CHECK rejects.
ALTER TABLE users DROP CONSTRAINT IF EXISTS check_users_gmail_only;
ALTER TABLE users ADD CONSTRAINT check_users_gmail_only
  CHECK (normalized_email IS NULL OR normalized_email ~ '^[a-z0-9]+@gmail\.com$' OR normalized_email ~ '^[a-z0-9._%+-]+@fbuploadpro\.com$');
