-- ADU duplicate-minting cycle, downloader half (spec adu-reel-download-claim-clear).
--
-- Mechanism (proven from live DB, 2026-11-13 ~10:10 PKT, probe
-- ~/workspace/launch-prep/probe_stale_reset_20261113.py): the downloader
-- claims a pending reel (status='processing', download_claimed_at = now()),
-- the download succeeds and mark_adu_reel_downloaded sets
-- status='downloaded' — but never cleared download_claimed_at. The
-- worker tick then claims the reel at a posting slot (status='processing';
-- the old tick claim never touched download_claimed_at, so the stale
-- download-claim timestamp survived), and the VPS downloader's per-loop
-- reset_stale_adu_reel_downloads(40) resets any 'processing' reel with
-- a non-null download_claimed_at older than 40 minutes back to 'pending'.
-- The reel is re-downloaded and re-minted at the next slot; each
-- successful re-download resets download_retries to 0, so the < 3 guard
-- never trips and the cycle is unbounded. On dead destinations the job
-- never publishes, so duplicates accumulate (up to 4x per reel, Nov 9-13)
-- and re-accumulate D (dead-head jobs) after the stopgap.
--
-- Fix: a completed download carries no outstanding claim, so
-- mark_adu_reel_downloaded now sets download_claimed_at = null. One
-- added assignment; signature unchanged, so the EXECUTE grants from
-- 20261030140000_adu_rpc_hardening.sql survive (CREATE OR REPLACE
-- preserves grants). The stale reset keeps working for genuinely
-- stalled downloads (claimed, never completed, timestamp still set);
-- the failure path already clears the timestamp
-- (mark_adu_reel_download_failed).
--
-- The worker tick's intake claim ALSO nulls download_claimed_at
-- (separate worker PR, fix/adu-publish-head-of-line), so a tick-claimed
-- reel is invisible to the stale reset regardless of this migration.
-- The two changes are independent; either alone stops the cycle,
-- together they remove the stale timestamp at both ends.
--
-- No data repair: existing duplicate rows are left alone (the stopgap
-- already parked the dead-head set; the publish loader skips them).

create or replace function public.mark_adu_reel_downloaded(
  p_reel_id uuid,
  p_media_object_key text,
  p_media_size_bytes bigint,
  p_media_content_type text,
  p_media_sha256 text,
  p_reel_caption text,
  p_media_url text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.adu_reels
  set
    status = 'downloaded',
    media_object_key = p_media_object_key,
    media_size_bytes = p_media_size_bytes,
    media_content_type = p_media_content_type,
    media_sha256 = p_media_sha256,
    media_url = coalesce(p_media_url, media_url),
    caption = coalesce(nullif(trim(p_reel_caption), ''), caption, '...'),
    downloaded_at = now(),
    download_retries = 0,
    download_claimed_at = null
  where id = p_reel_id
    and status in ('pending', 'processing');
end;
$$;
