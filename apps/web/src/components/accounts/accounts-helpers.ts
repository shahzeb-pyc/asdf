/**
 * Accounts list — pure helpers (spec 131 PR-131-1, spec §8.4 decomposition).
 *
 * Extracted verbatim from the former 1,208-line accounts route: the
 * sorting/filtering/subtitle computations, the BYOC gating predicate,
 * and the OAuth-return notice resolver. Names and behaviour are
 * preserved exactly — the parity suites (tests/ui/accounts.test.tsx)
 * import them from here, and the Accounts shell consumes the same
 * functions, so list ordering, subtitle copy, gating semantics, and
 * notice copy can never drift between the route and its tests.
 */
import {
  getAccountHealth,
  type AccountHealth,
} from '@/components/accounts/account-health';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

export type AccountStatusFilter = 'all' | 'active' | 'expiring_soon' | 'expired';

export function sortAccountsExpiredFirst(items: FacebookAccountItem[]): FacebookAccountItem[] {
  return [...items].sort((a, b) => {
    const aExpired = a.status === 'expired' ? 1 : 0;
    const bExpired = b.status === 'expired' ? 1 : 0;
    if (aExpired !== bExpired) {
      return bExpired - aExpired;
    }
    const aTime = Date.parse(a.createdAt) || 0;
    const bTime = Date.parse(b.createdAt) || 0;
    return bTime - aTime;
  });
}

export function filterAccountsList(
  items: FacebookAccountItem[],
  searchQuery: string,
  statusFilter: AccountStatusFilter
): FacebookAccountItem[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return items.filter((account) => {
    const matchesSearch =
      normalizedQuery.length === 0 ||
      account.displayName.toLowerCase().includes(normalizedQuery);

    let matchesStatus = true;
    if (statusFilter === 'active') {
      matchesStatus = account.status === 'active';
    } else if (statusFilter === 'expired') {
      matchesStatus = account.status === 'expired';
    } else if (statusFilter === 'expiring_soon') {
      if (account.status === 'expired' || !account.tokenExpiresAt) {
        matchesStatus = false;
      } else {
        const days = Math.ceil(
          (new Date(account.tokenExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        matchesStatus = days > 0 && days <= 7;
      }
    }

    return matchesSearch && matchesStatus;
  });
}

/**
 * Accounts tab subtitle derived from the single account-health model
 * (Spec 102: `getAccountHealth`). Never a blanket "All operational" —
 * the subtitle reflects the real per-account state.
 */
/**
 * Unfiltered accounts subtitle from full-set health counts (the
 * paginated API's `healthCounts`), without needing the full account
 * list in memory. This is the single copy source; see
 * computeAccountsSubtitle below, which derives the same counts from
 * an array and delegates here.
 */
export function computeAccountsSubtitleFromCounts(
  totalCount: number,
  healthCounts: { connected: number; expired: number; error: number }
): string {
  if (totalCount === 0) {
    return 'Connect your first Facebook account to manage pages and publish reels.';
  }
  const parts: string[] = [`${healthCounts.connected} connected`];
  if (healthCounts.expired > 0) {
    parts.push(
      `${healthCounts.expired} ${
        healthCounts.expired === 1 ? 'session expired' : 'sessions expired'
      }`
    );
  }
  if (healthCounts.error > 0) {
    parts.push(
      `${healthCounts.error} ${
        healthCounts.error === 1 ? 'connection error' : 'connection errors'
      }`
    );
  }
  return parts.join(' · ');
}

export function computeAccountsSubtitle(
  accounts: FacebookAccountItem[],
  filteredCount: number,
  isFiltered: boolean
): string {
  const totalCount = accounts.length;
  if (totalCount === 0) {
    return 'Connect your first Facebook account to manage pages and publish reels.';
  }
  if (isFiltered) {
    return `Showing ${filteredCount} of ${totalCount} ${
      totalCount === 1 ? 'account' : 'accounts'
    }`;
  }
  const healthCounts: Record<AccountHealth, number> = {
    connected: 0,
    expired: 0,
    error: 0,
  };
  for (const account of accounts) {
    healthCounts[getAccountHealth(account)] += 1;
  }
  return computeAccountsSubtitleFromCounts(totalCount, healthCounts);
}

/**
 * Connect is gated only when the Facebook App ID and Secret are known to be
 * missing — not while the check is running, and not when the check failed
 * (the retry banner covers that case instead).
 */
export function isConnectGatedByMissingCredentials(status: {
  isLoading: boolean;
  isConfigured: boolean;
  error: string | null;
}): boolean {
  return !status.isLoading && !status.isConfigured && !status.error;
}

export function resolveOAuthRedirectNotice(searchParams: {
  get: (key: string) => string | null;
}): {
  notice: { type: 'success' | 'error'; message: string };
  /** Account name carried by the redirect, when present — used to highlight its card. */
  accountName?: string | undefined;
  keysToRemove: string[];
} | null {
  const reconnectedMismatch = searchParams.get('reconnected_mismatch');
  if (reconnectedMismatch === '1') {
    const newAccountName = searchParams.get('newAccountName') || 'another account';
    const expectedAccountName = searchParams.get('expectedAccountName') || 'the expired account';
    return {
      notice: {
        type: 'error',
        message: `You signed into ${newAccountName} instead of ${expectedAccountName}. ${expectedAccountName} still needs to be reconnected.`,
      },
      keysToRemove: ['reconnected_mismatch', 'newAccountName', 'expectedAccountName'],
    };
  }

  const connected = searchParams.get('connected');
  if (connected === 'already') {
    const accountName = searchParams.get('accountName') || 'Account';
    return {
      notice: {
        type: 'success',
        message: `${accountName} already connected — session refreshed`,
      },
      accountName,
      keysToRemove: ['connected', 'accountName'],
    };
  }

  if (connected === '1') {
    // Option B dialogue: name + connected only, never pages, never the
    // old "successfully" banner wording. The callback sets accountName
    // on fresh directs; the fallback covers only legacy URLs without it.
    const accountName = searchParams.get('accountName') || undefined;
    return {
      notice: {
        type: 'success',
        message: accountName ? `${accountName} connected` : 'Facebook account connected',
      },
      accountName,
      keysToRemove: ['connected', 'accountName'],
    };
  }

  const error = searchParams.get('error');
  if (error) {
    if (error === 'credentials_required') {
      return {
        notice: {
          type: 'error',
          message:
            'Facebook App credentials are required before connecting accounts. Please configure your App ID and Secret in Workspace Settings.',
        },
        keysToRemove: ['error', 'tab'],
      };
    }
    const isCancelled = error === 'access_denied' || error === 'user_cancelled';
    const message = isCancelled
      ? 'Connection canceled. No changes were made.'
      : "Couldn't connect to Facebook. Check your permissions and try again.";
    return {
      notice: {
        type: 'error',
        message,
      },
      keysToRemove: ['error'],
    };
  }

  return null;
}
