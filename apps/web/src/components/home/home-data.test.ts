import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entitlement } from '@/lib/billing/entitlement';
import { loadHomeData } from './home-data';

/**
 * Plan-check R1: Home shares the layout's entitlement read.
 *
 * The loader reads the request-scoped cached answer
 * (`getCachedEntitlement`) instead of calling `getEntitlement`
 * again, and falls back to a fresh read when the cached read fails
 * (seed failed, or the seed never ran for this request). These
 * tests pin that contract at the loader's module boundary: the
 * cached read is used first, the raw read runs only as the
 * fallback, and a failure of both reads renders the error card —
 * never invented numbers, never a wrong Free.
 *
 * What is NOT tested here, deliberately: that two calls to the real
 * `getCachedEntitlement` issue one database read. React `cache()`
 * only dedupes inside a request store, and there is no request
 * store under Vitest — verified empirically, a cached function
 * re-executes on every call outside a render/request scope. In
 * production the layout and the loader render in the same document
 * request and share one per-request store, the same mechanism the
 * workspace lookup already relies on
 * (`workspace-display-name.ts`). The sharing itself is therefore
 * covered by the boundary contract below (the loader never calls
 * the raw read when the seed is present) plus the production
 * mechanism, not by a unit test that cannot observe it.
 */

const { session, adminClient, cachedFn, rawFn, quotaFn, identityFn } =
  vi.hoisted(() => {
    const session: {
      userId: string;
      email: string;
      role: string;
      subdomain: string;
    } = { userId: 'user-1', email: 'user@example.com', role: 'user', subdomain: 'ws-1' };
    const adminClient = { __fakeAdminClient: true };
    return {
      session,
      adminClient,
      cachedFn: vi.fn(),
      rawFn: vi.fn(),
      quotaFn: vi.fn(),
      identityFn: vi.fn(),
    };
  });

vi.mock('@/lib/auth', () => ({
  getServerSessionContext: () => session,
}));

vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => adminClient,
}));

vi.mock('@/lib/billing/entitlement', () => ({
  getCachedEntitlement: cachedFn,
  getEntitlement: rawFn,
}));

vi.mock('@/lib/billing/storage-quota', () => ({
  getStorageQuotaState: quotaFn,
}));

vi.mock('../../app/tenant/[subdomain]/workspace-display-name', () => ({
  getWorkspaceIdentity: identityFn,
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: () => {},
}));

const COUNTS = {
  facebook: 10,
  instagram: 2,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
} as const;

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
} as const;

function paidEntitlement(): Entitlement {
  return {
    plan: 'paid',
    active: true,
    counts: { ...COUNTS },
    usage: { ...ZERO_COUNTS },
    period: {
      id: 'period-1',
      userId: 'user-1',
      counts: { ...COUNTS },
      startsAt: new Date('2026-11-01T00:00:00.000Z'),
      endsAt: new Date('2026-12-01T00:00:00.000Z'),
      supersededAt: null,
    },
    canPost: true,
    readOnly: false,
    reason: null,
    hasPriorPeriod: true,
  };
}

function freeEntitlement(): Entitlement {
  return {
    plan: 'free',
    active: false,
    counts: { ...ZERO_COUNTS },
    usage: { ...ZERO_COUNTS },
    period: null,
    canPost: false,
    readOnly: true,
    reason: 'Your plan is Free, which covers the Prompt Library only.',
    hasPriorPeriod: false,
  };
}

function expiredEntitlement(): Entitlement {
  return {
    plan: 'expired',
    active: false,
    counts: { ...ZERO_COUNTS },
    usage: { ...ZERO_COUNTS },
    period: null,
    canPost: false,
    readOnly: true,
    reason: 'Posting is paused. Your paid period has ended.',
    hasPriorPeriod: true,
  };
}

