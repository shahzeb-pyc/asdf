-- ADU claim RPCs, ported from the old fbuploadpro ADU migrations in
-- their FINAL form (20260703020000 for claim/mark-failed, 20260713170000
-- for stuck-config reset, 20260605120000 for stale-download reset).
--
-- Adaptations to the new app, and nothing else:
-- - old `pages` -> `adu_configs`, old `reels` -> `adu_reels`;
-- - old bigint reel id -> uuid reel id; old `page_id` -> `config_id`;
-- - old `platform`/`username`/`reel_id` columns -> `source_platform` /
--   `source_username` / `source_reel_id`;
-- - old `media_size_bytes` / `media_content_type` / `download_claimed_at` /
--   `download_failed_at` columns did not exist on adu_reels yet, so this
--   migration adds them (they existed on the old reels table);
-- - `mark_adu_reel_downloaded` gains a `p_media_url` argument: the new
--   app's Facebook publisher fetches the buffer object by public URL
--   (the old publisher read R2 directly), and the worker intake only
--   picks reels with a media_url set.
-- - Function names keep the old names where the old name already said
--   "adu" (claim / mark / reset_stale), and gain an `adu_config`
--   suffix where the old name said "page" (get_next_pending_page).
-- - No token gate, no global pause switch: neither exists in the new app.
-- - Security definer: only the service role used by the VPS
--   scraper/downloader reaches these, exactly like the old setup and
--   like the new app's other server-only tables. The EXECUTE grants
--   themselves are applied by 20261030140000_adu_rpc_hardening.sql
--   (a newly created function is executable by PUBLIC by default, so
--   the REVOKEs must be a separate step — see that file).
-- - This migration is NOT applied by the branch that creates it; it is
--   applied separately on the owner's tap, together with
--   20261030120000_adu.sql.

alter table public.adu_reels
  add column if not exists media_size_bytes bigint,
  add column if not exists media_content_type text,
  add column if not exists download_claimed_at timestamptz,
  add column if not exists download_failed_at timestamptz;

create index if not exists idx_adu_reels_config_status_buffer
  on public.adu_reels (config_id, status, id)
  where status in ('pending', 'downloaded', 'processing');

create index if not exists idx_adu_reels_config_download_failed_at
  on public.adu_reels (config_id, download_failed_at desc);

create or replace function public.get_next_pending_adu_config(p_platform text default null)
returns table (id uuid, source_username text, source_platform text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.adu_configs
  set sync_status = 'processing'
  where public.adu_configs.id = (
    select c.id
    from public.adu_configs c
    where c.sync_status = 'pending'
      and (p_platform is null or c.source_platform = p_platform)
    limit 1
    for update skip locked
  )
  returning public.adu_configs.id, public.adu_configs.source_username, public.adu_configs.source_platform;
end;
$$;

create or replace function public.get_next_browser_pending_adu_config(p_platform text default null)
returns table (id uuid, source_username text, source_platform text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.adu_configs
  set sync_status = 'processing'
  where public.adu_configs.id = (
    select c.id
    from public.adu_configs c
    where c.sync_status = 'browser_pending'
      and (p_platform is null or c.source_platform = p_platform)
    limit 1
    for update skip locked
  )
  returning public.adu_configs.id, public.adu_configs.source_username, public.adu_configs.source_platform;
end;
$$;

create or replace function public.reset_stuck_adu_configs()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.adu_configs
  set sync_status = 'pending'
  where sync_status = 'processing'
    and updated_at < now() - interval '1 hour';
end;
$$;

create or replace function public.reset_stale_adu_reel_downloads(p_stale_minutes int default 40)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reset_count integer;
begin
  update public.adu_reels
  set
    status = 'pending',
    download_claimed_at = null
  where status = 'processing'
    and download_claimed_at is not null
    and download_claimed_at < now() - make_interval(mins => p_stale_minutes)
    and download_retries < 3;

  get diagnostics v_reset_count = row_count;
  return v_reset_count;
end;
$$;

create or replace function public.claim_adu_buffer_downloads(p_limit int default 10)
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
  from locked l
  join public.adu_configs c on c.id = r.config_id
  where r.id = l.id
  -- adu_reels carries no platform/username columns (old reels did);
  -- they come from the config row, which is what the downloader
  -- needs to build the source URL.
  returning r.id, r.config_id, c.source_platform, c.source_username, r.source_reel_id;
end;
$$;

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

create or replace function public.mark_adu_reel_download_failed(p_reel_id uuid)
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
    download_claimed_at = null
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
