-- Creator Finder: Countik enrichment fields on saved creators.
--
-- A search now enriches every creator with Countik user data and
-- saves that data as it was at search time, so the Saved tab can
-- render the enriched card from stored data alone — no re-fetch
-- in Saved. Old rows are untouched: countik_enriched defaults to
-- false, every new column defaults to NULL, and the Saved tab
-- renders old rows exactly as before (stored follower/verified
-- when present, else the no-data variant). No backfill, no rewrite.
--
-- countik_verified is deliberately separate from verified: verified
-- stays the TikWM similar-source value, countik_verified is the
-- analyze author.verified tick. countik_follower_count is likewise
-- separate from follower_count for the same reason.

ALTER TABLE public.creator_finder_saved_creators
  ADD COLUMN IF NOT EXISTS bio text NULL,
  ADD COLUMN IF NOT EXISTS countik_enriched boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS countik_follower_count bigint NULL,
  ADD COLUMN IF NOT EXISTS following_count bigint NULL,
  ADD COLUMN IF NOT EXISTS hearts_count bigint NULL,
  ADD COLUMN IF NOT EXISTS video_count integer NULL,
  ADD COLUMN IF NOT EXISTS countik_verified boolean NULL,
  ADD COLUMN IF NOT EXISTS engagement_total numeric NULL,
  ADD COLUMN IF NOT EXISTS engagement_likes numeric NULL,
  ADD COLUMN IF NOT EXISTS engagement_comments numeric NULL,
  ADD COLUMN IF NOT EXISTS engagement_shares numeric NULL,
  ADD COLUMN IF NOT EXISTS average_views bigint NULL,
  ADD COLUMN IF NOT EXISTS average_likes bigint NULL,
  ADD COLUMN IF NOT EXISTS average_comments bigint NULL,
  ADD COLUMN IF NOT EXISTS average_shares bigint NULL,
  ADD COLUMN IF NOT EXISTS hashtags text[] NULL,
  ADD COLUMN IF NOT EXISTS mentions text[] NULL;
