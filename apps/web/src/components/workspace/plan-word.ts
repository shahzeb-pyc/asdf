import { useSharedEntitlement } from '@/components/billing/entitlement-provider';

/**
 * The word shown under "FBUploadPro" in the sidebar header brand
 * block, in place of "Studio". It is the user's plan, derived from
 * the tenant layout's shared entitlement query — never a separate
 * plan API and never a second fetch (the gate reads the same data,
 * so the word and the dialog can never disagree):
 *
 * - Admin — the session role is admin (admins bypass plans entirely).
 * - Paid — an active paid period exists.
 * - Expired — no active period, but the user has held a paid period
 *   before (hasPriorPeriod). The active-period fields alone cannot
 *   tell this from never-paid: both report null period bounds.
 * - Free — no active period and no prior period.
 *
 * The hook returns null while the entitlement is unresolved OR the
 * check failed — including a failed refetch newer than the last
 * success, which clears the previously proven value instead of
 * letting a stale Free stick around. The caller renders the
 * "Studio" placeholder in that case — a wrong plan word must never
 * flash, and a failed check must never masquerade as Free.
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
 * the shared entitlement query owned by the tenant layout: the
 * provider fetches on mount and on window focus (the app default)
 * and re-checks on navigation, so the word refreshes whenever the
 * plan changes — no polling, no second client, no custom cache.
 */
export function usePlanWord(adminOnly: boolean): PlanWord | null {
  const { entitlement } = useSharedEntitlement();
  return planWordFromEntitlement(
    entitlement
      ? { active: entitlement.active, hasPriorPeriod: entitlement.hasPriorPeriod }
      : null,
    adminOnly
  );
}
