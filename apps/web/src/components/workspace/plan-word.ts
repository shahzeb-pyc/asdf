import { useQuery } from '@tanstack/react-query';
import { apiGet, buildTenantApiPath } from '@/lib/api';
import { EntitlementResponseSchema } from '@/lib/api/schemas/billing';

/**
 * The word shown under "FBUploadPro" in the sidebar header brand
 * block, in place of "Studio". It is the user's plan, derived from
 * the billing entitlement endpoint — never a separate plan API:
 *
 * - Admin — the session role is admin (admins bypass plans entirely).
 * - Paid — an active paid period exists.
 * - Expired — no active period, but the user has held a paid period
 *   before (hasPriorPeriod). The active-period fields alone cannot
 *   tell this from never-paid: both report null period bounds.
 * - Free — no active period and no prior period.
 *
 * The hook returns null while the entitlement is unresolved OR the
 * fetch failed. The caller renders the "Studio" placeholder in that
 * case — a wrong plan word must never flash, and a failed check
 * must never masquerade as Free.
 */
export type PlanWord = 'Admin' | 'Paid' | 'Expired' | 'Free';

export function planWordFromEntitlement(
  entitlement: { active: boolean; hasPriorPeriod: boolean } | null,
  isAdmin: boolean
): PlanWord | null {
  if (isAdmin) return 'Admin';
  if (entitlement === null) return null;
  if (entitlement.active) return 'Paid';
  if (entitlement.hasPriorPeriod) return 'Expired';
  return 'Free';
}

/**
 * Sidebar plan word. Admins resolve immediately with no fetch (the
 * admin-only shell never needs an entitlement). Everyone else reads
 * the entitlement endpoint via React Query: staleTime 0 so the word
 * refreshes on mount and on window focus (the app default) whenever
 * the plan changes — no polling, no second client, no custom cache.
 */
export function usePlanWord(subdomain: string, adminOnly: boolean): PlanWord | null {
  const entitlementQuery = useQuery({
    queryKey: ['tenant', subdomain, 'billing', 'entitlement'],
    queryFn: () =>
      apiGet(buildTenantApiPath(subdomain, '/billing/entitlement'), {
        schema: EntitlementResponseSchema,
      }),
    enabled: !adminOnly,
    staleTime: 0,
  });
  return planWordFromEntitlement(
    entitlementQuery.data ?? null,
    adminOnly
  );
}
