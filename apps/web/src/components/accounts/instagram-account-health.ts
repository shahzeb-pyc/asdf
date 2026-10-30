/**
 * Instagram account health — the single model for the Instagram Accounts
 * surface. It mirrors `account-health.ts` (Facebook) but speaks the
 * UNIFIED stored vocabulary, not Facebook's wire vocabulary: the
 * Instagram list route already folds stored `revoked`/`error` into the
 * wire `disconnected`, but this helper also accepts the raw unified
 * values directly, so a caller holding a social-accounts row is never
 * misread (in the Facebook helper, `revoked`/`error` would fall through
 * to `connected` — wrong for Instagram).
 *
 * The three states:
 * - 'connected' — the session is usable for publishing.
 * - 'expired' — the token/session expired; the user must reconnect.
 * - 'error' — the account is in a broken state that reconnecting may fix.
 */

export type InstagramAccountHealth = 'connected' | 'expired' | 'error';

export interface InstagramAccountHealthInput {
  status?: string | null | undefined;
  tokenExpiresAt?: string | Date | null | undefined;
}

export function getInstagramAccountHealth(
  account: InstagramAccountHealthInput,
  now: Date = new Date()
): InstagramAccountHealth {
  if (account.status === 'expired') {
    return 'expired';
  }
  if (account.tokenExpiresAt) {
    const expiresAt = new Date(account.tokenExpiresAt).getTime();
    if (!Number.isNaN(expiresAt) && expiresAt <= now.getTime()) {
      return 'expired';
    }
  }
  if (
    account.status === 'disconnected' ||
    account.status === 'revoked' ||
    account.status === 'error'
  ) {
    return 'error';
  }
  return 'connected';
}

/**
 * True when the account is connected and its token expires within
 * `withinDays` days. Not a health state — only the "renew soon"
 * warning affordance (queued ring + Refresh action), as on Facebook.
 */
export function isInstagramTokenExpiringSoon(
  account: InstagramAccountHealthInput,
  now: Date = new Date(),
  withinDays = 7
): boolean {
  if (getInstagramAccountHealth(account, now) !== 'connected') {
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

export function getInstagramAccountHealthLabel(
  health: InstagramAccountHealth
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

/** Subtitle from full-set health counts — same shape as Facebook's, Instagram copy. */
export function computeInstagramSubtitleFromCounts(
  totalCount: number,
  healthCounts: { connected: number; expired: number; error: number }
): string {
  if (totalCount === 0) {
    return 'Connect your first Instagram account.';
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

export type InstagramAccountStatusFilter = 'all' | 'active' | 'expired';

/** Expired-first, then newest — the Facebook list order. */
export function sortInstagramAccountsExpiredFirst<T extends InstagramAccountHealthInput & { createdAt: string | Date }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => {
    const aExpired = getInstagramAccountHealth(a) === 'expired' ? 1 : 0;
    const bExpired = getInstagramAccountHealth(b) === 'expired' ? 1 : 0;
    if (aExpired !== bExpired) return bExpired - aExpired;
    const aTime = Date.parse(String(a.createdAt)) || 0;
    const bTime = Date.parse(String(b.createdAt)) || 0;
    return bTime - aTime;
  });
}
