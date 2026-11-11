-- Spec 166 (PR A) — destinations table split, step 1: create the three
-- section tables + the reconciliation view. Additive only: no code reads
-- these tables yet and the old `destinations` table stays the live table.
--
-- Design (spec.md §4): one table per section — `schedule_destinations`
-- (Schedule / In-App Schedule, custom posts), `adu_destinations` (Auto
-- Download/Upload), `mirror_destinations` (Auto Repost / TikTok mirrors).
-- Each table is byte-identical to the CURRENT `destinations` columns —
-- 20261022120000 §4c as amended since: `next_allowed_publish_at` was
-- dropped by 20261102160000 (cooldown-pacing removal) and the
-- token-refresh lease pair `refresh_lease_owner` /
-- `refresh_lease_expires_at` was added by 20261022130000 (spec 121
-- Scope 9, per-connection single-flight lease) — plus ONE extra column
-- `source_destination_id` (UUID NULL, provenance — NOT a foreign key).
-- All three copies get NEW ids at backfill; the old table is never
-- re-pointed in this PR.
--
-- RLS note: spec.md §4.2 says "no permissive policies", but the actual
-- `destinations` DDL in 20261022120000 §5 has ENABLE ROW LEVEL SECURITY
-- PLUS a `destinations_workspace_owner_access` policy (FOR ALL TO
-- authenticated, workspace-owner check). The source DDL wins: each new
-- table replicates that exact policy and the `trg_*_updated_at` BEFORE
-- UPDATE trigger calling `public.set_updated_at()`.
--
-- No SECURITY DEFINER function is created here. No list endpoint is
-- added. The reconciliation view (spec.md §8) is read-only.

-- -----------------------------------------------------------------------------
-- 1. schedule_destinations
-- -----------------------------------------------------------------------------
CREATE TABLE public.schedule_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  platform public.platform NOT NULL,
  external_destination_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  handle VARCHAR(255) NULL,
  avatar_url TEXT NULL,
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  status VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rate_limited', 'disconnected', 'error')),
  encrypted_destination_token TEXT NULL,
  rate_usage_pct SMALLINT NOT NULL DEFAULT 0 CHECK (rate_usage_pct BETWEEN 0 AND 100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refresh_lease_owner TEXT NULL,
  refresh_lease_expires_at TIMESTAMPTZ NULL,
  source_destination_id UUID NULL,
  CONSTRAINT uq_schedule_destinations_account_external UNIQUE (account_id, external_destination_id)
);
CREATE INDEX idx_schedule_destinations_account_id ON public.schedule_destinations (account_id);
CREATE INDEX idx_schedule_destinations_workspace_id ON public.schedule_destinations (workspace_id);

-- -----------------------------------------------------------------------------
-- 2. adu_destinations
-- -----------------------------------------------------------------------------
CREATE TABLE public.adu_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  platform public.platform NOT NULL,
  external_destination_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  handle VARCHAR(255) NULL,
  avatar_url TEXT NULL,
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  status VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rate_limited', 'disconnected', 'error')),
  encrypted_destination_token TEXT NULL,
  rate_usage_pct SMALLINT NOT NULL DEFAULT 0 CHECK (rate_usage_pct BETWEEN 0 AND 100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refresh_lease_owner TEXT NULL,
  refresh_lease_expires_at TIMESTAMPTZ NULL,
  source_destination_id UUID NULL,
  CONSTRAINT uq_adu_destinations_account_external UNIQUE (account_id, external_destination_id)
);
CREATE INDEX idx_adu_destinations_account_id ON public.adu_destinations (account_id);
CREATE INDEX idx_adu_destinations_workspace_id ON public.adu_destinations (workspace_id);

