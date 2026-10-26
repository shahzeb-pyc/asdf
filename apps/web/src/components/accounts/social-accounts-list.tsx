/**
 * Social accounts helpers (formerly the unified Accounts list, Spec 123).
 *
 * The list UI itself was removed with the Destinations pages: its only
 * production consumer was the deleted destination frame, and the Facebook
 * Accounts page had already stopped rendering it. What remains here are
 * the genuinely shared pieces — the account/destination types, the status
 * helpers consumed by the X composer, and `loadSocialAccounts` — kept
 * under their existing names and behaviour so no consumer changes.
 */

import type { Platform } from '@/lib/connect/registry';

export interface SocialDestinationItem {
  id: string;
  externalDestinationId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  timezone: string;
  status: string;
}

export interface SocialAccountItem {
  id: string;
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  tokenExpiresAt: string | null;
  destinations: SocialDestinationItem[];
}

type StatusSignalType = 'operational' | 'queued' | 'critical' | 'idle';

export function socialStatusSignal(status: string): StatusSignalType {
  if (status === 'active') return 'operational';
  if (status === 'expired') return 'queued';
  if (status === 'revoked' || status === 'error') return 'critical';
  return 'idle';
}

export function socialStatusLabel(status: string): string {
  if (status === 'active') return 'Connected';
  if (status === 'expired') return 'Session expired — reconnect to keep posting';
  if (status === 'revoked') return 'Disconnected on the platform — reconnect to use it again';
  if (status === 'error') return 'Connection problem — reconnect to fix it';
  if (status === 'disconnected') return 'Disconnected';
  return status;
}

/** Loads the unified accounts list; returns null when the load fails. */
export async function loadSocialAccounts(
  subdomain: string,
  fetcher: typeof fetch = fetch
): Promise<SocialAccountItem[] | null> {
  try {
    const res = await fetcher(`/api/tenant/${subdomain}/accounts/social`);
    if (!res.ok) {
      console.warn(
        '[social-accounts-list] Failed to load connected accounts:',
        res.status
      );
      return null;
    }
    const data = (await res.json()) as { accounts?: SocialAccountItem[] };
    return Array.isArray(data.accounts) ? data.accounts : [];
  } catch (err) {
    console.warn(
      '[social-accounts-list] Failed to load connected accounts:',
      err
    );
    return null;
  }
}
