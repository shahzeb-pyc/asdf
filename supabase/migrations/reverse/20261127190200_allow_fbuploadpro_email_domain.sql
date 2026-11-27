-- Reverse migration for 20261127190200_allow_fbuploadpro_email_domain.sql (spec 261).
-- Restores the Gmail-only canonicalize_user_email() and the Gmail-only
-- CHECK constraint check_users_gmail_only, exactly as defined in
-- 20261014025531_fix_normalized_email_trigger_and_check_constraint.sql.
-- Only clean BEFORE any @fbuploadpro.com row exists: the CHECK re-add
-- fails loudly while any row carries a normalized_email outside the
-- Gmail pattern. Rolling back after a real @fbuploadpro.com account
-- exists is a deliberate stop, not a degraded mode.
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

    -- Enforce strict Gmail-only domain restriction
    IF v_domain NOT IN ('gmail.com', 'googlemail.com') THEN
      RAISE EXCEPTION 'Only @gmail.com or @googlemail.com email addresses are permitted';
    END IF;

    -- Canonicalize: strip plus subaddressing (+), lowercase, and strip non-alphanumeric characters
    v_username := split_part(v_username, '+', 1);
    v_username := lower(v_username);
    v_clean_username := regexp_replace(v_username, '[^a-z0-9]', '', 'g');

    IF v_clean_username = '' THEN
      RAISE EXCEPTION 'Email username cannot be empty';
    END IF;

    NEW.normalized_email := v_clean_username || '@gmail.com';
  ELSIF NEW.normalized_email IS NOT NULL THEN
    -- If normalized_email was updated directly without email, ensure it is also canonicalized
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

ALTER TABLE users DROP CONSTRAINT IF EXISTS check_users_gmail_only;
ALTER TABLE users ADD CONSTRAINT check_users_gmail_only
  CHECK (normalized_email IS NULL OR normalized_email ~ '^[a-z0-9]+@gmail\.com$');
