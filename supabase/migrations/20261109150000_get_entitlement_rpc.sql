-- Migration: 20261109150000_get_entitlement_rpc.sql
-- Plan-check C2: single-query entitlement RPC.
--
-- Replaces the 9-15 sequential queries inside web
-- `getEntitlement` (active period + disconnected-destination
-- lookups + six per-platform counts + ever-paid flag) with one
-- Postgres function call. The TypeScript `getEntitlement`
-- becomes a thin mapper over this result; its return shape and
-- error contract are unchanged, and the old query implementation
-- stays in the codebase as the documented fallback
-- (`getEntitlementViaQueries`) until the parity tests pass in
-- CI. Rollback is a one-line revert in `getEntitlement` (see
-- the PR body).
--
-- Parity notes — the SQL below mirrors the TypeScript reads
-- exactly, including the edge cases:
-- * Active period: non-superseded row with
--   starts_at <= now < ends_at, latest ends_at first
--   (matches `getActivePeriod`).
-- * Usage counts: one count per platform over
--   `subscription_usage`, excluding the three legacy
--   publish-now features (audit fix 2026-11-01: Publish Now
--   writes no usage rows, but pre-fix rows still exist and must
--   never count). Disconnected destinations are excluded by
--   link, not by subtraction: a usage row whose
--   `destination_id` points at a `destinations` row with
--   status 'disconnected' in one of the user's own workspaces
--   (and the same platform — the TypeScript groups the
--   disconnected ids per platform) does not count. Rows with a
--   NULL `destination_id` link to nothing and keep counting,
--   exactly as before. Excluding directly is identical to the
--   old raw-minus-disconnected arithmetic (same feature
--   exclusions on both counts) and can never go negative.
-- * Ever-paid flag: ANY `subscription_periods` row for the
--   user, active or lapsed (matches `hasAnyPeriod`).
-- * Downgrade activation stays OUT of this function: it is a
--   write, and C3 owns moving it out of the read path. The
--   TypeScript mapper still runs it in TS, with the same
--   semantics as before, when no active period is returned.
--
-- Security: SECURITY DEFINER, STABLE, read-only. The
-- subscription tables have RLS enabled with no permissive
-- policies (20261030120003), so only the service role reaches
-- them; this function follows the claim-RPC convention
-- (20261102160000): EXECUTE revoked from PUBLIC/anon/
-- authenticated, granted to service_role only. Every web
-- caller passes the service-role billing client, and the
-- function only ever reads rows for the `p_user_id` the server
-- passes in (the session user id from the verified token —
-- the same trust the previous per-table queries ran under).
-- It writes nothing and takes no role/status input.

CREATE OR REPLACE FUNCTION public.get_entitlement(
  p_user_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH active_period AS (
    SELECT
      p.id,
      p.user_id,
      p.facebook_count,
      p.instagram_count,
      p.threads_count,
      p.x_count,
      p.tiktok_count,
      p.youtube_count,
      p.starts_at,
      p.ends_at,
      p.superseded_at
    FROM public.subscription_periods p
    WHERE p.user_id = p_user_id
      AND p.superseded_at IS NULL
      AND p.starts_at <= p_now
      AND p.ends_at > p_now
    ORDER BY p.ends_at DESC
    LIMIT 1
  ),
  disconnected AS (
    SELECT d.id, d.platform
    FROM public.destinations d
    JOIN public.workspaces w ON w.id = d.workspace_id
    WHERE w.owner_id = p_user_id
      AND d.status = 'disconnected'
  ),
  usage_counts AS (
    SELECT
      count(*) FILTER (
        WHERE u.platform = 'facebook'
          AND u.feature <> 'publish-now'
          AND u.feature <> 'instagram-publish-now'
          AND u.feature <> 'threads-publish-now'
          AND NOT EXISTS (
            SELECT 1 FROM disconnected d
            WHERE d.id = u.destination_id
              AND d.platform::text = u.platform
          )
      ) AS facebook,
      count(*) FILTER (
        WHERE u.platform = 'instagram'
          AND u.feature <> 'publish-now'
          AND u.feature <> 'instagram-publish-now'
          AND u.feature <> 'threads-publish-now'
          AND NOT EXISTS (
            SELECT 1 FROM disconnected d
            WHERE d.id = u.destination_id
              AND d.platform::text = u.platform
          )
      ) AS instagram,
      count(*) FILTER (
        WHERE u.platform = 'threads'
          AND u.feature <> 'publish-now'
          AND u.feature <> 'instagram-publish-now'
          AND u.feature <> 'threads-publish-now'
          AND NOT EXISTS (
            SELECT 1 FROM disconnected d
            WHERE d.id = u.destination_id
              AND d.platform::text = u.platform
          )
      ) AS threads,
      count(*) FILTER (
        WHERE u.platform = 'x'
          AND u.feature <> 'publish-now'
          AND u.feature <> 'instagram-publish-now'
          AND u.feature <> 'threads-publish-now'
          AND NOT EXISTS (
            SELECT 1 FROM disconnected d
            WHERE d.id = u.destination_id
              AND d.platform::text = u.platform
          )
      ) AS x,
      count(*) FILTER (
        WHERE u.platform = 'tiktok'
          AND u.feature <> 'publish-now'
          AND u.feature <> 'instagram-publish-now'
          AND u.feature <> 'threads-publish-now'
          AND NOT EXISTS (
            SELECT 1 FROM disconnected d
            WHERE d.id = u.destination_id
              AND d.platform::text = u.platform
          )
      ) AS tiktok,
      count(*) FILTER (
        WHERE u.platform = 'youtube'
          AND u.feature <> 'publish-now'
          AND u.feature <> 'instagram-publish-now'
          AND u.feature <> 'threads-publish-now'
          AND NOT EXISTS (
            SELECT 1 FROM disconnected d
            WHERE d.id = u.destination_id
              AND d.platform::text = u.platform
          )
      ) AS youtube
    FROM public.subscription_usage u
    WHERE u.user_id = p_user_id
  )
  SELECT jsonb_build_object(
    'period', (SELECT row_to_json(a) FROM active_period a),
    'usage', (SELECT row_to_json(c) FROM usage_counts c),
    'has_prior_period', EXISTS (
      SELECT 1 FROM public.subscription_periods p
      WHERE p.user_id = p_user_id
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.get_entitlement(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_entitlement(uuid, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.get_entitlement(uuid, timestamptz) IS
  'Plan-check C2: one-round-trip entitlement read (active period + six usage counts + ever-paid flag). Read-only; SECURITY DEFINER, service_role only. Downgrade activation stays in TypeScript (C3 owns the move).';
