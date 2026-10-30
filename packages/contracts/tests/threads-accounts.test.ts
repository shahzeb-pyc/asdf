import { describe, expect, it } from 'vitest';
import {
  DisconnectThreadsAccountResponseSchema,
  ListThreadsAccountsResponseSchema,
  signMagicLinkToken,
  ThreadsAccountViewSchema,
  verifyMagicLinkToken,
} from '../src/index.js';

const account = {
  id: '11111111-1111-4111-a111-111111111111',
  threadsAccountId: 'threads-123',
  displayName: 'Cedar Studio',
  profilePictureUrl: null,
  status: 'active',
  tokenExpiresAt: new Date('2026-12-01T00:00:00Z'),
  createdAt: new Date('2026-10-12T00:00:00Z'),
  updatedAt: new Date('2026-10-12T00:00:00Z'),
};

describe('Threads accounts contracts', () => {
  it('accepts a valid Threads account view with no pages or counts', () => {
    const parsed = ThreadsAccountViewSchema.safeParse(account);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('connectedPagesCount');
      expect(parsed.data).not.toHaveProperty('connectedPages');
    }
  });

  it('rejects an account with an unknown status', () => {
    expect(
      ThreadsAccountViewSchema.safeParse({ ...account, status: 'paused' })
        .success
    ).toBe(false);
  });

  it('accepts a paginated list response with health counts', () => {
    const parsed = ListThreadsAccountsResponseSchema.safeParse({
      accounts: [account],
      total: 2,
      page: 1,
      limit: 30,
      totalPages: 1,
      healthCounts: { connected: 1, expired: 1, error: 0 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a disconnect response with a negative destination count', () => {
    expect(
      DisconnectThreadsAccountResponseSchema.safeParse({
        success: true,
        accountId: '11111111-1111-4111-a111-111111111111',
        disconnectedDestinationsCount: -1,
      }).success
    ).toBe(false);
  });

  it('accepts handle, profile link, and destination count (disconnect dialog + card)', () => {
    const parsed = ThreadsAccountViewSchema.safeParse({
      ...account,
      handle: 'cedar',
      accountLink: 'https://threads.com/@cedar',
      connectedDestinationsCount: 2,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.handle).toBe('cedar');
      expect(parsed.data.accountLink).toBe('https://threads.com/@cedar');
      expect(parsed.data.connectedDestinationsCount).toBe(2);
    }
  });

  it('defaults the destination count to 0 and accepts a bad picture URL (initials fallback, never a 500)', () => {
    const parsed = ThreadsAccountViewSchema.safeParse({
      ...account,
      profilePictureUrl: 'not-a-url',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.connectedDestinationsCount).toBe(0);
      expect(parsed.data.profilePictureUrl).toBe('not-a-url');
    }
  });

  it('round-trips the platform-agnostic expected account id in a magic-link token', async () => {
    const secret = 'test-magic-link-secret';
    const now = Math.floor(Date.now() / 1000);
    const token = await signMagicLinkToken(
      {
        tenantSubdomain: 'acme',
        userId: '11111111-1111-4111-a111-111111111111',
        nonce: 'nonce-threads-roundtrip',
        iat: now,
        exp: now + 900,
        expectedExternalAccountId: 'th-exp',
        expectedDisplayName: 'Expired Willow',
      },
      secret
    );
    const payload = await verifyMagicLinkToken(token, secret);
    expect(payload.expectedExternalAccountId).toBe('th-exp');
    expect(payload.expectedDisplayName).toBe('Expired Willow');
  });
});
