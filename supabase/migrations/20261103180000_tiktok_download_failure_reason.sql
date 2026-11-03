-- TikTok downloader failure reasons (observability only).
--
-- The Worker ticks cleanly but every TikTok download fails downstream,
-- and neither the reel row nor the Worker logs record WHY: adu_reels has
-- no error column and Worker console logs are not API-readable. This
-- migration gives each reel a last_download_error (jsonb: stage, reason,
-- detail, at) that the downloader overwrites on every failed attempt —
-- including attempts that return the reel to `pending` for another retry,
-- so the latest reason is visible before the reel ever goes terminal.
--
-- Retry/suspend semantics are UNCHANGED: the mark-failed body below is
-- the 20261030130000 version with exactly one added SET clause, and the
-- new p_failure parameter defaults to null so the existing 1-arg call
-- (VPS downloader, grants-rig probe) keeps working and preserves any
-- previously recorded reason instead of clearing it. The mark-downloaded
-- function additionally clears a stale reason on success (same signature,
-- so CREATE OR REPLACE preserves its grants).

alter table public.adu_reels
  add column if not exists last_download_error jsonb;

comment on column public.adu_reels.last_download_error is
  'Latest TikTok download failure: {"stage","reason","detail","at"}. Written by mark_adu_reel_download_failed on every failed attempt; cleared by mark_adu_reel_downloaded on success. Detail never contains URLs, captions, or credentials.';

-- A new signature is an overload, not a replacement, so drop the old
-- (uuid) function first; otherwise two mark-failed functions would exist
-- and the grants check / 1-arg probe could resolve to the wrong one.
drop function if exists public.mark_adu_reel_download_failed(uuid);

create function public.mark_adu_reel_download_failed(p_reel_id uuid, p_failure jsonb default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_config_id uuid;
  v_failed_count int;
  v_new_status text;
begin
  update public.adu_reels
  set
    status = case
      when download_retries >= 3 then 'download_failed'
      else 'pending'
    end,
    download_failed_at = case
      when download_retries >= 3 then now()
      else null
    end,
    download_claimed_at = null,
    last_download_error = case
      when p_failure is null then last_download_error
      else p_failure
    end
  where id = p_reel_id
  returning config_id, status into v_config_id, v_new_status;

  -- If this reel just transitioned to 'download_failed'
  if v_config_id is not null and v_new_status = 'download_failed' then
    select count(*)::int into v_failed_count
    from public.adu_reels r
    where r.config_id = v_config_id
      and r.status = 'download_failed';

    if v_failed_count > 50 then
      update public.adu_configs c
      set
        status = 'creator_suspended',
        updated_at = now()
      where c.id = v_config_id
        and c.status = 'active';
    end if;
  end if;
end;
$$;

-- DROP discarded the old grants: re-apply the hardening closure exactly.
revoke execute on function public.mark_adu_reel_download_failed(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.mark_adu_reel_download_failed(uuid, jsonb)
  to service_role;

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
    last_download_error = null
  where id = p_reel_id
    and status in ('pending', 'processing');
end;
$$;
