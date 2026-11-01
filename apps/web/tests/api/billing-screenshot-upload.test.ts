import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as mintScreenshotUpload } from '@/app/api/tenant/[subdomain]/billing/payments/screenshot-upload/route';

/**
 * Screenshot upload mint (submit rewrite 2026-11-01): the checkout
 * mints a presigned R2 PUT URL namespaced to the caller, then PUTs
 * the bytes straight to R2. The payment POST later references the
 * key — it never sees the file.
 */

const userId = '11111111-1111-4111-a111-111111111111';

const authRole = vi.hoisted(() => ({ role: 'user' }));
const authSession = vi.hoisted(() => ({ present: true }));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => {
    if (!authSession.present) {
      return { errorResponse: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) };
    }
    return {
      session: {
        userId,
        email: 'buyer@example.com',
        name: 'Buyer',
        subdomain: 'acme',
        role: authRole.role,
        status: 'active',
      },
    };
  }),
}));

vi.mock('@/lib/storage', () => ({
  getStorageService: () => ({
    getPresignedUploadUrl: vi.fn(async ({ key }: { key: string }) => ({
      uploadUrl: `https://r2.example.com/${key}?sig=test`,
      publicUrl: `https://media.example.com/${key}`,
      expiresInSeconds: 900,
    })),
  }),
}));

vi.mock('@/lib/request-body', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/request-body')>();
  return { ...actual, enforceIpRateLimit: vi.fn(async () => null) };
});

const ctx = { params: Promise.resolve({ subdomain: 'acme' }) };

function mintRequest(body: unknown): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/tenant/acme/billing/payments/screenshot-upload',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

describe('screenshot upload mint', () => {
  beforeEach(() => {
    authRole.role = 'user';
    authSession.present = true;
  });

  it('mints a caller-namespaced key and a presigned URL for a valid image', async () => {
    const res = await mintScreenshotUpload(
      mintRequest({ mimeType: 'image/png', fileSize: 1024 }),
      ctx
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storageKey).toMatch(
      new RegExp(`^billing-screenshots/${userId}/[0-9a-f-]{36}\\.png$`)
    );
    expect(body.uploadUrl).toContain('r2.example.com');
    expect(body.expiresInSeconds).toBe(900);
  });

  it('rejects a non-image MIME type with 400', async () => {
    const res = await mintScreenshotUpload(
      mintRequest({ mimeType: 'application/pdf', fileSize: 1024 }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
  });

  it('rejects an oversize declared file with 400', async () => {
    const res = await mintScreenshotUpload(
      mintRequest({ mimeType: 'image/png', fileSize: 11 * 1024 * 1024 }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  it('rejects admin accounts with 403, like the payment route', async () => {
    authRole.role = 'admin';
    const res = await mintScreenshotUpload(
      mintRequest({ mimeType: 'image/png', fileSize: 1024 }),
      ctx
    );
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests with the auth error response', async () => {
    authSession.present = false;
    const res = await mintScreenshotUpload(
      mintRequest({ mimeType: 'image/png', fileSize: 1024 }),
      ctx
    );
    expect(res.status).toBe(401);
  });
});
