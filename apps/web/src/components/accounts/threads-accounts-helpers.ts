/**
 * Threads accounts helpers — the Threads-specific copy of the
 * Facebook accounts health model, kept separate on purpose: the
 * Facebook helpers file must not be edited to fit Threads, and the
 * Threads surface must not depend on Facebook copy (pages, reels)
 * leaking in through a shared helper.
 *
 * Health model (same as Facebook's UI model):
 * - 'expired' — stored status is expired, or the token has passed.
 * - 'error' — stored status is disconnected with a live-or-absent token.
 * - 'connected' — everything else.
 */

export type ThreadsAccountHealth = 'connected' | 'expired' | 'error';

export type ThreadsAccountStatusFilter = 'all' | 'active' | 'expired';

export interface ThreadsAccountHealthInput {
  status?: string | null | undefined;
  tokenExpiresAt?: string | Date | null | undefined;
}

export function getThreadsAccountHealth(
  account: ThreadsAccountHealthInput,
  now: Date = new Date()
): ThreadsAccountHealth {
  if (account.status === 'expired') {
    return 'expired';
  }
  if (account.tokenExpiresAt) {
    const expiresAt = new Date(account.tokenExpiresAt).getTime();
    if (!Number.isNaN(expiresAt) && expiresAt <= now.getTime()) {
      return 'expired';
    }
  }
  if (account.status === 'disconnected') {
    return 'error';
  }
  return 'connected';
}

/** True when connected and the token expires within `withinDays` days. */
export function isThreadsTokenExpiringSoon(
  account: ThreadsAccountHealthInput,
  now: Date = new Date(),
  withinDays = 7
): boolean {
  if (getThreadsAccountHealth(account, now) !== 'connected') {
    return false;
  }
  if (!account.tokenExpiresAt) {
    return false;
  }
  const expiresAt = new Date(account.tokenExpiresAt).getTime();
  if (Number.isNaN(expiresAt)) {
    return false;
  }
  const daysRemaining = Math.ceil(
    (expiresAt - now.getTime()) / (1000 * 60 * 60 * 24)
  );
  return daysRemaining > 0 && daysRemaining <= withinDays;
}

export function getThreadsAccountHealthLabel(
  health: ThreadsAccountHealth
): string {
  switch (health) {
    case 'expired':
      return 'Session expired';
    case 'error':
      return 'Connection error';
    case 'connected':
    default:
      return 'Connected';
  }
}

export interface ThreadsHealthCounts {
  connected: number;
  expired: number;
  error: number;
}

/** Subtitle from full-set health counts (Facebook's count form). */
export function computeThreadsSubtitleFromCounts(
  totalCount: number,
  healthCounts: ThreadsHealthCounts
): string {
  if (totalCount === 0) {
    return 'Connect your first Threads account to schedule and publish posts.';
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

export interface ThreadsAccountSortInput {
  status: string;
  tokenExpiresAt?: string | Date | null | undefined;
  createdAt: string | Date;
}

/**
 * Stable expired-first sort of a page slice (the server already orders
 * expired-first; this only guards against a source that ignores it).
 * Expiring-soon is NOT sorted first — only expired is.
 */
export function sortThreadsAccountsExpiredFirst<T extends ThreadsAccountSortInput>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => {
    const aExpired = getThreadsAccountHealth(a) === 'expired' ? 1 : 0;
    const bExpired = getThreadsAccountHealth(b) === 'expired' ? 1 : 0;
    if (aExpired !== bExpired) return bExpired - aExpired;
    return (
      Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt))
    );
  });
}
