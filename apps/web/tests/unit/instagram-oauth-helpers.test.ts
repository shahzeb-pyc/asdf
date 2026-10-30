/**
 * Instagram OAuth-return notice resolver — behavioural tests mirroring
 * Facebook's `resolveOAuthRedirectNotice` cases with Instagram copy:
 * fresh connect, already-connected refresh, reconnect mismatch, and
 * the credentials-required and generic error cases.
 */
import { describe, expect, it } from 'vitest';
import { resolveInstagramOAuthRedirectNotice } from '@/components/accounts/instagram-oauth-helpers';

function params(entries: Record<string, string>) {
  return { get: (key: string) => entries[key] ?? null };
}

describe('resolveInstagramOAuthRedirectNotice', () => {
  it('resolves a fresh connect with the account name', () => {
    const resolved = resolveInstagramOAuthRedirectNotice(
      params({ connected: '1', accountName: 'Sunset Bakery' })
    );
    expect(resolved?.notice).toEqual({ type: 'success', message: 'Sunset Bakery connected' });
    expect(resolved?.accountName).toBe('Sunset Bakery');
    expect(resolved?.keysToRemove).toEqual(['connected', 'accountName']);
  });

  it('resolves an already-connected refresh', () => {
    const resolved = resolveInstagramOAuthRedirectNotice(
      params({ connected: 'already', accountName: 'Sunset Bakery' })
    );
    expect(resolved?.notice.message).toBe('Sunset Bakery already connected — session refreshed');
  });

  it('resolves a reconnect mismatch as an error naming both accounts', () => {
    const resolved = resolveInstagramOAuthRedirectNotice(
      params({
        reconnected_mismatch: '1',
        newAccountName: 'River Yoga',
        expectedAccountName: 'Sunset Bakery',
      })
    );
    expect(resolved?.notice.type).toBe('error');
    expect(resolved?.notice.message).toContain('River Yoga');
    expect(resolved?.notice.message).toContain('Sunset Bakery');
  });

  it('resolves credentials_required with the Instagram App wording', () => {
    const resolved = resolveInstagramOAuthRedirectNotice(
      params({ error: 'credentials_required', tab: 'instagram' })
    );
    expect(resolved?.notice.type).toBe('error');
    expect(resolved?.notice.message).toContain('Instagram App credentials are required');
    expect(resolved?.keysToRemove).toEqual(['error', 'tab']);
  });

  it('returns null when there is no notice to handle', () => {
    expect(resolveInstagramOAuthRedirectNotice(params({ page: '2' }))).toBeNull();
  });
});
