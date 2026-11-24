-- ADU intake catch-up window (spec 245): make the 23505 dedupe real.
--
-- The mint code's `23505` "already intaken for this slot" branch in
-- apps/worker/src/adu-tick.ts had no backing unique index on prod, so
-- the branch was effectively dead and two ticks covering the same slot
-- could mint twice. The index IS defined in
-- 20261030120001_adu.sql (since the original ADU feature, Oct 30) but
-- is ABSENT on prod newdb — verified live 2026-11-24
-- (pg_indexes lists only the pkey and the two non-unique indexes).
-- No migration ever dropped it, so it was most likely lost in the
-- Nov 22–23 Supabase move restore. This migration re-creates it.
-- Same name and definition as the original, so a fresh database (where
-- the old migration creates it) is a no-op, and prod (where it is
-- missing) gains it.
--
-- Pre-checked read-only on prod newdb 2026-11-24 (ref
-- chbtrophjeavksryvglv): 40,536 rows in adu_posting_jobs, ZERO
-- duplicate (config_id, schedule_slot_at) groups, zero NULL slots,
-- all slots minute-aligned — the index applies cleanly. If duplicates
-- ever appear, this statement fails loudly instead of silently
-- dropping rows; never delete data to make it fit.
create unique index if not exists idx_adu_jobs_config_slot_unique
  on public.adu_posting_jobs (config_id, schedule_slot_at)
  where schedule_slot_at is not null;
