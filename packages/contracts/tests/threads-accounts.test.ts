import { describe, expect, it } from 'vitest';
import {
  DisconnectThreadsAccountResponseSchema,
  ListThreadsAccountsResponseSchema,
  ThreadsAccountViewSchema,
} from '../../src/index.js';

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
});
