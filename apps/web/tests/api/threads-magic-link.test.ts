/**
 * @file threads-magic-link.test.ts
 * @description Route tests for the Threads magic-link flow, following
 * the Facebook magic-link pattern exactly: generation (15-minute
 * signed token, BYOC pre-check), the /connect/threads entry (token
 * verify → signed isMagic connect state → Threads authorize), and
 * the shared buildMagicConnectUrl host rule (app host, never the
 * tenant host). These tests can catch a regression that would break
 * the "Different Browser or Phone" option in the Threads connect
 * modal — the exact gap Shahzeb's correction called out.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signMagicLinkToken,
  signSessionToken,
  verifyMagicLinkToken,
} from '@fbuploadpro/contracts';
import { verifyConnectState } from '../../src/lib/connect/state';
import { handleGenerateThreadsMagicLink } from '../../src/app/api/tenant/[subdomain]/threads/accounts/magic-link/route';
import { handleConnectThreads } from '../../src/app/connect/threads/route';
import { buildMagicConnectUrl } from '../../src/lib/connect/magic-url';

const TEST_SECRET = 'test-session-secret-for-threads-magic-link';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const USER_ID = '11111111-1111-4111-a111-111111111111';

type Row = Record<string, unknown>;

/** Minimal chainable fake for the two lookups the flow makes. */
function makeFake(opts: { hasCredentials?: boolean; hasWorkspace?: boolean } = {}) {
  const { hasCredentials = true, hasWorkspace = true } = opts;
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === 'workspaces') {
            return {
              data: hasWorkspace ? { id: 'ws-1', subdomain: 'acme' } : null,
              error: null,
            };
          }
          if (table === 'platform_credentials') {
            if (!hasCredentials) return { data: null, error: null };
            const encrypted = await encryptToken('th_secret_456', TEST_ENCRYPTION_KEY);
            return {
              data: { client_id: 'th_app_id_123', encrypted_client_secret: encrypted },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}

describe('Threads magic-link generation', () => {
  let cookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    cookie = `fbup_session=${token}`;
  });

  function postMagicLink(body: Row, fake: unknown) {
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/threads/accounts/magic-link',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return handleGenerateThreadsMagicLink(req, 'acme', fake as never);
  }

  it('generates a 15-minute link carrying the expected account', async () => {
    const res = await postMagicLink(
      {
        expectedExternalAccountId: 'th-exp',
        expectedDisplayName: 'Expired Willow',
      },
      makeFake()
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.expiresInSeconds).toBe(900);
    expect(json.magicUrl).toMatch(
      /^https:\/\/app\.example\.test\/connect\/threads\?token=/
    );
    const token = new URL(json.magicUrl).searchParams.get('token')!;
    const payload = await verifyMagicLinkToken(token, TEST_SECRET);
    expect(payload.tenantSubdomain).toBe('acme');
    expect(payload.expectedExternalAccountId).toBe('th-exp');
    expect(payload.expectedDisplayName).toBe('Expired Willow');
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('rejects generation when Threads BYOC is not configured', async () => {
    const res = await postMagicLink({}, makeFake({ hasCredentials: false }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('BYOC_NOT_CONFIGURED');
  });

  it('rejects unauthenticated generation', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/threads/accounts/magic-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    const res = await handleGenerateThreadsMagicLink(req, 'acme', makeFake() as never);
    expect(res.status).toBe(401);
  });
});

describe('Threads magic-link entry (/connect/threads)', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
  });

  async function validToken(extra: Row = {}) {
    const now = Math.floor(Date.now() / 1000);
    return signMagicLinkToken(
      {
        tenantSubdomain: 'acme',
        userId: USER_ID,
        nonce: 'nonce-threads-magic',
        iat: now,
        exp: now + 900,
        ...extra,
      },
      TEST_SECRET
    );
  }

  it('redirects a valid token to the Threads authorize window with an isMagic state', async () => {
    const token = await validToken({
      expectedExternalAccountId: 'th-exp',
      expectedDisplayName: 'Expired Willow',
    });
    const req = new NextRequest(
      `http://localhost:3000/connect/threads?token=${token}`
    );
    const res = await handleConnectThreads(req, makeFake() as never);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('threads.com/oauth/authorize');
    expect(location).toContain('client_id=th_app_id_123');
    const state = new URL(location).searchParams.get('state')!;
    const statePayload = await verifyConnectState(state, TEST_SECRET);
    expect(statePayload.platform).toBe('threads');
    expect(statePayload.isMagic).toBe(true);
    expect(statePayload.expectedExternalAccountId).toBe('th-exp');
    expect(statePayload.expectedDisplayName).toBe('Expired Willow');
  });

  it('redirects a missing token to the error page', async () => {
    const req = new NextRequest('http://localhost:3000/connect/threads');
    const res = await handleConnectThreads(req, makeFake() as never);
    expect(res.headers.get('location')).toContain(
      '/connect/threads/error?reason=missing_token'
    );
  });

  it('redirects an expired token to the error page', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signMagicLinkToken(
      {
        tenantSubdomain: 'acme',
        userId: USER_ID,
        nonce: 'nonce-threads-expired',
        iat: now - 1800,
        exp: now - 900,
      },
      TEST_SECRET
    );
    const req = new NextRequest(
      `http://localhost:3000/connect/threads?token=${token}`
    );
    const res = await handleConnectThreads(req, makeFake() as never);
    expect(res.headers.get('location')).toContain(
      '/connect/threads/error?reason=expired_or_invalid'
    );
  });

  it('redirects a valid token without BYOC to app_not_configured', async () => {
    const token = await validToken();
    const req = new NextRequest(
      `http://localhost:3000/connect/threads?token=${token}`
    );
    const res = await handleConnectThreads(
      req,
      makeFake({ hasCredentials: false }) as never
    );
    expect(res.headers.get('location')).toContain(
      '/connect/threads/error?reason=app_not_configured'
    );
  });
});

describe('buildMagicConnectUrl host rule', () => {
  it('builds the success URL on the app host, never the tenant host', () => {
    const url = buildMagicConnectUrl(
      '/connect/threads/success',
      'https://acme.example.test/api/connect/threads/callback?code=x',
      'example.test',
      'https://app.example.test'
    );
    expect(url.origin).toBe('https://app.example.test');
    expect(url.pathname).toBe('/connect/threads/success');
  });

  it('keeps the request origin on localhost and Vercel previews', () => {
    const local = buildMagicConnectUrl(
      '/connect/threads/success',
      'http://localhost:3000/api/connect/threads/callback',
      '',
      'http://localhost:3000'
    );
    expect(local.origin).toBe('http://localhost:3000');
    const preview = buildMagicConnectUrl(
      '/connect/threads/success',
      'https://asdf-git-feat-x.vercel.app/api/connect/threads/callback',
      'example.test',
      'https://app.example.test'
    );
    expect(preview.origin).toBe('https://asdf-git-feat-x.vercel.app');
  });

  it('falls back to app.<root> when no app URL is configured', () => {
    const url = buildMagicConnectUrl(
      '/connect/threads/success',
      'https://acme.example.test/api/connect/threads/callback',
      'example.test',
      'not-a-url'
    );
    expect(url.origin).toBe('https://app.example.test');
  });
});
