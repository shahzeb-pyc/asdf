-- Reverse of 20261113150000_adu_hub_hide_disconnected.sql (never
-- auto-applied; run manually with a code revert). Restores the spec 174
-- PR 1B definitions of `adu_hub_list`, `adu_hub_stats`,
-- `threads_adu_hub_list` and `threads_adu_hub_stats` verbatim, plus
-- the 20261113130000 definitions of `instagram_adu_hub_list` and
-- `instagram_adu_hub_stats` verbatim — i.e. the section = 'adu'
-- predicate (and the platform predicates), WITHOUT the disconnected
-- exclusion. The bodies below are the 20261112180000 migration
-- verbatim (Facebook/Threads) and the 20261113130000 migration
-- verbatim (Instagram).
--
CREATE OR REPLACE FUNCTION public.adu_hub_list(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_sort text DEFAULT NULL::text, p_limit integer DEFAULT 9, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, workspace_id uuid, destination_id uuid, source_platform text, source_username text, timezone text, posts_per_day integer, schedule_type text, posting_times text[], status text, sync_status text, starting_followers integer, current_followers integer, followers_updated_at timestamp with time zone, display_name text, created_at timestamp with time zone, updated_at timestamp with time zone, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with filtered as (
    select c.*
    from public.adu_configs c
    left join public.destinations d on d.id = c.destination_id
    where c.workspace_id = p_workspace_id
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
$function$;

CREATE OR REPLACE FUNCTION public.adu_hub_stats(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS TABLE(total_count bigint, total_followers_sum bigint, net_gained_sum bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    count(*)::bigint,
    coalesce(sum(c.current_followers), 0)::bigint,
    coalesce(sum(greatest(c.current_followers - c.starting_followers, 0)), 0)::bigint
  from public.adu_configs c
  left join public.destinations d on d.id = c.destination_id
  where c.workspace_id = p_workspace_id
    and d.section = 'adu'
    and (p_status is null or p_status = '' or c.status = p_status)
    and (
      p_search is null or p_search = ''
      or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    );
$function$;

CREATE OR REPLACE FUNCTION public.threads_adu_hub_list(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_sort text DEFAULT NULL::text, p_limit integer DEFAULT 9, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, workspace_id uuid, destination_id uuid, source_platform text, source_username text, timezone text, posts_per_day integer, schedule_type text, posting_times text[], status text, sync_status text, starting_followers integer, current_followers integer, display_name text, created_at timestamp with time zone, updated_at timestamp with time zone, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with filtered as (
    select c.*
    from public.adu_configs c
    join public.destinations d on d.id = c.destination_id
    where c.workspace_id = p_workspace_id
      and d.platform = 'threads'
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
    f.current_followers, f.display_name, f.created_at, f.updated_at,
    count(*) over () as total_count
  from filtered f
  order by
    case when p_sort = 'Most Followers' then f.current_followers end desc nulls last,
    case when p_sort = 'Least Followers' then f.current_followers end asc nulls last,
    f.created_at desc
  limit least(greatest(coalesce(p_limit, 9), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

CREATE OR REPLACE FUNCTION public.threads_adu_hub_stats(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS TABLE(total_count bigint, total_followers_sum bigint, net_gained_sum bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    count(*)::bigint,
    coalesce(sum(c.current_followers), 0)::bigint,
    coalesce(sum(greatest(c.current_followers - c.starting_followers, 0)), 0)::bigint
  from public.adu_configs c
  join public.destinations d on d.id = c.destination_id
  where c.workspace_id = p_workspace_id
    and d.platform = 'threads'
    and d.section = 'adu'
    and (p_status is null or p_status = '' or c.status = p_status)
    and (
      p_search is null or p_search = ''
      or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    );
$function$;

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
