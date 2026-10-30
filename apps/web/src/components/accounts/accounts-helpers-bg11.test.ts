/**
 * Audit BG11 — the shared list-expired predicate.
 *
 * Expired means an expired wire status OR a past token,
 * regardless of the other field — mirroring the shell's
 * getAccountHealth. In particular a disconnected account with
 * a past token is expired (the old SQL filter missed it while
 * the counts still called it expired).
 */
import { describe, expect, it } from 'vitest';
import { isAccountExpiredForList } from '@/components/accounts/accounts-helpers';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';

describe('isAccountExpiredForList (BG11)', () => {
  it('treats an expired wire status as expired even with a live token', () => {
    expect(isAccountExpiredForList('expired', FUTURE, NOW)).toBe(true);
  });

  it('treats a past token as expired for active and disconnected rows alike', () => {
    expect(isAccountExpiredForList('active', PAST, NOW)).toBe(true);
    expect(isAccountExpiredForList('disconnected', PAST, NOW)).toBe(true);
  });

  it('treats a live or absent token on an active row as not expired', () => {
    expect(isAccountExpiredForList('active', FUTURE, NOW)).toBe(false);
    expect(isAccountExpiredForList('active', null, NOW)).toBe(false);
    expect(isAccountExpiredForList('active', undefined, NOW)).toBe(false);
  });

  it('treats a disconnected row with a live token as not expired', () => {
    expect(isAccountExpiredForList('disconnected', FUTURE, NOW)).toBe(false);
  });

  it('treats an unparseable token as not expired rather than throwing', () => {
    expect(isAccountExpiredForList('active', 'not-a-date', NOW)).toBe(false);
  });
});
