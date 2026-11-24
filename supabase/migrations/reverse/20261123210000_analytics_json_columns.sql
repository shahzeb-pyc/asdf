-- Spec 241 reverse — drop the analytics JSON columns.
-- Forward: supabase/migrations/20261123210000_analytics_json_columns.sql

ALTER TABLE public.destinations DROP COLUMN IF EXISTS analytics_1d;
ALTER TABLE public.destinations DROP COLUMN IF EXISTS analytics_7d;
ALTER TABLE public.destinations DROP COLUMN IF EXISTS analytics_28d;
ALTER TABLE public.destinations DROP COLUMN IF EXISTS analytics_locations;

ALTER TABLE public.adu_configs DROP COLUMN IF EXISTS analytics_1d;
ALTER TABLE public.adu_configs DROP COLUMN IF EXISTS analytics_7d;
ALTER TABLE public.adu_configs DROP COLUMN IF EXISTS analytics_28d;
ALTER TABLE public.adu_configs DROP COLUMN IF EXISTS analytics_locations;
ALTER TABLE public.adu_configs DROP COLUMN IF EXISTS analytics_updated_at;

ALTER TABLE public.mirrors DROP COLUMN IF EXISTS analytics_1d;
ALTER TABLE public.mirrors DROP COLUMN IF EXISTS analytics_7d;
ALTER TABLE public.mirrors DROP COLUMN IF EXISTS analytics_28d;
ALTER TABLE public.mirrors DROP COLUMN IF EXISTS analytics_locations;
ALTER TABLE public.mirrors DROP COLUMN IF EXISTS analytics_updated_at;
