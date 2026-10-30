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
  next_allowed_publish_at: null,
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
