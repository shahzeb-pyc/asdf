-- Reverse of 20261113140000_adu_hub_counts.sql.
-- Drops adu_config_counts; the per-config count queries in
-- buildAduConfigView are the fallback (see the PGRST202 path in
-- loadAduConfigCounts), so reverting this migration alone degrades the
-- hub back to 7 trips per config instead of breaking it — but only
-- together with a code revert that removes the RPC call.
drop function if exists public.adu_config_counts(uuid, uuid[]);
