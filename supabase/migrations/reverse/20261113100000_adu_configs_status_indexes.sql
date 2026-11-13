-- Reverse of 20261113100000_adu_configs_status_indexes.sql
-- (ADU optimization Stream A, F9/F10). Drops the two
-- status-filtered hub indexes on adu_configs. Status-filtered hub
-- loads fall back to the pre-existing
-- (workspace_id, created_at DESC) index plus a filter, and the
-- followers sorts fall back to sorting — the pre-migration
-- behaviour, with no data change (indexes only).
DROP INDEX IF EXISTS public.idx_adu_configs_workspace_status_created;
DROP INDEX IF EXISTS public.idx_adu_configs_workspace_status_followers;
