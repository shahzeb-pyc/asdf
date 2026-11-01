-- Threads Auto Download/Upload hub list/stats RPCs.
--
-- Mirrors adu_hub_list / adu_hub_stats (20261030140000) but filters to
-- Threads destinations only (destinations.platform = 'threads'). No
-- existing function or table is altered, so the Facebook hub is
-- untouched: Facebook configs never appear here, Threads configs never
-- appear there. The ADU tables themselves are shared (see the Threads
-- ADU spec): a Threads config is an adu_configs row whose destination
-- is a Threads destination, so no new tables are needed.
--
-- Both functions are plain (NOT security definer), STABLE, and
-- workspace-scoped by p_workspace_id. EXECUTE is revoked from PUBLIC,
-- anon and authenticated and granted only to service_role, exactly
-- like the Facebook hub RPCs: only the web server path calls them.
-- This migration is NOT applied by the branch that creates it; it is
-- applied separately on the owner's tap, like the ADU migrations.

create or replace function public.threads_adu_hub_list(
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
    join public.destinations d on d.id = c.destination_id
    where c.workspace_id = p_workspace_id
      and d.platform = 'threads'
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

create or replace function public.threads_adu_hub_stats(
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
  join public.destinations d on d.id = c.destination_id
  where c.workspace_id = p_workspace_id
    and d.platform = 'threads'
    and (p_status is null or p_status = '' or c.status = p_status)
    and (
      p_search is null or p_search = ''
      or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    );
$$;

revoke execute on function public.threads_adu_hub_list(uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.threads_adu_hub_list(uuid, text, text, text, integer, integer)
  to service_role;

revoke execute on function public.threads_adu_hub_stats(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.threads_adu_hub_stats(uuid, text, text)
  to service_role;
