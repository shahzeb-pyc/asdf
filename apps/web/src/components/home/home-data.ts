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
 * posts, and never links to Queue or Calendar. The only scheduling
 * fact it reads is slot existence for the setup checklist (a posting
 * time configured, not a post).
 *
 * Failure contract: any failure (no session, no admin client, unknown
 * workspace, any query error) is logged loudly and resolves to the
 * `error` variant — the page renders a visible error card, never
 * invented numbers and never a silent partial dashboard.
 */
import { totalUnits } from '@fbuploadpro/contracts';

import { getServerSessionContext } from '@/lib/auth';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { getEntitlement } from '@/lib/billing/entitlement';
import { getStorageQuotaState as getStorageState } from '@/lib/billing/storage-quota';
import { logServerError } from '@/lib/server-analytics';
import { unifiedDestinationStatusToWire } from '@/lib/server/facebook-wire';

import type { HomeAttentionStatus } from './home-helpers';

export interface HomeAttentionItem {
  id: string;
  name: string;
  platform: string;
  status: HomeAttentionStatus;
  reason: string;
}

export interface HomePaidData {
  kind: 'paid';
  periodEndsAt: Date;
  units: number;
  totalDestinations: number;
  activeDestinations: number;
  facebookAccounts: number;
  accountsCount: number;
  hasActiveSlot: boolean;
  firstFacebookPageId: string | null;
  attention: HomeAttentionItem[];
  attentionTotal: number;
  followersGained: number;
  storageUsedBytes: number;
  storageQuotaBytes: number;
}

export type HomeData =
  | { kind: 'admin' }
  | { kind: 'free' }
  | { kind: 'expired' }
  | HomePaidData
  | { kind: 'error'; message: string };

const ATTENTION_PAGE_LIMIT = 20;
const FOLLOWERS_PAGE_SIZE = 1000;

const ATTENTION_REASONS: Record<HomeAttentionStatus, string> = {
  paused: 'Paused',
  fb_rate_limited: 'Facebook rate limit',
  page_checkpoint: 'Facebook checkpoint — action needed',
  invalid_token: 'Session expired — reconnect the account',
  disconnected: 'Disconnected',
};

interface DestinationRow {
  id: string;
  name: string;
  platform: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function asDestinationRow(value: unknown): DestinationRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.platform !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.created_at !== 'string'
  ) {
    return null;
  }
  const metadata =
    row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    status: row.status,
    metadata,
    created_at: row.created_at,
  };
}

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

    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id')
      .eq('subdomain', subdomain)
      .eq('owner_id', session.userId)
      .maybeSingle();
    if (workspaceError) {
      return errorResult('Home data could not be loaded. Please try again.', workspaceError);
    }
    const workspaceId = (workspace as { id?: unknown } | null)?.id;
    if (typeof workspaceId !== 'string') {
      return {
        kind: 'error',
        message: 'This workspace could not be found.',
      };
    }

    const entitlement = await getEntitlement(supabase, session.userId);
    const isPaidActive = entitlement.plan === 'paid' && entitlement.active;
    const isExpired =
      (entitlement.plan === 'paid' && !entitlement.active) ||
      (entitlement.plan === 'free' && entitlement.hasPriorPeriod);
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

    const [
      totalCount,
      activeCount,
      nonActiveCount,
      facebookAccountsCount,
      accountsCount,
      nonActiveRows,
      firstFacebookPage,
      activeSlotRows,
      storage,
      followersGained,
    ] = await Promise.all([
      supabase
        .from('destinations')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId),
      supabase
        .from('destinations')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'active'),
      supabase
        .from('destinations')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .neq('status', 'active'),
      supabase
        .from('social_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook'),
      supabase
        .from('social_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId),
      supabase
        .from('destinations')
        .select('id, name, platform, status, metadata, created_at')
        .eq('workspace_id', workspaceId)
        .neq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(ATTENTION_PAGE_LIMIT),
      supabase
        .from('destinations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook')
        .order('created_at', { ascending: true })
        .limit(1),
      supabase
        .from('posting_slots')
        .select('id, destinations!inner(workspace_id)')
        .eq('destinations.workspace_id', workspaceId)
        .eq('is_active', true)
        .limit(1),
      getStorageState(supabase, session.userId),
      (async () => {
        // Paged, never unbounded: PostgREST silently truncates at
        // 1,000 rows, which would under-report the total.
        let total = 0;
        let from = 0;
        for (;;) {
          const { data, error } = await supabase
            .from('adu_configs')
            .select('followers_gained')
            .eq('workspace_id', workspaceId)
            .range(from, from + FOLLOWERS_PAGE_SIZE - 1);
          if (error) throw error;
          const rows = (
            Array.isArray(data) ? data : []
          ) as Array<{ followers_gained?: unknown }>;
          for (const row of rows) {
            const value =
              typeof row.followers_gained === 'number' ? row.followers_gained : 0;
            total += value;
          }
          if (rows.length < FOLLOWERS_PAGE_SIZE) break;
          from += FOLLOWERS_PAGE_SIZE;
        }
        return total;
      })(),
    ]);

    const queryErrors = [
      totalCount.error,
      activeCount.error,
      nonActiveCount.error,
      facebookAccountsCount.error,
      accountsCount.error,
      nonActiveRows.error,
      firstFacebookPage.error,
      activeSlotRows.error,
    ].filter(Boolean);
    if (queryErrors.length > 0) {
      return errorResult(
        'Home data could not be loaded. Please try again.',
        queryErrors[0]
      );
    }

    const attention: HomeAttentionItem[] = [];
    for (const raw of (nonActiveRows.data ?? []) as unknown[]) {
      const row = asDestinationRow(raw);
      if (!row) continue;
      const wire = unifiedDestinationStatusToWire(row.status, row.metadata);
      if (wire === 'active') continue;
      attention.push({
        id: row.id,
        name: row.name,
        platform: row.platform,
        status: wire,
        reason: ATTENTION_REASONS[wire],
      });
    }

    const firstFacebookPageRow = (firstFacebookPage.data ?? []) as Array<{
      id?: unknown;
    }>;
    const firstFacebookPageId =
      typeof firstFacebookPageRow[0]?.id === 'string'
        ? (firstFacebookPageRow[0].id as string)
        : null;

    return {
      kind: 'paid',
      periodEndsAt: period.endsAt,
      units: totalUnits(period.counts),
      totalDestinations: totalCount.count ?? 0,
      activeDestinations: activeCount.count ?? 0,
      facebookAccounts: facebookAccountsCount.count ?? 0,
      accountsCount: accountsCount.count ?? 0,
      hasActiveSlot: Array.isArray(activeSlotRows.data) && activeSlotRows.data.length > 0,
      firstFacebookPageId,
      attention,
      attentionTotal: nonActiveCount.count ?? attention.length,
      followersGained,
      storageUsedBytes: storage.usedBytes,
      storageQuotaBytes: storage.quotaBytes,
    };
  } catch (err) {
    return errorResult('Home data could not be loaded. Please try again.', err);
  }
}