describe('loadHomeData (plan-check R1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.userId = 'user-1';
    session.email = 'user@example.com';
    session.role = 'user';
    session.subdomain = 'ws-1';
    identityFn.mockResolvedValue({ id: 'ws-1', name: 'Workspace' });
    quotaFn.mockResolvedValue({ usedBytes: 1234, quotaBytes: 12 * 5368709120 });
  });

  it('seed present: paid Home renders the same card from the cached read, raw read never runs', async () => {
    const paid = paidEntitlement();
    cachedFn.mockResolvedValue(paid);

    const data = await loadHomeData('ws-1');

    expect(cachedFn).toHaveBeenCalledTimes(1);
    expect(cachedFn).toHaveBeenCalledWith(adminClient, 'user-1');
    expect(rawFn).not.toHaveBeenCalled();
    expect(data).toEqual({
      kind: 'paid',
      periodStartsAt: new Date('2026-11-01T00:00:00.000Z'),
      periodEndsAt: new Date('2026-12-01T00:00:00.000Z'),
      units: 12,
      platformCounts: { ...COUNTS },
      storageUsedBytes: 1234,
      storageQuotaBytes: 12 * 5368709120,
    });
  });

  it('seed failed: falls back to a fresh read and renders the same paid card', async () => {
    const paid = paidEntitlement();
    cachedFn.mockRejectedValue(new Error('seed read failed'));
    rawFn.mockResolvedValue(paid);

    const data = await loadHomeData('ws-1');

    expect(cachedFn).toHaveBeenCalledTimes(1);
    expect(rawFn).toHaveBeenCalledTimes(1);
    expect(rawFn).toHaveBeenCalledWith(adminClient, 'user-1');
    expect(data).toEqual({
      kind: 'paid',
      periodStartsAt: new Date('2026-11-01T00:00:00.000Z'),
      periodEndsAt: new Date('2026-12-01T00:00:00.000Z'),
      units: 12,
      platformCounts: { ...COUNTS },
      storageUsedBytes: 1234,
      storageQuotaBytes: 12 * 5368709120,
    });
  });

  it('seed present: free renders the free card without touching the raw read or storage', async () => {
    cachedFn.mockResolvedValue(freeEntitlement());

    const data = await loadHomeData('ws-1');

    expect(data).toEqual({ kind: 'free' });
    expect(rawFn).not.toHaveBeenCalled();
    expect(quotaFn).not.toHaveBeenCalled();
  });

  it('seed present: expired renders the expired card without touching the raw read', async () => {
    cachedFn.mockResolvedValue(expiredEntitlement());

    const data = await loadHomeData('ws-1');

    expect(data).toEqual({ kind: 'expired' });
    expect(rawFn).not.toHaveBeenCalled();
  });

  it('seed failed then fallback paid: free/expired are never derived from the failure', async () => {
    cachedFn.mockRejectedValue(new Error('seed read failed'));
    rawFn.mockResolvedValue(expiredEntitlement());

    const data = await loadHomeData('ws-1');

    expect(rawFn).toHaveBeenCalledTimes(1);
    expect(data).toEqual({ kind: 'expired' });
  });

  it('both reads fail: error card, never invented numbers or a wrong Free', async () => {
    cachedFn.mockRejectedValue(new Error('seed read failed'));
    rawFn.mockRejectedValue(new Error('fallback read failed'));

    const data = await loadHomeData('ws-1');

    expect(data.kind).toBe('error');
    expect(data).not.toHaveProperty('units');
    expect(data).not.toHaveProperty('platformCounts');
    expect(data).not.toHaveProperty('periodStartsAt');
    expect(data).not.toHaveProperty('periodEndsAt');
    if (data.kind === 'error') {
      expect(data.message).toBeTruthy();
    }
  });

  it('paid entitlement without a period: error, never a paid card', async () => {
    const paid = paidEntitlement();
    paid.period = null;
    cachedFn.mockResolvedValue(paid);

    const data = await loadHomeData('ws-1');

    expect(data.kind).toBe('error');
    expect(data).not.toHaveProperty('units');
  });

  it('admin: admin card without any entitlement read', async () => {
    session.role = 'admin';

    const data = await loadHomeData('ws-1');

    expect(data).toEqual({ kind: 'admin' });
    expect(cachedFn).not.toHaveBeenCalled();
    expect(rawFn).not.toHaveBeenCalled();
  });
});
