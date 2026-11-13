-- Reverse of 20261113050000_subscription_usage_section.sql
-- (spec 174 PR 2B). Drops the section column and restores the old
-- unique key (user_id, platform, destination_key). For a full 2B
-- rollback only, together with the code revert: old code's unique
-- key is (user_id, platform, destination_key), so reverting the
-- code without reverting the key would leave two rows sharing a
-- destination key (one per section) that old code's INSERT ...
-- ON CONFLICT cannot resolve. Rows created in two sections for
-- one page collapse back to one row per (user, platform, key) on
-- revert — the earliest row wins, the others are deleted — which
-- is the pre-2B "counts once" shape. That data loss on rollback
-- is inherent to the revert (the section is what distinguished
-- the rows); it is why the reverse is only run with the code
-- revert, never alone.
DELETE FROM public.subscription_usage u
USING public.subscription_usage u2
WHERE u.user_id = u2.user_id
  AND u.platform = u2.platform
  AND u.destination_key = u2.destination_key
  AND (u.created_at > u2.created_at
    OR (u.created_at = u2.created_at AND u.id > u2.id));

DROP INDEX IF EXISTS public.idx_subscription_usage_user_platform_section_destination;
DROP INDEX IF EXISTS public.idx_subscription_usage_user_platform_section;
ALTER TABLE public.subscription_usage
  DROP CONSTRAINT IF EXISTS subscription_usage_section_check,
  DROP COLUMN IF EXISTS section;
CREATE UNIQUE INDEX idx_subscription_usage_user_platform_destination
  ON public.subscription_usage (user_id, platform, destination_key);

DO $$
DECLARE
  v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'subscription_usage'
    AND column_name = 'section';
  IF v <> 0 THEN
    RAISE EXCEPTION '2B reverse: section column still present';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'subscription_usage'
      AND indexname = 'idx_subscription_usage_user_platform_destination'
  ) THEN
    RAISE EXCEPTION '2B reverse: old unique index not restored';
  END IF;
  SELECT count(*) INTO v FROM (
    SELECT user_id, platform, destination_key
    FROM public.subscription_usage
    GROUP BY user_id, platform, destination_key
    HAVING count(*) > 1
  ) dup;
  IF v <> 0 THEN
    RAISE EXCEPTION '2B reverse: % (user, platform, key) groups still duplicated', v;
  END IF;
END $$;
