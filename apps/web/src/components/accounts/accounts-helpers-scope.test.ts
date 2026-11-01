/**
 * Hard scope rejection — the Accounts banner for a declined permission.
 *
 * The callback saves nothing and redirects with `error=scope_rejected`
 * plus the missing scopes; the banner must name the actually missing
 * scope in plain language and offer a fresh connect.
 */
import { describe, expect, it } from 'vitest';
import { resolveOAuthRedirectNotice } from '@/components/accounts/accounts-helpers';

function params(entries: Record<string, string>) {
  return { get: (key: string) => entries[key] ?? null };
}

describe('resolveOAuthRedirectNotice (scope_rejected)', () => {
  it('names the missing scope in plain language and offers a reconnect', () => {
    const resolved = resolveOAuthRedirectNotice(
      params({ error: 'scope_rejected', missing: 'pages_manage_posts' })
    );
    expect(resolved?.notice).toEqual({
      type: 'error',
      message:
        'This Facebook account was not connected. A required permission — posting to Pages — was declined. Please reconnect and allow all requested permissions to continue.',
      connectAgain: true,
    });
    expect(resolved?.keysToRemove).toEqual(['error', 'missing']);
  });

  it('names every missing scope when several were declined', () => {
    const resolved = resolveOAuthRedirectNotice(
      params({
        error: 'scope_rejected',
        missing: 'pages_show_list,business_management',
      })
    );
    expect(resolved?.notice.message).toContain('viewing your Pages');
    expect(resolved?.notice.message).toContain('managing your business');
  });

  it('falls back to generic copy when no recognised scope is carried', () => {
    const resolved = resolveOAuthRedirectNotice(
      params({ error: 'scope_rejected' })
    );
    expect(resolved?.notice.message).toBe(
      'This Facebook account was not connected. A required permission was declined. Please reconnect and allow all requested permissions to continue.'
    );
  });
});
