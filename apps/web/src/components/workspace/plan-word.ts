import { useSharedEntitlement } from '@/components/billing/entitlement-provider';

/**
 * The word shown under "FBUploadPro" in the sidebar header brand
 * block, in place of "Studio". It is the user's plan, derived from
 * the tenant layout's shared entitlement query — never a separate
 * plan API and never a second fetch (the gate reads the same data,
 * so the word and the dialog can never disagree):
 *
 * - Admin — the session role is admin (admins bypass plans entirely).
 * - Paid — the proven plan is `paid`.
 * - Expired — the proven plan is `expired` (no active period, but
 *   the user held a paid period before). The plan value is explicit
 *   in the contract; it is never re-derived here from `active` +
 *   `hasPriorPeriod`, so the word cannot drift from the gate or
 *   Home, which read the same value.
 * - Free — the proven plan is `free`.
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
  entitlement: { plan: 'free' | 'paid' | 'expired' } | null,
  isAdmin: boolean
): PlanWord | null {
  if (isAdmin) return 'Admin';
  if (entitlement === null) return null;
  if (entitlement.plan === 'paid') return 'Paid';
  if (entitlement.plan === 'expired') return 'Expired';
  return 'Free';
}

/**
 * Sidebar plan word. Admins resolve immediately with no fetch (the
 * admin-only shell never needs an entitlement). Everyone else reads
 * the shared entitlement query owned by the tenant layout: the
 * provider seeds it once per session from the server and never
 * refetches on its own, so the word refreshes only after a purchase
 * or a manual refresh — no polling, no second client, no custom cache.
 */
export function usePlanWord(adminOnly: boolean): PlanWord | null {
  const { entitlement } = useSharedEntitlement();
  return planWordFromEntitlement(entitlement, adminOnly);
}