-- -----------------------------------------------------------------------------
-- 3. mirror_destinations
-- -----------------------------------------------------------------------------
CREATE TABLE public.mirror_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  platform public.platform NOT NULL,
  external_destination_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  handle VARCHAR(255) NULL,
  avatar_url TEXT NULL,
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  status VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rate_limited', 'disconnected', 'error')),
  encrypted_destination_token TEXT NULL,
  rate_usage_pct SMALLINT NOT NULL DEFAULT 0 CHECK (rate_usage_pct BETWEEN 0 AND 100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refresh_lease_owner TEXT NULL,
  refresh_lease_expires_at TIMESTAMPTZ NULL,
  source_destination_id UUID NULL,
  CONSTRAINT uq_mirror_destinations_account_external UNIQUE (account_id, external_destination_id)
);
CREATE INDEX idx_mirror_destinations_account_id ON public.mirror_destinations (account_id);
CREATE INDEX idx_mirror_destinations_workspace_id ON public.mirror_destinations (workspace_id);

-- -----------------------------------------------------------------------------
-- 4. RLS + workspace-owner policies (mirroring `destinations`, §5 of
--    20261022120000) + updated_at triggers
-- -----------------------------------------------------------------------------
ALTER TABLE public.schedule_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adu_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mirror_destinations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "schedule_destinations_workspace_owner_access" ON public.schedule_destinations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid()));

CREATE POLICY "adu_destinations_workspace_owner_access" ON public.adu_destinations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid()));

CREATE POLICY "mirror_destinations_workspace_owner_access" ON public.mirror_destinations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid()));

DROP TRIGGER IF EXISTS trg_schedule_destinations_updated_at ON public.schedule_destinations;
CREATE TRIGGER trg_schedule_destinations_updated_at
  BEFORE UPDATE ON public.schedule_destinations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_adu_destinations_updated_at ON public.adu_destinations;
CREATE TRIGGER trg_adu_destinations_updated_at
  BEFORE UPDATE ON public.adu_destinations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_mirror_destinations_updated_at ON public.mirror_destinations;
CREATE TRIGGER trg_mirror_destinations_updated_at
  BEFORE UPDATE ON public.mirror_destinations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Reconciliation view (spec.md §8) — STRUCTURAL breaks only.
--
-- Semantic divergence is NOT flagged: under owner decision 1 the copies
-- are independent by design (Schedule paused while ADU is active is
-- normal; a token refreshed in Schedule but stale in ADU is normal).
-- One row per problem, with `kind`, `section`, `external_id`, and the
-- old `source_destination_id` (NULL when no old row matches, e.g. a
-- mirror target that never had a `destinations` row).
--
-- Kinds:
--   orphan_child  — a child row (or mirror target) whose section has no
--                   copy for that page. One row per (old destination,
--                   section); for mirrors, one row per distinct target.
--                   This is spec §8 items 2 (orphan child) and 3
--                   (backfill gap, per-section form) — the same
--                   structural fact viewed from the child side and the
--                   parent side, so it is emitted once, not twice.
--   backfill_gap  — an old `destinations` row with NO copy in ANY
--                   section AND no membership anywhere (no child row
--                   in any section table, no mirror target) — the
--                   §7.2 default arm failed for a never-added page.
--                   Section is 'none'. Disjoint from `orphan_child`
--                   by construction (a child-bearing row is flagged
--                   there, never here), so one problem is one row.
--   orphan_copy   — a copy whose account_id no longer exists in
--                   `social_accounts` (FK CASCADE should prevent this;
--                   belt-and-braces, spec §8 item 4).
-- Token-decrypt integrity (spec §8 item 1) is NOT in this view: SQL
-- cannot decrypt. It is the separate scripted gate (§7.4.2).
-- "Has a copy" is judged by canonical identity
-- (account_id, external_destination_id), not by provenance, so a copy
-- created after the split (NULL provenance) still counts as a copy.
-- -----------------------------------------------------------------------------
CREATE VIEW public.section_destination_reconciliation AS
-- (1) Schedule orphan: old row with Schedule children, no Schedule copy.
SELECT 'orphan_child'::text AS kind,
       'schedule'::text AS section,
       d.external_destination_id AS external_id,
       d.id AS source_destination_id
FROM public.destinations d
WHERE (
  EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id)
  OR EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id)
  OR EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id)
  OR EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)
)
AND NOT EXISTS (
  SELECT 1 FROM public.schedule_destinations sd
  WHERE sd.account_id = d.account_id
    AND sd.external_destination_id = d.external_destination_id
)
UNION ALL
-- (2) ADU orphan: old row referenced by adu_configs, no ADU copy.
SELECT 'orphan_child'::text AS kind,
       'adu'::text AS section,
       d.external_destination_id AS external_id,
       d.id AS source_destination_id
