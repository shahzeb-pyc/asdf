-- Spec 241 — Facebook insights analytics: stored JSON columns.
--
-- Each Facebook page record carries its analytics in four JSONB
-- columns, filled once a day by the 03:00 PKT insights cycle
-- (apps/worker/src/insights-followers-tick.ts) and read by the
-- combined Analytics page. Facebook values only; no page name or
-- identity inside the JSON (the record already identifies the page).
--
--   analytics_1d          one flat object, the latest day only
--   analytics_7d          { days: [7 entries, oldest first],
--                           unique_viewers_7d: <Facebook week value> }
--   analytics_28d         { days: [28 entries, oldest first],
--                           unique_viewers_28d: <Facebook days_28 value> }
--   analytics_locations   { countries: [{ country: "<ISO>", followers }],
--                           cities: [{ city: "<name>", followers }] }
--                         EVERY country and city Facebook returns,
--                         complete and untrimmed (display shows top 6).
--
-- All columns NULL, no backfill — the worker fills them on the next
-- run; a failed fetch leaves them untouched. analytics_updated_at
-- stamps the last SUCCESSFUL analytics fetch: a real column on
-- adu_configs / mirrors, and a destinations.metadata key (same
-- pattern as followers_updated_at). No SECURITY DEFINER, no RPC
-- changes: no RPC SELECTs * from these three tables (verified at
-- build time — the only SELECT * hits in migrations are on
-- jsonb_array_elements and public.users).
--
-- No index is needed: the read path filters by workspace_id /
-- platform on already-indexed columns and pages through results;
-- the JSON columns themselves are never filtered on.

ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS analytics_1d jsonb;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS analytics_7d jsonb;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS analytics_28d jsonb;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS analytics_locations jsonb;

ALTER TABLE public.adu_configs ADD COLUMN IF NOT EXISTS analytics_1d jsonb;
ALTER TABLE public.adu_configs ADD COLUMN IF NOT EXISTS analytics_7d jsonb;
ALTER TABLE public.adu_configs ADD COLUMN IF NOT EXISTS analytics_28d jsonb;
ALTER TABLE public.adu_configs ADD COLUMN IF NOT EXISTS analytics_locations jsonb;
ALTER TABLE public.adu_configs ADD COLUMN IF NOT EXISTS analytics_updated_at timestamptz;

ALTER TABLE public.mirrors ADD COLUMN IF NOT EXISTS analytics_1d jsonb;
ALTER TABLE public.mirrors ADD COLUMN IF NOT EXISTS analytics_7d jsonb;
ALTER TABLE public.mirrors ADD COLUMN IF NOT EXISTS analytics_28d jsonb;
ALTER TABLE public.mirrors ADD COLUMN IF NOT EXISTS analytics_locations jsonb;
ALTER TABLE public.mirrors ADD COLUMN IF NOT EXISTS analytics_updated_at timestamptz;
