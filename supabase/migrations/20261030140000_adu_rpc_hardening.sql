-- ADU RPC hardening + hub list/stats RPCs (SEND BACK fix for PR #43).
--
-- This is a NEW forward migration, not an amendment of
-- 20261030130000_adu_claim_rpc.sql: that migration is already in the
-- open PR and its history is preserved. This migration is NOT applied
-- by the branch that creates it; it is applied together with the two
-- ADU migrations on the owner's tap, in filename order.
--
-- 1. SECURITY DEFINER grant closure (blocker B). A newly created
--    function is executable by PUBLIC by default, so the seven claim
--    RPCs from 20261030130000 were reachable through PostgREST /rpc/
--    by any anon/authenticated caller, even though the tables they
--    touch have RLS with no permissive policies. These RPCs are
--    intentionally global for the service-side claim loop (lowest-
--    buffered config first, SKIP LOCKED): an in-function
--    workspace/ownership check would break that loop, because the
--    loop claims across workspaces by design and the VPS services
--    hold no per-workspace session. The control is therefore
--    execution scope, not an ownership check inside the function:
--    EXECUTE is revoked from PUBLIC, anon and authenticated, and
--    granted only to service_role, which is the role the web server,
--    the worker and the VPS scraper/downloader services use. The
--    web/worker paths additionally scope every record they touch to
--    the resolved workspace (aduContext / destination lookups), so
--    workspace scoping still happens server-side, just not inside
--    these service-only functions. The ADU RPC-grants rig
--    (apps/worker/tests/adu-rpc-grants) proves the revokes with
--    catalog checks AND live 42501 probes as authenticated.
--
-- 2. Hub list/stats RPCs (blocker C). The hub route previously loaded
--    every adu_configs row for a workspace and sliced 9/page in
--    memory, and buildAduConfigView loaded every reel and every job
--    per config — past PostgREST's 1,000-row truncation the totals,
--    stats and pagination silently went wrong. The hub list and its
--    stats are now aggregated in the database: adu_hub_list returns
--    one page (limit clamped to 1..50) plus a window total_count,
--    and adu_hub_stats returns the filtered totals/sums. Both are
--    plain (NOT security definer) STABLE functions, workspace-scoped
--    by their p_workspace_id parameter, and EXECUTE is likewise
--    restricted to service_role, because only the server path calls
--    them. Per-config reel/job counts are now count queries in
--    lib/server/adu.ts, not unbounded loads (see that file).
--
-- 3. Indexes backing the bounded count queries: per-config status
--    counts on adu_reels and adu_posting_jobs.

-- --- 0. Claim RPC correction (found by the ADU RPC-grants rig) -------
-- 20261030130000's claim_adu_buffer_downloads never executed: its
-- final UPDATE joined adu_configs ON c.id = r.config_id, and
-- PostgreSQL rejects a reference to the UPDATE target table (r) from
-- a FROM-clause JOIN condition ("invalid reference to FROM-clause
-- entry for table r"). The downloader's claim loop calls this RPC, so
-- as written no buffer download could ever be claimed. The fix keeps
-- the exact same semantics and returns the exact same columns, but
-- expresses the join as a comma join with the condition in WHERE,
-- where referencing the target table is legal. Defined here, before
-- the grants below, so the REVOKE/GRANT block applies to the corrected
-- function (CREATE OR REPLACE would preserve grants anyway, but the
-- order makes it explicit).
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
  from locked l, public.adu_configs c
  where r.id = l.id
    and c.id = r.config_id
  -- adu_reels carries no platform/username columns (old reels did);
  -- they come from the config row, which is what the downloader
  -- needs to build the source URL.
  returning r.id, r.config_id, c.source_platform, c.source_username, r.source_reel_id;
end;
$$;

-- --- 1. Claim RPC grant closure (seven functions) --------------------
revoke execute on function public.get_next_pending_adu_config(text)
  from public, anon, authenticated;
grant execute on function public.get_next_pending_adu_config(text)
  to service_role;

revoke execute on function public.get_next_browser_pending_adu_config(text)
  from public, anon, authenticated;
grant execute on function public.get_next_browser_pending_adu_config(text)
  to service_role;

revoke execute on function public.reset_stuck_adu_configs()
  from public, anon, authenticated;
grant execute on function public.reset_stuck_adu_configs()
  to service_role;

revoke execute on function public.reset_stale_adu_reel_downloads(integer)
  from public, anon, authenticated;
grant execute on function public.reset_stale_adu_reel_downloads(integer)
  to service_role;

revoke execute on function public.claim_adu_buffer_downloads(integer)
  from public, anon, authenticated;
grant execute on function public.claim_adu_buffer_downloads(integer)
  to service_role;

revoke execute on function public.mark_adu_reel_downloaded(uuid, text, bigint, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mark_adu_reel_downloaded(uuid, text, bigint, text, text, text, text)
  to service_role;

revoke execute on function public.mark_adu_reel_download_failed(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_adu_reel_download_failed(uuid)
  to service_role;

-- --- 2. Hub list/stats RPCs ------------------------------------------
create or replace function public.adu_hub_list(
  p_workspace_id uuid,
  p_search text default null,
  p_status text default null,
  p_sort text default null,
  p_limit integer default 9,
  p_offset integer default 0
)
returns table (
  id uuid,
  workspace_id uuid,
  destination_id uuid,
  source_platform text,
  source_username text,
  timezone text,
  posts_per_day integer,
  schedule_type text,
  posting_times text[],
  status text,
  sync_status text,
  followers_count integer,
  followers_gained integer,
  display_name text,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with filtered as (
    select c.*
    from public.adu_configs c
    left join public.destinations d on d.id = c.destination_id
    where c.workspace_id = p_workspace_id
      and (p_status is null or p_status = '' or c.status = p_status)
      and (
        p_search is null or p_search = ''
        or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
        or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
        or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      )
  )
  select
    f.id, f.workspace_id, f.destination_id, f.source_platform,
    f.source_username, f.timezone, f.posts_per_day, f.schedule_type,
    f.posting_times, f.status, f.sync_status, f.followers_count,
    f.followers_gained, f.display_name, f.created_at, f.updated_at,
    count(*) over () as total_count
  from filtered f
  order by
    case when p_sort = 'Most Followers' then f.followers_gained end desc nulls last,
    case when p_sort = 'Least Followers' then f.followers_gained end asc nulls last,
    f.created_at desc
  limit least(greatest(coalesce(p_limit, 9), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.adu_hub_stats(
  p_workspace_id uuid,
  p_search text default null,
  p_status text default null
)
returns table (
  total_count bigint,
  total_followers_sum bigint,
  net_gained_sum bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    count(*)::bigint,
    coalesce(sum(c.followers_gained), 0)::bigint,
    coalesce(sum(greatest(c.followers_gained - c.followers_count, 0)), 0)::bigint
  from public.adu_configs c
  left join public.destinations d on d.id = c.destination_id
  where c.workspace_id = p_workspace_id
    and (p_status is null or p_status = '' or c.status = p_status)
    and (
      p_search is null or p_search = ''
      or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    );
$$;

revoke execute on function public.adu_hub_list(uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.adu_hub_list(uuid, text, text, text, integer, integer)
  to service_role;

revoke execute on function public.adu_hub_stats(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.adu_hub_stats(uuid, text, text)
  to service_role;

-- --- 3. Indexes for the bounded per-config count queries --------------
create index if not exists idx_adu_reels_config_status
  on public.adu_reels (config_id, status);

create index if not exists idx_adu_jobs_config_status_created
  on public.adu_posting_jobs (config_id, status, created_at);
