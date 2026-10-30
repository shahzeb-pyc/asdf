/**
 * Instagram account health — the unified-vocabulary model for the
 * Instagram Accounts surface. The critical case this suite pins: the
 * unified stored statuses `revoked` and `error` are ERROR, not
 * connected. The Facebook helper would fall through to connected for
 * those values, which is why Instagram has its own helper.
 */
import { describe, expect, it } from 'vitest';
import {
  computeInstagramSubtitleFromCounts,
  getInstagramAccountHealth,
  getInstagramAccountHealthLabel,
  isInstagramTokenExpiringSoon,
  sortInstagramAccountsExpiredFirst,
} from '@/components/accounts/instagram-account-health';

const NOW = new Date('2026-10-30T12:00:00Z');
const future = (days: number) =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
const past = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

describe('getInstagramAccountHealth', () => {
  it('returns connected for an active account with a future token expiry', () => {
    expect(
      getInstagramAccountHealth({ status: 'active', tokenExpiresAt: future(30) }, NOW)
    ).toBe('connected');
  });

  it('returns connected when no expiry is known', () => {
    expect(getInstagramAccountHealth({ status: 'active' }, NOW)).toBe('connected');
  });

  it('returns expired for explicit expired status even with a future expiry', () => {
    expect(
      getInstagramAccountHealth({ status: 'expired', tokenExpiresAt: future(30) }, NOW)
    ).toBe('expired');
  });

  it('returns expired when the token expiry is in the past', () => {
    expect(
      getInstagramAccountHealth({ status: 'active', tokenExpiresAt: past(1) }, NOW)
    ).toBe('expired');
  });

  it('returns error for revoked, error, and disconnected accounts', () => {
    expect(getInstagramAccountHealth({ status: 'revoked' }, NOW)).toBe('error');
    expect(getInstagramAccountHealth({ status: 'error' }, NOW)).toBe('error');
    expect(getInstagramAccountHealth({ status: 'disconnected' }, NOW)).toBe('error');
  });

  it('ignores malformed token expiry dates', () => {
    expect(
      getInstagramAccountHealth({ status: 'active', tokenExpiresAt: 'not-a-date' }, NOW)
    ).toBe('connected');
  });

  it('labels the three states exactly as the card renders them', () => {
    expect(getInstagramAccountHealthLabel('connected')).toBe('Connected');
    expect(getInstagramAccountHealthLabel('expired')).toBe('Session expired');
    expect(getInstagramAccountHealthLabel('error')).toBe('Connection error');
  });
});

describe('isInstagramTokenExpiringSoon', () => {
  it('is true within the 7-day window and false outside it', () => {
    expect(
      isInstagramTokenExpiringSoon({ status: 'active', tokenExpiresAt: future(3) }, NOW)
    ).toBe(true);
    expect(
      isInstagramTokenExpiringSoon({ status: 'active', tokenExpiresAt: future(30) }, NOW)
    ).toBe(false);
  });

  it('is false for expired and error accounts', () => {
    expect(
      isInstagramTokenExpiringSoon({ status: 'expired', tokenExpiresAt: future(3) }, NOW)
    ).toBe(false);
    expect(
      isInstagramTokenExpiringSoon({ status: 'revoked', tokenExpiresAt: future(3) }, NOW)
    ).toBe(false);
  });
});

describe('computeInstagramSubtitleFromCounts', () => {
  it('joins connected, expired, and error parts with the approved wording', () => {
    expect(
      computeInstagramSubtitleFromCounts(3, { connected: 1, expired: 1, error: 1 })
    ).toBe('1 connected · 1 session expired · 1 connection error');
    expect(
      computeInstagramSubtitleFromCounts(2, { connected: 2, expired: 0, error: 0 })
    ).toBe('2 connected');
  });
});

describe('sortInstagramAccountsExpiredFirst', () => {
  it('ranks expired before connected, then newest first', () => {
    const connected = {
      status: 'active',
      tokenExpiresAt: future(30),
      createdAt: '2026-10-29T00:00:00Z',
    };
    const expired = {
      status: 'expired',
      tokenExpiresAt: past(1),
      createdAt: '2026-10-01T00:00:00Z',
    };
    const sorted = sortInstagramAccountsExpiredFirst([connected, expired]);
    expect(sorted[0]).toBe(expired);
    expect(sorted[1]).toBe(connected);
  });
});
