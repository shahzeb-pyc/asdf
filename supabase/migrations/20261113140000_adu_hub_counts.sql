-- ADU optimization F1 (grouped counts): one grouped count query per
-- page of configs, replacing the per-config N+1 in buildAduConfigView
-- (7 trips per config: destination lookup + 6 exact-count queries).
--
-- `adu_config_counts` returns all six counts for up to 50 requested
-- configs in ONE query, scoped to one workspace. Scalar subqueries
-- (never joins) so counts can never fan out; a config with no reels or
-- jobs still returns a row of zeros (LEFT-side CTE, not an inner join
-- on the counted tables).
--
-- Count semantics are EXACTLY the per-config queries they replace
-- (apps/web/src/lib/server/adu.ts, buildAduConfigView):
-- - in_pipeline: reels with status in ('pending','processing','downloaded')
-- - published: jobs with status 'published'
-- - failed: jobs with status in
--   ('failed_to_publish','publish_error','integrity_error')
-- - failed_in_pipeline: failed jobs whose reel is STILL in a pipeline
--   status (join on adu_posting_jobs.reel_id = adu_reels.id). A
--   terminally-failed reel has left the pipeline, so its job must NOT
--   be subtracted a second time; only the crash window (job settled,
--   reel update not yet applied) subtracts.
-- - published_today / failed_today: the same job counts with
--   created_at >= page-local midnight in the config's timezone, the
--   same approximation the TS code uses (local calendar date in that
--   timezone, at 00:00:00Z): date_trunc('day', now() AT TIME ZONE tz)
--   AT TIME ZONE 'UTC'. An invalid/unknown timezone falls back to UTC
--   midnight, matching the try/catch fallback in startOfDayInTimezone.
--
-- SECURITY DEFINER + service_role-only EXECUTE (same pattern as
-- get_entitlement): the server is the only legitimate caller, and the
-- function itself scopes every row to p_workspace_id, so a caller can
-- never read another workspace's counts by passing its id.
--
-- The reverse migration lives at
-- supabase/migrations/reverse/20261113140000_adu_hub_counts.sql
-- (never auto-applied; run manually with a code revert).

create or replace function public.adu_config_counts(
  p_workspace_id uuid,
  p_config_ids uuid[]
)
returns table (
  config_id uuid,
  in_pipeline bigint,
  published bigint,
  failed bigint,
  failed_in_pipeline bigint,
  published_today bigint,
  failed_today bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with requested as (
    select c.id, c.timezone
    from public.adu_configs c
    where c.workspace_id = p_workspace_id
      and c.id = any (p_config_ids)
    limit 50
  ),
  midnights as (
    select
      r.id,
      case
        when exists (select 1 from pg_timezone_names where name = r.timezone)
          then date_trunc('day', now() at time zone r.timezone) at time zone 'UTC'
        else date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
      end as midnight
    from requested r
  )
  select
    r.id as config_id,
    (select count(*) from public.adu_reels
      where config_id = r.id
        and status in ('pending', 'processing', 'downloaded')) as in_pipeline,
    (select count(*) from public.adu_posting_jobs
      where config_id = r.id and status = 'published') as published,
    (select count(*) from public.adu_posting_jobs
      where config_id = r.id
        and status in ('failed_to_publish', 'publish_error', 'integrity_error')) as failed,
    (select count(*) from public.adu_posting_jobs j
      join public.adu_reels ar on ar.id = j.reel_id
      where j.config_id = r.id
        and j.status in ('failed_to_publish', 'publish_error', 'integrity_error')
        and ar.status in ('pending', 'processing', 'downloaded')) as failed_in_pipeline,
    (select count(*) from public.adu_posting_jobs
      where config_id = r.id and status = 'published'
        and created_at >= m.midnight) as published_today,
    (select count(*) from public.adu_posting_jobs
      where config_id = r.id
        and status in ('failed_to_publish', 'publish_error', 'integrity_error')
        and created_at >= m.midnight) as failed_today
  from requested r
  join midnights m on m.id = r.id;
$function$;

revoke execute on function public.adu_config_counts(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.adu_config_counts(uuid, uuid[])
  to service_role;

comment on function public.adu_config_counts(uuid, uuid[]) is
  'ADU optimization F1: grouped per-config counts (pipeline / published / failed / failed-in-pipeline / published-today / failed-today) for up to 50 configs in one query. SECURITY DEFINER, service_role only; every row is scoped to p_workspace_id.';
