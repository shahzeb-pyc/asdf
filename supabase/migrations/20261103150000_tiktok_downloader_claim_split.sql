-- TikTok downloader claim split (Cloudflare Worker).
--
-- The original `claim_adu_buffer_downloads` takes no platform filter, so
-- it cannot split claiming between two downloaders. This migration adds
-- two functions with byte-identical semantics to the corrected claim in
-- 20261030140000 §0, plus exactly one predicate each:
--   - `claim_tiktok_buffer_downloads`     — TikTok configs only, claimed
--     by the new Cloudflare Worker (apps/tiktok-downloader).
--   - `claim_non_tiktok_buffer_downloads` — everything else, claimed by
--     the VPS downloader (apps/adu-downloader).
-- The original function is LEFT UNTOUCHED: the adu-rpc-grants rig pins it,
-- and deleting it would break that rig. Production callers move to the
-- split functions; the original simply has no production caller left.
-- Grant closure matches the hardening migration: EXECUTE revoked from
-- PUBLIC/anon/authenticated, granted to service_role only.
-- `source_platform` is NOT NULL with a 4-value CHECK, so the `<>`
-- predicate has no NULL gap: every config is claimed by exactly one side.

create or replace function public.claim_tiktok_buffer_downloads(p_limit int default 10)
returns table (
  reel_id uuid,
  config_id uuid,
  source_platform text,
  source_username text,
  source_reel_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_limit, 0) <= 0 then
    return;
  end if;

  return query
  with active_pages as (
    select
      c.id,
      coalesce(c.posts_per_day, 0) * 1 as buffer_target
    from public.adu_configs c
    where c.status = 'active'
      and c.sync_status = 'synced'
      and c.source_platform = 'tiktok'
      and coalesce(c.posts_per_day, 0) > 0
      -- Skip claiming new downloads for pages that have > 10 failed downloads in the last 24 hours.
      and (
        select count(*)::int
        from public.adu_reels r
        where r.config_id = c.id
          and r.status = 'download_failed'
          and r.download_failed_at >= now() - interval '24 hours'
      ) <= 10
  ),
  page_buffer as (
    select
      ap.id as page_id,
      ap.buffer_target,
      (
        select count(*)::int
        from public.adu_reels r
        where r.config_id = ap.id
          and r.status in ('downloaded', 'processing')
      ) as buffer_filled
    from active_pages ap
  ),
  hungry_pages as (
    select
      pb.page_id,
      pb.buffer_filled,
      (
        select r.id
        from public.adu_reels r
        where r.config_id = pb.page_id
          and r.status = 'pending'
          and r.download_retries < 3
        order by r.id asc
        limit 1
      ) as first_pending_id
    from page_buffer pb
    where pb.buffer_filled < pb.buffer_target
  ),
  min_level as (
    select min(hp.buffer_filled) as level
    from hungry_pages hp
    where hp.first_pending_id is not null
  ),
  eligible_pages as (
    select hp.page_id, hp.first_pending_id
    from hungry_pages hp
    cross join min_level ml
    where hp.buffer_filled = ml.level
      and hp.first_pending_id is not null
  ),
  one_per_page as (
    select ep.first_pending_id as id
    from eligible_pages ep
  ),
  locked as (
    select r.id
    from one_per_page opp
    join public.adu_reels r on r.id = opp.id
    order by random()
    limit p_limit
    for update of r skip locked
  )
  update public.adu_reels r
  set
    status = 'processing',
    download_retries = r.download_retries + 1,
    download_claimed_at = now()
  from locked l, public.adu_configs c
  where r.id = l.id
    and c.id = r.config_id
  -- adu_reels carries no platform/username columns (old reels did);
  -- they come from the config row, which is what the downloader
  -- needs to build the source URL.
  returning r.id, r.config_id, c.source_platform, c.source_username, r.source_reel_id;
end;
$$;

create or replace function public.claim_non_tiktok_buffer_downloads(p_limit int default 10)
returns table (
  reel_id uuid,
  config_id uuid,
  source_platform text,
  source_username text,
  source_reel_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_limit, 0) <= 0 then
    return;
  end if;

  return query
  with active_pages as (
    select
      c.id,
      coalesce(c.posts_per_day, 0) * 1 as buffer_target
    from public.adu_configs c
    where c.status = 'active'
      and c.sync_status = 'synced'
      and c.source_platform <> 'tiktok'
      and coalesce(c.posts_per_day, 0) > 0
      -- Skip claiming new downloads for pages that have > 10 failed downloads in the last 24 hours.
      and (
        select count(*)::int
        from public.adu_reels r
        where r.config_id = c.id
          and r.status = 'download_failed'
          and r.download_failed_at >= now() - interval '24 hours'
      ) <= 10
  ),
  page_buffer as (
    select
      ap.id as page_id,
      ap.buffer_target,
      (
        select count(*)::int
        from public.adu_reels r
        where r.config_id = ap.id
          and r.status in ('downloaded', 'processing')
      ) as buffer_filled
    from active_pages ap
  ),
  hungry_pages as (
    select
      pb.page_id,
      pb.buffer_filled,
      (
        select r.id
        from public.adu_reels r
        where r.config_id = pb.page_id
          and r.status = 'pending'
          and r.download_retries < 3
        order by r.id asc
        limit 1
      ) as first_pending_id
    from page_buffer pb
    where pb.buffer_filled < pb.buffer_target
  ),
  min_level as (
    select min(hp.buffer_filled) as level
    from hungry_pages hp
    where hp.first_pending_id is not null
  ),
  eligible_pages as (
    select hp.page_id, hp.first_pending_id
    from hungry_pages hp
    cross join min_level ml
    where hp.buffer_filled = ml.level
      and hp.first_pending_id is not null
  ),
  one_per_page as (
    select ep.first_pending_id as id
    from eligible_pages ep
  ),
  locked as (
    select r.id
    from one_per_page opp
    join public.adu_reels r on r.id = opp.id
    order by random()
    limit p_limit
    for update of r skip locked
  )
  update public.adu_reels r
  set
    status = 'processing',
    download_retries = r.download_retries + 1,
    download_claimed_at = now()
  from locked l, public.adu_configs c
  where r.id = l.id
    and c.id = r.config_id
  -- adu_reels carries no platform/username columns (old reels did);
  -- they come from the config row, which is what the downloader
  -- needs to build the source URL.
  returning r.id, r.config_id, c.source_platform, c.source_username, r.source_reel_id;
end;
$$;

revoke execute on function public.claim_tiktok_buffer_downloads(integer)
  from public, anon, authenticated;
grant execute on function public.claim_tiktok_buffer_downloads(integer)
  to service_role;

revoke execute on function public.claim_non_tiktok_buffer_downloads(integer)
  from public, anon, authenticated;
grant execute on function public.claim_non_tiktok_buffer_downloads(integer)
  to service_role;