FROM public.destinations d
WHERE EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id)
AND NOT EXISTS (
  SELECT 1 FROM public.adu_destinations ad
  WHERE ad.account_id = d.account_id
    AND ad.external_destination_id = d.external_destination_id
)
UNION ALL
-- (3) Mirror orphan: a mirrors target with no mirror copy.
-- `mirrors.target_platform` is TEXT (20261029160000), so the platform
-- comparison casts the enum to text. One row per distinct target.
SELECT DISTINCT 'orphan_child'::text AS kind,
       'mirror'::text AS section,
       m.target_external_id AS external_id,
       (SELECT d.id FROM public.destinations d
         WHERE d.workspace_id = m.workspace_id
           AND d.platform::text = m.target_platform
           AND d.external_destination_id = m.target_external_id
         LIMIT 1) AS source_destination_id
FROM public.mirrors m
WHERE NOT EXISTS (
  SELECT 1 FROM public.mirror_destinations md
  WHERE md.workspace_id = m.workspace_id
    AND md.platform::text = m.target_platform
    AND md.external_destination_id = m.target_external_id
)
UNION ALL
-- (4) Backfill gap: never-added old row (no membership anywhere)
-- with no copy in any section — the §7.2 default arm failed.
SELECT 'backfill_gap'::text AS kind,
       'none'::text AS section,
       d.external_destination_id AS external_id,
       d.id AS source_destination_id
FROM public.destinations d
WHERE NOT EXISTS (
  SELECT 1 FROM public.schedule_destinations sd
  WHERE sd.account_id = d.account_id
    AND sd.external_destination_id = d.external_destination_id
)
AND NOT EXISTS (
  SELECT 1 FROM public.adu_destinations ad
  WHERE ad.account_id = d.account_id
    AND ad.external_destination_id = d.external_destination_id
)
AND NOT EXISTS (
  SELECT 1 FROM public.mirror_destinations md
  WHERE md.account_id = d.account_id
    AND md.external_destination_id = d.external_destination_id
)
AND NOT EXISTS (SELECT 1 FROM public.posting_slots ps WHERE ps.destination_id = d.id)
AND NOT EXISTS (SELECT 1 FROM public.queue_items qi WHERE qi.destination_id = d.id)
AND NOT EXISTS (SELECT 1 FROM public.publish_logs pl WHERE pl.destination_id = d.id)
AND NOT EXISTS (SELECT 1 FROM public.posting_slot_claims psc WHERE psc.destination_id = d.id)
AND NOT EXISTS (SELECT 1 FROM public.adu_configs ac WHERE ac.destination_id = d.id)
AND NOT EXISTS (
  SELECT 1 FROM public.mirrors m
  WHERE m.workspace_id = d.workspace_id
    AND m.target_platform = d.platform::text
    AND m.target_external_id = d.external_destination_id
)
UNION ALL
-- (5) Orphan copies: account gone from social_accounts (one row per copy).
SELECT 'orphan_copy'::text AS kind,
       'schedule'::text AS section,
       sd.external_destination_id AS external_id,
       sd.source_destination_id AS source_destination_id
FROM public.schedule_destinations sd
WHERE NOT EXISTS (SELECT 1 FROM public.social_accounts sa WHERE sa.id = sd.account_id)
UNION ALL
SELECT 'orphan_copy'::text AS kind,
       'adu'::text AS section,
       ad.external_destination_id AS external_id,
       ad.source_destination_id AS source_destination_id
FROM public.adu_destinations ad
WHERE NOT EXISTS (SELECT 1 FROM public.social_accounts sa WHERE sa.id = ad.account_id)
UNION ALL
SELECT 'orphan_copy'::text AS kind,
       'mirror'::text AS section,
       md.external_destination_id AS external_id,
       md.source_destination_id AS source_destination_id
FROM public.mirror_destinations md
WHERE NOT EXISTS (SELECT 1 FROM public.social_accounts sa WHERE sa.id = md.account_id);
