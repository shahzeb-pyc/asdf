-- Hide disconnected pages in the ADU hub (list + stats, Facebook + Threads + Instagram).
--
-- Adds the Pages-section rule to the six hub RPCs: the four redefined by
-- spec 174 PR 1B (20261112180000) plus the Instagram pair created by ADU
-- optimization Stream D (20261113130000). A destination with status
-- 'disconnected' is excluded, EXCEPT a paused page, which is stored as
-- disconnected + metadata->>'fb_status' = 'paused' and stays listed —
-- exactly the predicate in
-- apps/web/src/app/api/tenant/[subdomain]/pages/route.ts (buildPageWhere
-- / mapSupabaseDestinationRows). Error and rate_limited destinations
-- stay listed, as in Pages.
--
-- The predicate sits in the WHERE clause, next to the section predicate,
-- so it is fail-closed like the 1B predicate: a config pointing at a
-- missing destination is excluded, not shown with blank fields.
--
-- The bodies below are the 1B definitions verbatim (Facebook/Threads)
-- and the 20261113130000 definitions verbatim (Instagram), plus the one
-- added predicate per function. The reverse migration restores those
-- definitions verbatim (never auto-applied; run manually with a code
-- revert).
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
      and (d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')
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
    and (d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')
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
      and (d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')
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
    and (d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')
    and (p_status is null or p_status = '' or c.status = p_status)
    and (
      p_search is null or p_search = ''
      or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    );
$function$;

CREATE OR REPLACE FUNCTION public.instagram_adu_hub_list(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_sort text DEFAULT NULL::text, p_limit integer DEFAULT 9, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, workspace_id uuid, destination_id uuid, source_platform text, source_username text, timezone text, posts_per_day integer, schedule_type text, posting_times text[], status text, sync_status text, starting_followers integer, current_followers integer, followers_updated_at timestamp with time zone, display_name text, created_at timestamp with time zone, updated_at timestamp with time zone, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with filtered as (
    select c.*
    from public.adu_configs c
    join public.destinations d on d.id = c.destination_id
    where c.workspace_id = p_workspace_id
      and d.platform = 'instagram'
      and d.section = 'adu'
      and (d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')
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

CREATE OR REPLACE FUNCTION public.instagram_adu_hub_stats(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
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
    and d.platform = 'instagram'
    and d.section = 'adu'
    and (d.status <> 'disconnected' or d.metadata->>'fb_status' = 'paused')
    and (p_status is null or p_status = '' or c.status = p_status)
    and (
      p_search is null or p_search = ''
      or c.source_username ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      or d.external_destination_id ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    );
$function$;
