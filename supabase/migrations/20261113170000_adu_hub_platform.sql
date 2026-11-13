-- F21: collapse the three ADU hub RPC pairs into one
-- platform-parameterised pair (ADU optimization plan, F21).
--
-- THE FACEBOOK-DIRECTION LEAK (fixed here): the Facebook pair
-- (adu_hub_list / adu_hub_stats, as redefined by 20261113150000)
-- filtered only on d.section = 'adu' and had NO platform predicate,
-- so an Instagram/Threads config on an adu-section destination
-- structurally appeared in the Facebook hub. The Threads and
-- Instagram pairs already filtered d.platform, so the leak ran in
-- one direction only. The unified pair below adds a REQUIRED
-- p_platform (no default — an omitted platform must not silently
-- return everything) and filters by it, so each hub sees exactly
-- its own platform's configs. The predicate casts the enum to text
-- (d.platform::text = p_platform): destinations.platform is the
-- public.platform ENUM, and a plain text comparison has no operator
-- (42883); casting p_platform to the enum instead would ERROR on a
-- bogus value rather than returning 0 rows.
--
-- CORRECTION to the 20261113130000 header (landed file untouched):
-- that migration claims "Facebook configs never appear here,
-- Instagram configs never appear there." The first clause is true
-- (the Instagram pair filtered platform='instagram'). The second
-- clause was FALSE for the Facebook hub — an Instagram config on an
-- adu-section destination appeared in adu_hub_list until this
-- migration. The clause is corrected here, not by editing the
-- landed file.
--
-- HIDE-DISCONNECTED provenance (#246, 20261113150000): the unified
-- pair carries the Pages-section rule verbatim — a destination with
-- status 'disconnected' is excluded, EXCEPT a paused page
-- (disconnected + metadata->>'fb_status' = 'paused'), which stays
-- listed. The bodies below are the 20261113150000 definitions
-- verbatim, plus the platform predicate and the join unification;
-- the reverse migration restores those six definitions verbatim.
--
-- SHAPE: the unified RETURNS TABLE is the Facebook superset
-- (followers_updated_at included). The Threads pair omitted that
-- column; Threads callers simply ignore the extra column. Stats
-- shape is identical across all three pairs already.
--
-- JOIN: INNER JOIN for all three platforms. The Facebook pair used
-- a LEFT JOIN with the section predicate in the WHERE clause, which
-- is exactly equivalent to an inner join for filtering (a config
-- whose destination is missing or non-'adu' is excluded either
-- way — the 1B fail-closed design), and the platform + hide
-- predicates in the WHERE clause keep it fail-closed.
--
-- SIGNATURE CHANGE: the unified functions take a new p_platform
-- argument, so CREATE OR REPLACE alone would create overloads
-- alongside the old six. The six old functions are DROPPED first
-- (exact old signatures), then the unified pair is created.
-- Grants are set explicitly on the new functions (a DROP destroys
-- the old ACLs): revoked from public/anon/authenticated, granted
-- only to service_role — plain (NOT SECURITY DEFINER), STABLE,
-- workspace-scoped by p_workspace_id, exactly like the pairs they
-- replace.
--
DROP FUNCTION IF EXISTS public.adu_hub_list(uuid, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.adu_hub_stats(uuid, text, text);
DROP FUNCTION IF EXISTS public.threads_adu_hub_list(uuid, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.threads_adu_hub_stats(uuid, text, text);
DROP FUNCTION IF EXISTS public.instagram_adu_hub_list(uuid, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.instagram_adu_hub_stats(uuid, text, text);

CREATE OR REPLACE FUNCTION public.adu_hub_list(p_workspace_id uuid, p_platform text, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_sort text DEFAULT NULL::text, p_limit integer DEFAULT 9, p_offset integer DEFAULT 0)
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
      and d.platform::text = p_platform
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

CREATE OR REPLACE FUNCTION public.adu_hub_stats(p_workspace_id uuid, p_platform text, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
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
    and d.platform::text = p_platform
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

REVOKE EXECUTE ON FUNCTION public.adu_hub_list(uuid, text, text, text, text, integer, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adu_hub_list(uuid, text, text, text, text, integer, integer)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.adu_hub_stats(uuid, text, text, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adu_hub_stats(uuid, text, text, text)
  TO service_role;
