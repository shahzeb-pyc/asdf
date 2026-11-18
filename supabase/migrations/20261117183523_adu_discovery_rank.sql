-- Discovery rank for newest-first downloads (spec 203).
--
-- The downloader claim picked one pending reel per config
-- `ORDER BY r.id ASC`, and r.id is a random UUID — effectively
-- arbitrary, so reels downloaded (and therefore posted) in random
-- order. This migration adds the order the scraper already knows:
--   - `discovery_rank` — the reel's position in its discovery run
--     (1 = first). The scraper assigns it at upsert time: discovery
--     position (newest first) for every platform; for TikTok the
--     top 60 by views take ranks 1-60 and the rest follow in
--     discovery order. NULL = unranked (pre-existing rows), sorts
--     last. Only newly inserted rows ever get a rank — the upsert
--     ignores duplicates, so already-known rows keep whatever they
--     had and are never re-ranked.
--   - `view_count` — the TikTok view count measured at discovery
--     (TikWM feed play_count), for the ranked set only; NULL
--     everywhere else.
-- Both live claim RPCs (TikTok + non-TikTok) pick newest-sync-first:
--   ORDER BY created_at DESC, discovery_rank ASC NULLS LAST, id ASC.
-- Within one sync all rows share one created_at (single INSERT), so
-- created_at separates runs and rank orders inside each run. Rank
-- first would interleave runs: a new run's rank-1 ties an old run's
-- rank-1, broken by created_at, so downloads alternate new/old
-- instead of the new run's top 30 strictly first. Legacy unranked
-- rows (NULL rank, old created_at) sort after new runs; within one
-- old sync they stay unordered (no order signal exists for them) —
-- accepted, they drain over time. Nothing else in those RPCs
-- changes (buffer gates, eligibility, retry budget untouched).
-- The ORIGINAL claim_adu_buffer_downloads is LEFT UNTOUCHED: the
-- adu-rpc-grants rig pins it, and it has no production caller.
-- Grant closure matches the split migration: EXECUTE revoked from
-- PUBLIC/anon/authenticated, granted to service_role only.

alter table public.adu_reels
  add column if not exists discovery_rank integer;
alter table public.adu_reels
  add column if not exists view_count bigint;

create index if not exists idx_adu_reels_config_status_rank
  on public.adu_reels (config_id, status, discovery_rank);

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
        order by r.created_at desc, r.discovery_rank asc nulls last, r.id asc
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
        order by r.created_at desc, r.discovery_rank asc nulls last, r.id asc
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
