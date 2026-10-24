-- =============================================================================
-- Migration: 20261024100000_posting_slots_unique.sql
-- Spec: 139 production-grade — item N5 (posting_slots duplicate guard)
-- Purpose:
--   The unified public.posting_slots (20261022120000 §4d) shipped WITHOUT
--   the uniqueness its legacy predecessor carried: page_queue_slots had
--   CONSTRAINT uq_page_queue_slots_user_page_time
--   UNIQUE (user_id, fb_page_id, slot_time) (20261008120004), so one slot
--   row per page per time was database-enforced. Spec 120's table summary
--   listed uniques for the other unified tables but none for
--   posting_slots, and nothing has enforced it since — two rows for the
--   same destination at the same time_of_day could coexist, and the
--   queue/claim logic would see an ambiguous posting time.
--
--   Shape: PLAIN UNIQUE (destination_id, time_of_day) over ALL rows —
--   the approved N5 shape, and legacy parity. posting_slots.is_active is
--   a toggle flipped in place (the legacy slots API updates is_active via
--   COALESCE on the existing row and removes slots with a hard DELETE);
--   it is NOT a soft-delete marker (there is no deleted_at, and no code
--   path deactivates-then-recreates). A partial index WHERE is_active
--   would therefore CHANGE the established semantics — it would allow an
--   active + inactive pair (and repeated inactive rows) at one time,
--   which the legacy constraint never allowed. The toggle-in-place +
--   hard-delete lifecycle keeps exactly one row per (destination, time).
--
--   Production safety: Shahzeb ran the duplicate census himself in the
--   Supabase dashboard on 2026-10-24 —
--     SELECT destination_id, time_of_day, COUNT(*) FROM posting_slots
--     GROUP BY 1, 2 HAVING COUNT(*) > 1
--   returned ZERO rows (no duplicate groups at all, active or inactive),
--   so this constraint applies with no data change and no dedupe.
-- No data changes. No other object is created, altered or dropped.
-- Idempotent: the DO block swallows duplicate_object (constraint name
-- taken) and duplicate_table (42P07 — the constraint's backing index
-- relation name taken, the error a re-applied ADD CONSTRAINT actually
-- raises), so re-applying this file (rig idempotency runs) exits clean.
-- =============================================================================

DO $$
BEGIN
  ALTER TABLE public.posting_slots
    ADD CONSTRAINT uq_posting_slots_destination_time
    UNIQUE (destination_id, time_of_day);
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
