import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as streamScreenshot } from '@/app/api/tenant/[subdomain]/billing/admin/payments/[paymentId]/screenshot/route';
import { logServerError } from '@/lib/server-analytics';

/**
 * Admin payment screenshot stream: a database lookup failure must
 * fail loud (logged + 500), never masquerade as "not found" (404).
 * Regression coverage for the 2026-11-01 admin click that returned
 * 404 for a payment whose row, key, and R2 object all existed.
 */

const authRole = vi.hoisted(() => ({ role: 'admin' }));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
      subdomain: 'acme',
      role: authRole.role,
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = { screenshot_storage_key: string | null };

const dbState = vi.hoisted(() => ({
  row: null as Row | null,
  selectError: null as { message: string } | null,
}));

const r2State = vi.hoisted(() => ({
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  bodyMissing: false,
}));

vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: dbState.row,
            error: dbState.selectError,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/storage', () => ({
  getR2Config: () => ({
    accountId: 'test-account',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    bucketName: 'test-bucket',
    publicUrl: 'https://media.example.com',
  }),
  createR2S3Client: () => ({
    send: async () =>
      r2State.bodyMissing
        ? {}
        : {
            Body: {
              transformToByteArray: async () => r2State.bytes,
            },
          },
  }),
}));

const paymentId = '3820c197-9549-483a-bb4b-77fcf3485db1';

function streamRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/tenant/acme/billing/admin/payments/${paymentId}/screenshot`,
    { method: 'GET' }
  );
}

const ctx = {
  params: Promise.resolve({ subdomain: 'acme', paymentId }),
};

describe('admin payment screenshot stream', () => {
  beforeEach(() => {
    authRole.role = 'admin';
    dbState.row = null;
    dbState.selectError = null;
    r2State.bodyMissing = false;
    vi.mocked(logServerError).mockClear();
  });

  it('returns 500 (not 404) and logs when the database lookup fails', async () => {
    dbState.selectError = { message: 'permission denied for table subscription_payments' };
    dbState.row = { screenshot_storage_key: 'billing-screenshots/user/key.png' };

    const res = await streamScreenshot(streamRequest(), ctx);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Screenshot could not be loaded. Please try again.',
    });
    expect(logServerError).toHaveBeenCalledWith(
      expect.stringContaining('screenshot'),
      expect.anything(),
      expect.objectContaining({ paymentId })
    );
  });

  it('returns 404 when no payment row exists', async () => {
    dbState.row = null;

    const res = await streamScreenshot(streamRequest(), ctx);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Screenshot not found' });
    expect(logServerError).not.toHaveBeenCalled();
  });

  it('returns 404 when the row has an empty key', async () => {
    dbState.row = { screenshot_storage_key: '' };

    const res = await streamScreenshot(streamRequest(), ctx);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Screenshot not found' });
  });

  it('returns 404 when the key contains a path traversal', async () => {
    dbState.row = { screenshot_storage_key: 'billing-screenshots/../secret.png' };

    const res = await streamScreenshot(streamRequest(), ctx);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Screenshot not found' });
  });

  it('streams the R2 object with the extension content type for a valid key', async () => {
    dbState.row = {
      screenshot_storage_key: 'billing-screenshots/user/key.png',
    };

    const res = await streamScreenshot(streamRequest(), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(r2State.bytes);
  });

  it('returns 403 for non-admins before any storage access', async () => {
    authRole.role = 'user';

    const res = await streamScreenshot(streamRequest(), ctx);

    expect(res.status).toBe(403);
  });
});
