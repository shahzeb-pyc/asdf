-- Spec 162 — Insights worker: daily follower updates + ADU column
-- rename + mirror follower columns.
--
-- 1. ADU column rename (values preserved by design — RENAME COLUMN
--    rewrites no data): followers_count (the STARTING total) becomes
--    starting_followers, followers_gained (the CURRENT total, despite
--    the name) becomes current_followers. Plus a followers_updated_at
--    timestamp, set by the daily worker and by the ADU creation paths
--    on every current_followers write, so the timestamp always means
--    "last SUCCESSFUL follower check".
-- 2. Mirrors gain their own follower columns (all NULL until the
--    first daily worker run fills them — the migration backfills
--    nothing from destinations.metadata, per the owner decision).
-- 3. The hub list/stats RPCs (Facebook 20261030140000, Threads
--    20261031030001) are redefined to the new column names with
--    identical semantics (total = sum(current), net gained =
--    sum(max(0, current - starting))). Their RETURNS TABLE column
--    names change, so CREATE OR REPLACE cannot do it (PostgreSQL
--    forbids changing a function's return type that way): each
--    function is DROPPED and re-CREATEd in this one transaction,
--    then the original grant closure is re-applied verbatim
--    (revoke from PUBLIC/anon/authenticated, grant to service_role
--    only — the RPCs stay plain, NOT security definer).
--    adu_hub_list ALSO returns followers_updated_at (send-back fix,
--    spec 162 round 2): the Facebook hub route hands each RPC row
--    straight to buildAduConfigView, which reads the timestamp only
--    from the row it is handed — without the column the hub's
--    "Updated …" line could never render. adu_hub_stats needs no
--    timestamp (aggregate sums only) and threads_adu_hub_list needs
--    none either (the Threads hub route re-fetches each config row
--    with select('*'), so the timestamp already flows); the IG hub
--    route likewise selects '*'. Only the Facebook list carries it.
-- Facebook's Graph API field `followers_count` is untouched: it is
-- Facebook's field, not our column.

alter table public.adu_configs
  rename column followers_count to starting_followers;
alter table public.adu_configs
  rename column followers_gained to current_followers;
alter table public.adu_configs
  add column if not exists followers_updated_at timestamptz;

alter table public.mirrors
  add column if not exists starting_followers integer,
  add column if not exists current_followers integer,
  add column if not exists followers_updated_at timestamptz;

-- --- Facebook hub RPCs (20261030140000, renamed columns) ------------
drop function if exists public.adu_hub_list(uuid, text, text, text, integer, integer);
drop function if exists public.adu_hub_stats(uuid, text, text);

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
    coalesce(sum(c.current_followers), 0)::bigint,
    coalesce(sum(greatest(c.current_followers - c.starting_followers, 0)), 0)::bigint
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

-- --- Threads hub RPCs (20261031030001, renamed columns) -------------
drop function if exists public.threads_adu_hub_list(uuid, text, text, text, integer, integer);
drop function if exists public.threads_adu_hub_stats(uuid, text, text);

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
  starting_followers integer,
  current_followers integer,
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
    coalesce(sum(c.current_followers), 0)::bigint,
    coalesce(sum(greatest(c.current_followers - c.starting_followers, 0)), 0)::bigint
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
