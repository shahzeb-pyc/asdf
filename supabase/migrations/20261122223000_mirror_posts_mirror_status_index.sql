-- Mirror counts index (spec 234, plan item 10).
--
-- Counting mirror posts by status — the list card's Posted/Failed
-- counts (`fetchMirrorPostCounts`, from
-- apps/web/src/app/api/tenant/[subdomain]/tiktok-mirrors/route.ts)
-- and the detail view's Posted/Failed/Skipped counts
-- (`fetchMirrorDashboardCounts`, from
-- apps/web/src/app/api/tenant/[subdomain]/tiktok-mirrors/[mirrorId]/route.ts)
-- filter on mirror id and status. The existing index
-- `idx_mirror_posts_mirror` on (mirror_id, created_at DESC) serves
-- the listing query (ORDER BY created_at DESC) but not the counts:
-- it carries no status, so every row of the mirror is heap-fetched
-- just to evaluate the status filter.
--
-- Index-only: neither caller is redefined, no grants change. This
-- is the smallest item in the plan (~1 second over four days,
-- a ceiling, not a forecast) — included only because it is correct
-- and free, not because it moves the total.
create index if not exists idx_mirror_posts_mirror_status
  on public.mirror_posts (mirror_id, status);
