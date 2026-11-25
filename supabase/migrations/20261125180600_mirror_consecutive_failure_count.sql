-- Spec 254: persist the consecutive-failure count on mirrors.
--
-- Owner rule (2026-11-25): a failed post must never flip a mirror to
-- error on its own — only CONFIRMED errors flip it. Confirmed is
-- either a definitive Facebook error (flips at once) or the SAME
-- failure 5 times in a row. The tick counts consecutive failures
-- with the same stable signature; that count must survive across
-- ticks and worker restarts, so it lives on the mirrors row:
--   consecutive_failure_count — how many consecutive failures with
--     the current signature (0 = no streak in progress).
--   last_failure_signature    — the stable signature of the streak
--     (NULL exactly when the count is 0). Never guessed from
--     free-form error text: Graph errors use their (code, subcode)
--     pair; everything else uses a fixed key (transient,
--     resolve_failed, feed_fetch_failed, ...).
--
-- The tick resets the pair only on a successful post (or a
-- successful check, for a feed_fetch_failed streak) or when a
-- different signature arrives — never on toggle OFF/ON (the toggle
-- route updates explicit columns only and never touches these).
--
-- Safety:
-- - Purely additive: two new columns with defaults; no existing
--   column, constraint, or row changes. Every existing row gets
--   count 0 / signature NULL (no streak), which is exactly the
--   pre-migration behaviour's starting point.
-- - CHECK keeps the count non-negative; the tick only ever writes
--   values >= 0, so the constraint cannot reject a live write.
-- - Idempotent: columns are IF NOT EXISTS and the constraint is
--   added only when absent, so the migration applies twice cleanly
--   (proven by the committed .sh test).
ALTER TABLE public.mirrors
  ADD COLUMN IF NOT EXISTS consecutive_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_signature text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mirrors_consecutive_failure_count_nonnegative'
  ) THEN
    ALTER TABLE public.mirrors
      ADD CONSTRAINT mirrors_consecutive_failure_count_nonnegative
        CHECK (consecutive_failure_count >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.mirrors.consecutive_failure_count IS
  'Spec 254: consecutive failures with the same stable signature (see last_failure_signature). A mirror flips to error only on a definitive Facebook error or when this reaches 5.';
COMMENT ON COLUMN public.mirrors.last_failure_signature IS
  'Spec 254: stable signature of the current consecutive-failure streak (Graph errors: code:subcode; otherwise a fixed key). NULL exactly when consecutive_failure_count is 0.';
