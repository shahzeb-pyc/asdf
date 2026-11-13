-- Reverse of 20261113120000_mark_adu_reel_downloaded_clear_claim.sql.
-- Restores the pre-fix definition of mark_adu_reel_downloaded (the
-- download_claimed_at assignment removed). Signature unchanged, so
-- the EXECUTE grants are untouched by either direction. For a full
-- rollback only, together with the code revert of
-- fix/adu-publish-head-of-line: reverting this migration alone
-- re-opens the duplicate-minting cycle (the tick claim in that PR
-- still nulls the timestamp, so the cycle stays stopped while the
-- tick fix is deployed — but a tick-claimed reel would again carry
-- a stale claim if that PR is also reverted).
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
    download_retries = 0
  where id = p_reel_id
    and status in ('pending', 'processing');
end;
$$;
