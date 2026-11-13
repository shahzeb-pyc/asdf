-- Instagram Auto Download/Upload hub list/stats RPCs (ADU optimization
-- Stream D, F20).
--
-- Mirrors adu_hub_list / adu_hub_stats
-- (supabase/migrations/20261112180000_adu_hub_section_label.sql) but
-- filters to Instagram destinations only (destinations.platform =
-- 'instagram', section = 'adu'), exactly like the Threads clones in
-- that file. No existing function or table is altered, so the Facebook
-- and Threads hubs are untouched: Facebook configs never appear here,
-- Instagram configs never appear there. The ADU tables themselves are
-- shared: an Instagram config is an adu_configs row whose destination
-- is an Instagram destination, so no new tables are needed.
--
-- This replaces the IG list route's direct PostgREST queries: the
-- non-search path computed stats from a second full filtered select,
-- and the search path loaded every matching config into memory and
-- filtered/sorted/paginated in JS. Both paths now page and count in
-- the database, like Facebook and Threads.
--
-- F21 will collapse the three RPC pairs (facebook / instagram /
-- threads) into one platform-parameterised function. Until then this
-- pair is a deliberate clone — do not "fix" the duplication here.
--
-- Both functions are plain (NOT security definer), STABLE, and
-- workspace-scoped by p_workspace_id. EXECUTE is revoked from PUBLIC,
-- anon and authenticated and granted only to service_role, exactly
-- like the Facebook and Threads hub RPCs: only the web server path
-- calls them.

create or replace function public.instagram_adu_hub_list(
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
  starting_followers integer,
  current_followers integer,
  followers_updated_at timestamptz,
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
      and d.platform = 'instagram'
      and d.section = 'adu'
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
    f.posting_times, f.status, f.sync_status, f.starting_followers,
    f.current_followers, f.followers_updated_at, f.display_name, f.created_at, f.updated_at,
    count(*) over () as total_count
  from filtered f
  order by
    case when p_sort = 'Most Followers' then f.current_followers end desc nulls last,
    case when p_sort = 'Least Followers' then f.current_followers end asc nulls last,
    f.created_at desc
  limit least(greatest(coalesce(p_limit, 9), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.instagram_adu_hub_stats(
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
    coalesce(sum(c.current_followers), 0)::bigint,
    coalesce(sum(greatest(c.current_followers - c.starting_followers, 0)), 0)::bigint
  from public.adu_configs c
  join public.destinations d on d.id = c.destination_id
  where c.workspace_id = p_workspace_id
    and d.platform = 'instagram'
    and d.section = 'adu'
    and (p_status is null or p_status = '' or c.status = p_status)
    and (
      p_search is null or p_search = ''
      or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    );
$$;

revoke execute on function public.instagram_adu_hub_list(uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.instagram_adu_hub_list(uuid, text, text, text, integer, integer)
  to service_role;

revoke execute on function public.instagram_adu_hub_stats(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.instagram_adu_hub_stats(uuid, text, text)
  to service_role;
