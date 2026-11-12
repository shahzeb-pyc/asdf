-- Reverse of 20261113020000_destinations_account_fk_restrict.sql
-- (spec 174 PR 2A). Restores ON DELETE CASCADE on
-- destinations.account_id. The account-disconnect routes rewritten
-- in 2A (disconnect + strip, never delete) are NOT reverted by this
-- migration — reversing the FK alone re-opens the cascade path, so
-- this reverse is for a full 2A rollback only, together with the
-- code revert.
ALTER TABLE public.destinations
  DROP CONSTRAINT destinations_account_id_fkey,
  ADD CONSTRAINT destinations_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;

DO $$
DECLARE
  v_rule text;
BEGIN
  SELECT confdeltype INTO v_rule FROM pg_constraint
  WHERE conrelid = 'public.destinations'::regclass
    AND conname = 'destinations_account_id_fkey';
  IF v_rule IS NULL THEN
    RAISE EXCEPTION '2A reverse: destinations_account_id_fkey missing after re-add';
  END IF;
  IF v_rule <> 'c' THEN
    RAISE EXCEPTION '2A reverse: destinations_account_id_fkey delete rule is %, expected c (CASCADE)', v_rule;
  END IF;
END $$;
