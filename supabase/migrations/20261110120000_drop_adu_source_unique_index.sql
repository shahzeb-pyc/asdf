-- Spec 161: allow the same source on multiple pages in Auto Download/Upload.
-- Drops the per-workspace source-uniqueness index. The destination-uniqueness
-- index (idx_adu_configs_destination_unique, one config per destination page)
-- is kept, and no code depends on the dropped index.
DROP INDEX IF EXISTS public.idx_adu_configs_workspace_source_unique;
