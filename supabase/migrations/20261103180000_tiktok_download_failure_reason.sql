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
-- Deliberately, NO existing function is touched: mark_adu_reel_downloaded
-- and mark_adu_reel_download_failed keep their exact signatures and
-- bodies, so the VPS downloader's 1-arg calls, PostgREST resolution, and
-- the adu-rpc-grants rig's hardening-migration idempotency check (which
-- re-applies 20261030140000, hardcoding the (uuid) signature) all keep
-- working. The reason is recorded by a separate, service_role-only RPC
-- that the Worker calls first on each failure, before the existing
-- mark-failed call moves the retry accounting.
--
-- last_download_error holds the MOST RECENT failed attempt's reason. A
-- row that later downloads successfully keeps that older reason (the
-- status column remains the authority on outcome); the diagnostic query
-- filters to pending/download_failed rows, where the reason is current.

alter table public.adu_reels
  add column if not exists last_download_error jsonb;

comment on column public.adu_reels.last_download_error is
  'Latest TikTok download failure: {"stage","reason","detail","at"}. Written by record_adu_reel_download_failure on every failed attempt. Detail never contains URLs, captions, or credentials.';

create or replace function public.record_adu_reel_download_failure(
  p_reel_id uuid,
  p_failure jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.adu_reels
  set last_download_error = coalesce(p_failure, last_download_error)
  where id = p_reel_id;
end;
$$;

-- Same grant closure as the other ADU RPCs: service_role only. Without
-- this, the default EXECUTE TO PUBLIC would let any caller rewrite
-- failure reasons on arbitrary reels.
revoke execute on function public.record_adu_reel_download_failure(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_adu_reel_download_failure(uuid, jsonb)
  to service_role;
