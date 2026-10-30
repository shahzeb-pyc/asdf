/**
 * Instagram connect modal polling — behavioural tests for
 * `evaluateInstagramConnectionPoll`, mirroring Facebook's poll
 * outcomes: a brand-new account is `connected`, a refreshed
 * already-connected account is `already_connected`, a reconnected
 * target is `connected`, and a different updated account during a
 * reconnect is `reconnected_mismatch`.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateInstagramConnectionPoll,
  type InstagramAccountSnapshot,
} from '@/components/accounts/instagram-connect-account-modal';

const base = (overrides: Partial<InstagramAccountSnapshot> = {}): InstagramAccountSnapshot => ({
  id: '11111111-1111-4111-a111-111111111111',
  displayName: 'Sunset Bakery',
  status: 'active',
  updatedAt: '2026-10-12T00:00:00Z',
  ...overrides,
});

describe('evaluateInstagramConnectionPoll', () => {
  it('matches a brand-new account as connected', () => {
    const outcome = evaluateInstagramConnectionPoll(
      [base()],
      new Set(),
      new Map()
    );
    expect(outcome).toEqual({
      matched: true,
      kind: 'connected',
      accountId: base().id,
      accountName: 'Sunset Bakery',
    });
  });

  it('matches a refreshed existing account as already_connected', () => {
    const prev = base();
    const refreshed = base({ updatedAt: '2026-10-13T00:00:00Z' });
    const outcome = evaluateInstagramConnectionPoll(
      [refreshed],
      new Set([prev.id]),
      new Map([[prev.id, { status: 'active', updatedAt: prev.updatedAt }]])
    );
    expect(outcome.matched).toBe(true);
    if (outcome.matched) {
      expect(outcome.kind).toBe('already_connected');
      if (outcome.kind === 'already_connected') {
        expect(outcome.accountName).toBe('Sunset Bakery');
      }
    }
  });

  it('matches nothing when nothing changed', () => {
    const prev = base();
    const outcome = evaluateInstagramConnectionPoll(
      [prev],
      new Set([prev.id]),
      new Map([[prev.id, { status: 'active', updatedAt: prev.updatedAt }]])
    );
    expect(outcome).toEqual({ matched: false });
  });

  it('matches a reconnected target, and a different updated account as a mismatch', () => {
    const target = base({ status: 'expired', updatedAt: '2026-10-01T00:00:00Z' });
    const reconnected = base({ status: 'active', updatedAt: '2026-10-12T00:00:00Z' });
    const matched = evaluateInstagramConnectionPoll(
      [reconnected],
      new Set([target.id]),
      new Map([[target.id, { status: 'expired', updatedAt: target.updatedAt }]]),
      { id: target.id, displayName: 'Sunset Bakery', status: 'expired', updatedAt: target.updatedAt }
    );
    expect(matched.matched).toBe(true);
    if (matched.matched) expect(matched.kind).toBe('connected');

    const other = base({
      id: '22222222-2222-4222-a222-222222222222',
      displayName: 'River Yoga',
      updatedAt: '2026-10-13T00:00:00Z',
    });
    const mismatch = evaluateInstagramConnectionPoll(
      [target, other],
      new Set([target.id, other.id]),
      new Map([
        [target.id, { status: 'expired', updatedAt: target.updatedAt }],
        [other.id, { status: 'active', updatedAt: '2026-10-01T00:00:00Z' }],
      ]),
      { id: target.id, displayName: 'Sunset Bakery', status: 'expired', updatedAt: target.updatedAt }
    );
    expect(mismatch.matched).toBe(true);
    if (mismatch.matched) {
      expect(mismatch.kind).toBe('reconnected_mismatch');
      if (mismatch.kind === 'reconnected_mismatch') {
        expect(mismatch.newAccountName).toBe('River Yoga');
        expect(mismatch.expectedAccountName).toBe('Sunset Bakery');
      }
    }
  });
});
