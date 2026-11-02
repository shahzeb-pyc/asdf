/**
 * Audit BG4 remainder: evaluatePublishReadiness must defer a Facebook
 * account whose token_expires_at has passed even when its status is
 * still 'active' (refresh job missed a cycle) — never let it be
 * claimed and then fail terminally on a Graph 190.
 */
import { describe, expect, it } from 'vitest';
import { evaluatePublishReadiness } from './consumers.js';

const DEST = {
  id: '22222222-2222-4222-a222-222222222222',
  status: 'active',
  metadata: {},
  updated_at: '2026-10-30T00:00:00.000Z',
};

const BASE_ACCOUNT = {
  id: '11111111-1111-4111-a111-111111111111',
  platform: 'facebook',
  status: 'active',
  token_expires_at: null,
};

describe('evaluatePublishReadiness (BG4)', () => {
  it('defers a facebook account with a past token_expires_at despite status active', () => {
    const account = { ...BASE_ACCOUNT, token_expires_at: '2026-01-01T00:00:00.000Z' } as never;
    const result = evaluatePublishReadiness(DEST as never, account, new Date('2026-10-30T00:00:00.000Z'));
    expect(result).not.toBeNull();
    expect(result?.code).toBe('account_not_active');
  });

  it('does not defer a facebook account with a future token_expires_at', () => {
    const account = { ...BASE_ACCOUNT, token_expires_at: '2027-01-01T00:00:00.000Z' } as never;
    expect(evaluatePublishReadiness(DEST as never, account, new Date('2026-10-30T00:00:00.000Z'))).toBeNull();
  });

  it('does not apply the date rule to non-facebook platforms', () => {
    const account = {
      ...BASE_ACCOUNT,
      platform: 'instagram',
      token_expires_at: '2026-01-01T00:00:00.000Z',
    } as never;
    expect(evaluatePublishReadiness(DEST as never, account, new Date('2026-10-30T00:00:00.000Z'))).toBeNull();
  });
});

describe('evaluatePublishReadiness (3-day rate_limited anchor, 20261102160000)', () => {
  const NOW = new Date('2026-10-30T00:00:00.000Z');
  const account = { ...BASE_ACCOUNT } as never;

  it('defers a rate_limited destination whose anchor is fresh', () => {
    const dest = {
      ...DEST,
      status: 'rate_limited',
      metadata: { rate_limited_at: '2026-10-29T00:00:00.000Z' },
    } as never;
    const result = evaluatePublishReadiness(dest, account, NOW);
    expect(result).not.toBeNull();
    expect(result?.code).toBe('destination_not_active');
  });

  it('proceeds for a rate_limited destination whose anchor is 3+ days old', () => {
    const dest = {
      ...DEST,
      status: 'rate_limited',
      metadata: { rate_limited_at: '2026-10-26T00:00:00.000Z' },
    } as never;
    expect(evaluatePublishReadiness(dest, account, NOW)).toBeNull();
  });

  it('falls back to updated_at for a rate_limited destination with no anchor', () => {
    const fresh = {
      ...DEST,
      status: 'rate_limited',
      metadata: {},
      updated_at: '2026-10-29T00:00:00.000Z',
    } as never;
    expect(evaluatePublishReadiness(fresh, account, NOW)).not.toBeNull();
    const stale = {
      ...DEST,
      status: 'rate_limited',
      metadata: {},
      updated_at: '2026-10-26T00:00:00.000Z',
    } as never;
    expect(evaluatePublishReadiness(stale, account, NOW)).toBeNull();
  });

  it('fails closed on a present-but-unparseable anchor', () => {
    const dest = {
      ...DEST,
      status: 'rate_limited',
      metadata: { rate_limited_at: 'not-a-date' },
      updated_at: '2026-10-26T00:00:00.000Z',
    } as never;
    expect(evaluatePublishReadiness(dest, account, NOW)).not.toBeNull();
  });
});
