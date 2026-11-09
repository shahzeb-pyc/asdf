-- Spec 155 SEND BACK (PR #199, item 4): single-statement
-- `metadata.fb_status` marker for destinations.
--
-- The worker consumer used to read the destination row, edit the
-- whole metadata object in memory, and write it back — a
-- read-modify-write with no version or condition. Two outcomes
-- settling concurrently for the same destination could invert the
-- markers, a concurrent metadata write (e.g. the unmatched-flag
-- refresh, a reconnect clear) could be clobbered, and a marker
-- write landing after a reconnect-clear could re-stamp a stale
-- error. The marker is detail-only (the coarse status the settle
-- wrote is always right, and the next failure re-stamps), so the
-- race only ever degraded a label — but it is a real race, and the
-- fix is one statement, following the
-- `refresh_destination_unmatched_flag` precedent (same file
-- family, same `metadata = ...` single-statement shape):
--
--   set    -> metadata = metadata || '{"fb_status": "<marker>"}'
--   clear  -> metadata = metadata - 'fb_status'
--
-- The update is atomic at the statement level: concurrent marker
-- writes serialize on the row lock, concurrent metadata writers
-- can no longer lose each other's keys, and a clear can no
-- longer be undone by a stale in-memory copy.
--
-- The marker value is allowlisted to the
-- `DESTINATION_FB_STATUS_MARKERS` set in
-- packages/contracts/src/domain/facebook-page-status.ts (plus
-- 'paused', which the paused-marker rule writes through other
-- paths) — an unknown value raises instead of storing junk.
--
-- SECURITY DEFINER with EXECUTE revoked from PUBLIC, anon and
-- authenticated and granted only to service_role (the ADU
-- hardening pattern, 20261030140000): only the worker's
-- service-role client calls this. It takes no workspace or user
-- argument and performs no ownership check — the destination id
-- arrives from the worker's already-scoped settle path, exactly
-- like `refresh_destination_unmatched_flag`.
--
-- Applies automatically on merge via the Supabase GitHub
-- integration. The worker build that calls it must deploy after
-- this migration lands (same deploy order as the mirrors
-- columns in 20261109160900).

create or replace function public.apply_destination_fb_status_marker(
  p_destination_id uuid,
  p_marker text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_marker is not null and p_marker not in (
    'checkpoint', 'paused', 'invalid_token', 'page_not_accessible',
    'missing_page_access', 'missing_permission', 'check_developer_app',
    'account_suspended', '2fa_required_on_BM'
  ) then
    raise exception 'unknown fb_status marker: %', p_marker;
  end if;

  if p_marker is null then
    update public.destinations
       set metadata = metadata - 'fb_status',
           updated_at = now()
     where id = p_destination_id;
  else
    update public.destinations
       set metadata = metadata || jsonb_build_object('fb_status', p_marker),
           updated_at = now()
     where id = p_destination_id;
  end if;
end;
$$;

revoke execute on function public.apply_destination_fb_status_marker(uuid, text)
  from public, anon, authenticated;
grant execute on function public.apply_destination_fb_status_marker(uuid, text)
  to service_role;
