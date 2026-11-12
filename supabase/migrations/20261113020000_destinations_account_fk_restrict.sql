-- Spec 174 PR 2A — destinations.account_id FK CASCADE -> RESTRICT.
--
-- Owner decision (spec §9 Q2, decided 2026-11-12): when an account is
-- deleted/disconnected, the account row is RETAINED as a disconnected
-- record (never deleted), and every section's copy of every page
-- becomes a disconnected stub (identity + followers + section kept,
-- all working data removed). The RESTRICT backstop makes a hard DELETE
-- of a social_accounts row fail loudly while any destinations row
-- still references it, so the application can never silently
-- cascade-delete a page again. The three account-disconnect routes
-- (Facebook, Instagram, Threads) are rewritten in this same PR to
-- disconnect + strip instead of deleting; after this PR nothing in
-- the app deletes a social_accounts row (verified by grep at build
-- time: the only DELETEs of social_accounts were the three
-- disconnect routes).
--
-- Live pre-build check (2026-11-13 ~01:44 PKT, read-only): the live
-- constraint is `destinations_account_id_fkey`, FOREIGN KEY
-- (account_id) REFERENCES social_accounts(id) ON DELETE CASCADE;
-- live max migration version 20261112180000 (1B); destinations 855
-- (schedule 152, adu 671, mirror 30, NULL 2 — the two known
-- stragglers for the Phase 4 backfill).

-- The constraint name is Postgres's default for this FK (created by
-- 20261022120000_unified_schema_migration.sql) and was verified live
-- on prod before this migration was written. If the name ever differs
-- the DROP fails loudly here instead of silently doing nothing.
ALTER TABLE public.destinations
  DROP CONSTRAINT destinations_account_id_fkey,
  ADD CONSTRAINT destinations_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.social_accounts(id) ON DELETE RESTRICT;

-- Assertion: the FK now restricts (confdeltype 'r' = RESTRICT).
-- 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL.
DO $$
DECLARE
  v_rule text;
BEGIN
  SELECT confdeltype INTO v_rule FROM pg_constraint
  WHERE conrelid = 'public.destinations'::regclass
    AND conname = 'destinations_account_id_fkey';
  IF v_rule IS NULL THEN
    RAISE EXCEPTION '2A: destinations_account_id_fkey missing after re-add';
  END IF;
  IF v_rule <> 'r' THEN
    RAISE EXCEPTION '2A: destinations_account_id_fkey delete rule is %, expected r (RESTRICT)', v_rule;
  END IF;
END $$;
