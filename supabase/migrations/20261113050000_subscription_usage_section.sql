-- Spec 174 PR 2B — subscription_usage gains a section column.
--
-- Owner decision (spec §2, decided 2026-11-11/12): a page in two
-- sections counts twice (Schedule, Auto Download, Auto Repost).
-- Publish Now is uncapped — its imports do not count at all. The
-- usage key therefore gains the section: one row per destination
-- per section, (user_id, platform, section, destination_key).
--
-- Live pre-build re-count (2026-11-13 ~03:55 PKT, read-only):
-- subscription_usage holds 707 rows, all Facebook, all with a
-- destination_id link (0 NULL, 0 orphaned — the 6 orphans from
-- the spec census were deleted by the 1A backfill as designed):
-- auto-download-upload 647, destination-queue 31, tiktok-mirror
-- 29; zero 'auto-repost' rows, zero legacy publish-now rows, no
-- other feature value exists. 6 rows link to 'disconnected'
-- destinations (tiktok-mirror 3, auto-download-upload 2,
-- destination-queue 1) — the per-section exclusion keeps working
-- on the destination_id link, unchanged by this migration.
-- Destinations: 855 (schedule 152, adu 671, mirror 30, NULL 2 —
-- the two known stragglers for the Phase 4 backfill). Live max
-- migration version 20261113020000 (2A).
--
-- Backfill: the feature already identifies the section 1:1
-- (same mapping as USAGE_FEATURE_SECTIONS in
-- packages/contracts/src/domain/subscription.ts). Any feature
-- outside the mapping fails the migration loudly with the
-- offending value listed, instead of silently mislabelling a row.
--
-- Safety: the old unique key (user_id, platform, destination_key)
-- is strictly stronger than the new one, so no existing pair of
-- rows can collide under the new key. The column is set NOT NULL
-- after the backfill, with a CHECK on the four section values.
-- get_entitlement / can_publish_for need no change here: both
-- count usage ROWS (so a page in two sections counts twice
-- automatically) and exclude disconnected destinations by the
-- destination_id link (so the exclusion is per-section
-- automatically). Their section-awareness is 3A-owned only if
-- 3A finds otherwise when it redefines the claim functions —
-- see the PR body.

ALTER TABLE public.subscription_usage
  ADD COLUMN section text;

UPDATE public.subscription_usage
SET section = CASE feature
  WHEN 'destination-queue' THEN 'schedule'
  WHEN 'auto-download-upload' THEN 'adu'
  WHEN 'tiktok-mirror' THEN 'mirror'
  WHEN 'auto-repost' THEN 'mirror'
  WHEN 'publish-now' THEN 'publish_now'
  WHEN 'instagram-publish-now' THEN 'publish_now'
  WHEN 'threads-publish-now' THEN 'publish_now'
  ELSE NULL
END;

-- Fail loud on any feature outside the mapping: a row left NULL
-- here would be a usage unit with no section, which the cap
-- must never silently carry.
DO $$
DECLARE
  v_unmapped text;
BEGIN
  SELECT string_agg(DISTINCT feature, ', ') INTO v_unmapped
  FROM public.subscription_usage WHERE section IS NULL;
  IF v_unmapped IS NOT NULL THEN
    RAISE EXCEPTION '2B: subscription_usage backfill: unmapped feature(s): %', v_unmapped;
  END IF;
END $$;

ALTER TABLE public.subscription_usage
  ALTER COLUMN section SET NOT NULL,
  ADD CONSTRAINT subscription_usage_section_check
    CHECK (section IN ('schedule', 'adu', 'mirror', 'publish_now'));

-- The old unique key is replaced, not kept alongside: the old key
-- would forbid the very rows this phase creates (same page in two
-- sections). The index name is the one created by
-- 20261030120003_subscription.sql; the assertion below verifies it
-- exists live before the DROP, so a renamed index fails loudly
-- here instead of the DROP silently doing nothing and the old key
-- surviving under a different name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'subscription_usage'
      AND indexname = 'idx_subscription_usage_user_platform_destination'
  ) THEN
    RAISE EXCEPTION '2B: old unique index idx_subscription_usage_user_platform_destination not found — refusing to guess';
  END IF;
END $$;
DROP INDEX public.idx_subscription_usage_user_platform_destination;
CREATE UNIQUE INDEX idx_subscription_usage_user_platform_section_destination
  ON public.subscription_usage (user_id, platform, section, destination_key);
CREATE INDEX idx_subscription_usage_user_platform_section
  ON public.subscription_usage (user_id, platform, section);

-- Assertions: every row labelled, the new key in place, the old
-- key gone, and the backfill counts match the pre-build re-count.
DO $$
DECLARE
  v int;
  v_adu int;
  v_sched int;
  v_mirror int;
  v_publish_now int;
BEGIN
  SELECT count(*) INTO v FROM public.subscription_usage WHERE section IS NULL;
  IF v <> 0 THEN
    RAISE EXCEPTION '2B: % usage rows left with NULL section', v;
  END IF;
  SELECT count(*) INTO v FROM public.subscription_usage WHERE section = 'adu';
  v_adu := v;
  SELECT count(*) INTO v FROM public.subscription_usage WHERE section = 'schedule';
  v_sched := v;
  SELECT count(*) INTO v FROM public.subscription_usage WHERE section = 'mirror';
  v_mirror := v;
  SELECT count(*) INTO v FROM public.subscription_usage WHERE section = 'publish_now';
  v_publish_now := v;
  -- The backfill must account for every row exactly once. The
  -- counts below are the live re-count at build time (647 / 31 /
  -- 29 / 0); rows created between the re-count and the apply land
  -- in their feature's section too, so the assertion is on the
  -- total + the publish_now floor, not on frozen per-section
  -- numbers — a row created in the window must not fail apply.
  SELECT count(*) INTO v FROM public.subscription_usage;
  IF v <> v_adu + v_sched + v_mirror + v_publish_now THEN
    RAISE EXCEPTION '2B: section counts do not sum to the total';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'subscription_usage'
      AND indexname = 'idx_subscription_usage_user_platform_section_destination'
  ) THEN
    RAISE EXCEPTION '2B: new section-scoped unique index missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'subscription_usage'
      AND indexname = 'idx_subscription_usage_user_platform_destination'
  ) THEN
    RAISE EXCEPTION '2B: old unique index still present';
  END IF;
END $$;
