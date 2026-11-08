/**
 * Tenant Home — server-only data loading.
 *
 * One load for the whole home page, reusing the page's existing
 * server pattern (session from `getServerSessionContext`, queries on
 * the service-role admin client, every row scoped to the resolved
 * workspace or the session user — the same discipline as
 * `workspace-display-name.ts`).
 *
 * HARD CONSTRAINT: no queues or posts data anywhere. This module
 * never reads `queue_items`, never counts scheduled/published/failed
 * posts, and never links to Queue or Calendar.
 *
 * The redesigned Home renders only the plan card, quick links and
 * the Muse rail, so the loader loads only what those render: the
 * active subscription period (per-platform counts, start and end)
 * and the media storage quota state. Destination, attention and
 * follower queries from the old dashboard were removed with the
 * sections that rendered them — they are not loaded speculatively.
 *
 * Failure contract: every failure (no session, no admin client,
 * unknown workspace, an active entitlement without a period, a
 * failed query) is logged loudly and resolves to the `error`
 * variant — the page renders a visible error card, never invented
 * numbers and never a silent partial dashboard.
 */
import { totalUnits, type PlatformCounts } from '@fbuploadpro/contracts';

import { getServerSessionContext } from '@/lib/auth';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { getCachedEntitlement, getEntitlement, type Entitlement } from '@/lib/billing/entitlement';
import { getStorageQuotaState as getStorageState } from '@/lib/billing/storage-quota';
import { logServerError } from '@/lib/server-analytics';
import { getWorkspaceIdentity } from '../../app/tenant/[subdomain]/workspace-display-name';

export interface HomePaidData {
  kind: 'paid';
  periodStartsAt: Date;
  periodEndsAt: Date;
  units: number;
  platformCounts: PlatformCounts;
  storageUsedBytes: number;
  storageQuotaBytes: number;
}

export type HomeData =
  | { kind: 'admin' }
  | { kind: 'free' }
  | { kind: 'expired' }
  | HomePaidData
  | { kind: 'error'; message: string };

function errorResult(message: string, err: unknown): { kind: 'error'; message: string } {
  logServerError('[home] data load failed', err, { source: 'home' });
  return { kind: 'error', message };
}

export async function loadHomeData(subdomain: string): Promise<HomeData> {
  try {
    const session = await getServerSessionContext();
    if (!session) {
      return {
        kind: 'error',
        message: 'Home data could not be loaded. Please sign in again.',
      };
    }
    if (session.role === 'admin') return { kind: 'admin' };

    const supabase = getSupabaseAdminClient();
    if (!supabase) {
      return errorResult(
        'Home data could not be loaded. Please try again.',
        new Error('Supabase admin client unavailable')
      );
    }

    // Workspace identity resolves through the tenant layout's cached
    // resolver (workspace-display-name.ts) — the layout, the hero name
    // and this loader share ONE workspaces lookup per request instead
    // of each performing it. A null identity means the workspace does
    // not exist for this owner (a lookup failure is already reported
    // loudly by the resolver itself).
    const identity = await getWorkspaceIdentity(subdomain);
    if (typeof identity?.id !== 'string') {
      return {
        kind: 'error',
        message: 'This workspace could not be found.',
      };
    }

    // Plan-check R1: the tenant layout already read the
    // entitlement for this request (the seed), so read the cached
    // answer instead of paying for a second full read. The two reads
    // are milliseconds apart with no subscription write between
    // them, so the shared answer is exact, not approximate.
    //
    // Fallback (the gate fails CLOSED): if the cached read fails —
    // the seed failed, or the seed never ran for this request —
    // read on our own, exactly as before. A failed seed must never
    // leave Home with no answer, and a failed read must never
    // render invented numbers: a failure of both reads falls
    // through to the `error` variant via the outer catch.
    let entitlement: Entitlement;
    try {
      entitlement = await getCachedEntitlement(supabase, session.userId);
    } catch (err) {
      // Loud, then recover: the layout already logs a failed seed,
      // but a cached read can also fail on a request where the
      // layout never ran (RSC navigation), so the fallback is
      // logged at its own site instead of silently recovering.
      logServerError('[home] cached entitlement read failed, falling back to a fresh read', err, {
        source: 'home',
      });
      entitlement = await getEntitlement(supabase, session.userId);
    }
    const isPaidActive = entitlement.plan === 'paid' && entitlement.active;
    // Expired is an explicit plan value — never re-derived here, so
    // Home's card cannot disagree with the sidebar word or the gate.
    const isExpired = entitlement.plan === 'expired';
    if (!isPaidActive) {
      return { kind: isExpired ? 'expired' : 'free' };
    }
    const period = entitlement.period;
    if (!period) {
      return errorResult(
        'Home data could not be loaded. Please try again.',
        new Error('Active entitlement without a period row')
      );
    }

    const storage = await getStorageState(supabase, session.userId);

    return {
      kind: 'paid',
      periodStartsAt: period.startsAt,
      periodEndsAt: period.endsAt,
      units: totalUnits(period.counts),
      platformCounts: period.counts,
      storageUsedBytes: storage.usedBytes,
      storageQuotaBytes: storage.quotaBytes,
    };
  } catch (err) {
    return errorResult('Home data could not be loaded. Please try again.', err);
  }
}
