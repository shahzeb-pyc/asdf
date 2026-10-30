/**
 * Audit BG15/BG19 — connect-modal polling.
 *
 * BG19: in the reconnect branch, only a genuine (re)connection
 * event on another account fires a mismatch — a new id, or an
 * expired→active flip. A bare updatedAt bump (background
 * refreshes do this too) must NOT fire a mismatch before the
 * target reconnects.
 *
 * BG15: the page fetcher walks every page of the list until
 * the reported last page, bounded so it cannot loop forever.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateAccountConnectionPoll,
  fetchAllAccountsForPoll,
  isAccountConnectionEvent,
  type AccountSnapshot,
  type AccountStateRecord,
} from '@/components/accounts/connect-poll';

const TARGET = {
  id: 'target-1',
  displayName: 'Target Page',
  status: 'expired',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function baseline(): {
  ids: Set<string>;
  states: Map<string, AccountStateRecord>;
} {
  return {
    ids: new Set(['target-1', 'other-1']),
    states: new Map<string, AccountStateRecord>([
      ['target-1', { status: 'expired', updatedAt: '2026-01-01T00:00:00.000Z' }],
      ['other-1', { status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' }],
    ]),
  };
}

function snap(overrides: Partial<AccountSnapshot> & { id: string }): AccountSnapshot {
  return { displayName: 'Account', status: 'active', ...overrides };
}

describe('isAccountConnectionEvent (BG19)', () => {
  it('is not an event for a bare updatedAt bump on an existing account', () => {
    const { ids, states } = baseline();
    expect(
      isAccountConnectionEvent(
        snap({ id: 'other-1', updatedAt: '2026-02-01T00:00:00.000Z' }),
        ids,
        states
      )
    ).toBe(false);
  });

  it('is an event for a brand-new id and for an expired→active flip', () => {
    const { ids, states } = baseline();
    expect(isAccountConnectionEvent(snap({ id: 'brand-new' }), ids, states)).toBe(true);
    const flippedStates = new Map(states);
    flippedStates.set('other-1', { status: 'expired', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(
      isAccountConnectionEvent(
        snap({ id: 'other-1', status: 'active', updatedAt: '2026-02-01T00:00:00.000Z' }),
        ids,
        flippedStates
      )
    ).toBe(true);
  });
});

describe('evaluateAccountConnectionPoll reconnect branch (BG19)', () => {
  it('keeps waiting when an unrelated account merely updates, even though the old code fired a mismatch', () => {
    const { ids, states } = baseline();
    const accounts = [
      snap({ id: 'target-1', status: 'expired', updatedAt: '2026-01-01T00:00:00.000Z' }),
      snap({ id: 'other-1', status: 'active', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(evaluateAccountConnectionPoll(accounts, ids, states, TARGET)).toEqual({
      matched: false,
    });
  });

  it('still fires a mismatch when a genuinely new account appears during reconnect', () => {
    const { ids, states } = baseline();
    const accounts = [
      snap({ id: 'target-1', status: 'expired', updatedAt: '2026-01-01T00:00:00.000Z' }),
      snap({ id: 'other-1', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' }),
      snap({ id: 'brand-new', displayName: 'Someone Else' }),
    ];
    const outcome = evaluateAccountConnectionPoll(accounts, ids, states, TARGET);
    expect(outcome).toMatchObject({ matched: true, kind: 'reconnected_mismatch' });
  });

  it('prefers the target reconnect over another account connecting in the same tick', () => {
    const { ids, states } = baseline();
    const accounts = [
      snap({ id: 'target-1', status: 'active', updatedAt: '2026-02-01T00:00:00.000Z' }),
      snap({ id: 'brand-new', displayName: 'Someone Else' }),
    ];
    const outcome = evaluateAccountConnectionPoll(accounts, ids, states, TARGET);
    expect(outcome).toMatchObject({
      matched: true,
      kind: 'connected',
      accountId: 'target-1',
    });
  });
});

describe('fetchAllAccountsForPoll (BG15)', () => {
  it('walks every reported page and stops at the last one', async () => {
    const fetchPage = vi.fn(async (page: number) => ({
      accounts: [snap({ id: `page-${page}-a` }), snap({ id: `page-${page}-b` })],
      totalPages: 3,
    }));
    const all = await fetchAllAccountsForPoll(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenCalledWith(1, 50);
    expect(fetchPage).toHaveBeenCalledWith(3, 50);
    expect(all.map((a) => a.id)).toEqual([
      'page-1-a',
      'page-1-b',
      'page-2-a',
      'page-2-b',
      'page-3-a',
      'page-3-b',
    ]);
  });

  it('stops early on an empty page instead of trusting meta blindly', async () => {
    const fetchPage = vi.fn(async (page: number) => ({
      accounts: page === 1 ? [snap({ id: 'only' })] : [],
      totalPages: 5,
    }));
    const all = await fetchAllAccountsForPoll(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(all.map((a) => a.id)).toEqual(['only']);
  });

  it('never fetches more than the page bound', async () => {
    const fetchPage = vi.fn(async () => ({
      accounts: [snap({ id: 'x' })],
      totalPages: 100,
    }));
    await fetchAllAccountsForPoll(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(20);
  });
});
