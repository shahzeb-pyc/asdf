/**
 * Queue publish-now route (20261102140000).
 *
 * Publish-now must mark the row for the worker's immediate tick
 * (publish_now_requested_at) — not just re-time it — and must never
 * re-queue a row the worker already holds (publishing), which would
 * double-post. Both behaviors fail on the pre-fix route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  authenticateTenantRoute: vi.fn(),
  isLegacyClient: vi.fn(),
  resolveWorkspaceIdFromSession: vi.fn(),
  getBillingAdminClient: vi.fn(),
  assertPaidPlan: vi.fn(),
  refreshDestinationUnmatchedFlag: vi.fn(),
  unifiedDestinationStatusToWire: vi.fn(),
}));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: mocks.authenticateTenantRoute,
  getRouteSupabase: vi.fn(() => null),
  isLegacyClient: mocks.isLegacyClient,
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveWorkspaceIdFromSession: mocks.resolveWorkspaceIdFromSession,
}));
vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: mocks.getBillingAdminClient,
}));
vi.mock('@/lib/billing/entitlement', () => ({
  assertPaidPlan: mocks.assertPaidPlan,
  SubscriptionGateError: class SubscriptionGateError extends Error {},
}));
vi.mock('@/lib/server/unmatched-flag', () => ({
  refreshDestinationUnmatchedFlag: mocks.refreshDestinationUnmatchedFlag,
}));
vi.mock('@/lib/server/facebook-wire', () => ({
  unifiedDestinationStatusToWire: mocks.unifiedDestinationStatusToWire,
}));
vi.mock('@/lib/publishing/idempotency', () => ({
  lookupIdempotencyResult: vi.fn(),
  parseIdempotencyKeyHeader: vi.fn(() => ({ key: null, invalid: false })),
  storeIdempotencyResult: vi.fn(),
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

import { handlePublishNow } from './route';

const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface FakeQueryCall {
  sql: string;
  params: unknown[];
}

function fakeDb(existingStatus: string, destinationStatus: string) {
  const calls: FakeQueryCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT id, status, destination_id FROM queue_items')) {
      return [{ id: ITEM_ID, status: existingStatus, destination_id: 'dest-1' }];
    }
    if (sql.includes('SELECT status, metadata, updated_at FROM destinations')) {
      return [{ status: destinationStatus, metadata: {}, updated_at: new Date().toISOString() }];
    }
    if (sql.startsWith('UPDATE queue_items')) {
      return [];
    }
    if (sql.includes('SELECT destination_id FROM queue_items')) {
      return [{ destination_id: 'dest-1' }];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query, calls };
}

function request(): NextRequest {
  return new Request('http://localhost/api/tenant/ws/publishing/queue/x/publish-now', {
    method: 'POST',
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateTenantRoute.mockResolvedValue({
    session: { userId: 'user-1', role: 'user' },
  });
  mocks.isLegacyClient.mockReturnValue(true);
  mocks.resolveWorkspaceIdFromSession.mockResolvedValue('ws-1');
  mocks.getBillingAdminClient.mockReturnValue({});
  mocks.assertPaidPlan.mockResolvedValue(undefined);
  mocks.refreshDestinationUnmatchedFlag.mockResolvedValue(undefined);
  mocks.unifiedDestinationStatusToWire.mockImplementation((status: string) => status);
});

describe('handlePublishNow', () => {
  it('marks the row for immediate dispatch, not just re-times it', async () => {
    const db = fakeDb('queued', 'active');
    const res = await handlePublishNow(request(), 'ws', ITEM_ID, db as never);
    expect(res.status).toBe(200);
    const update = db.calls.find((c) => c.sql.startsWith('UPDATE queue_items'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('publish_now_requested_at = now()');
    expect(update!.sql).toContain("status = 'queued'");
    expect(update!.sql).toContain('claimed_at = NULL');
  });

  it('refuses a second tap while the row is already publishing, without updating', async () => {
    const db = fakeDb('publishing', 'active');
    const res = await handlePublishNow(request(), 'ws', ITEM_ID, db as never);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ALREADY_PUBLISHING');
    expect(db.calls.some((c) => c.sql.startsWith('UPDATE queue_items'))).toBe(false);
  });

  it('still refuses an already-published row', async () => {
    const db = fakeDb('published', 'active');
    const res = await handlePublishNow(request(), 'ws', ITEM_ID, db as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ALREADY_PUBLISHED');
    expect(db.calls.some((c) => c.sql.startsWith('UPDATE queue_items'))).toBe(false);
  });

  it('still refuses a non-publishable page, without updating', async () => {
    const db = fakeDb('queued', 'paused');
    const res = await handlePublishNow(request(), 'ws', ITEM_ID, db as never);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('PAGE_NOT_PUBLISHABLE');
    expect(db.calls.some((c) => c.sql.startsWith('UPDATE queue_items'))).toBe(false);
  });
});
