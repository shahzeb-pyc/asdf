/**
 * Disposable e2e tenant + seeded data (spec 137-A3, T33).
 *
 * The tenant exists only inside the intercepted browser traffic of a test
 * run: its session is a real signed cookie (HMAC-SHA256, the app's own
 * session format) minted against the e2e SESSION_SECRET from
 * playwright.config.ts, so middleware and the tenant layout verify it for
 * real. All API payloads below are fixture responses served via
 * `page.route` — nothing here touches production data or a real backend.
 */

import { createHmac } from 'node:crypto';

export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_SESSION_SECRET =
  'e2e-test-session-secret-not-for-production-0123456789abcdef';

export const TENANT = {
  subdomain: 'e2e',
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'e2e.owner@gmail.com',
  name: 'E2E Owner',
  password: 'e2e-correct-password',
  wrongPassword: 'e2e-wrong-password',
} as const;

export const FACEBOOK_PAGE = {
  id: '22222222-2222-4222-8222-222222222222',
  facebookAccountId: '33333333-3333-4333-8333-333333333333',
  accountDisplayName: 'E2E Connected Account',
  fbPageId: '100000000000001',
  pageName: 'E2E Test Page',
  category: 'Business Page',
  startingFollowers: 120,
  currentFollowers: 132,
  followersGained: 12,
  status: 'active',
  timezone: 'UTC',
  createdAt: '2026-10-01T00:00:00.000Z',
} as const;

/** The unified destination the seeded Facebook Page resolves to
 *  (destinations.external_destination_id = the page's Facebook id). */
export const FACEBOOK_DESTINATION = {
  id: '77777777-7777-4777-8777-777777777777',
  externalDestinationId: FACEBOOK_PAGE.fbPageId,
  name: FACEBOOK_PAGE.pageName,
  handle: null,
  avatarUrl: null,
  timezone: 'UTC',
  status: 'active',
  accountType: null,
} as const;

export const CONNECTED_ACCOUNT = {
  id: '33333333-3333-4333-8333-333333333333',
  fbAccountId: '100000000000099',
  displayName: 'E2E Connected Account',
  profilePictureUrl: null,
  accountLink: null,
  status: 'active',
  tokenExpiresAt: '2027-01-01T00:00:00.000Z',
  connectedPagesCount: 1,
  connectedPages: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as const;

export function queueItemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    userId: TENANT.userId,
    pageId: FACEBOOK_PAGE.id,
    slotId: null,
    mediaId: null,
    postFormat: 'text',
    linkUrl: null,
    caption: 'E2E queued caption',
    firstComment: null,
    scheduledTime: '2026-12-01T09:00:00.000Z',
    status: 'queued',
    retryCount: 0,
    maxRetries: 3,
    fbPostId: null,
    fbCommentId: null,
    publishedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    media: null,
    ...overrides,
  };
}

export function mediaItemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    userId: TENANT.userId,
    folderId: null,
    name: 'e2e-sunset.png',
    fileSize: 68,
    mimeType: 'image/png',
    mediaType: 'image',
    storageKey: 'e2e/e2e-sunset.png',
    url: 'https://storage.e2e.invalid/e2e/e2e-sunset.png',
    thumbnailKey: null,
    thumbnailUrl: null,
    durationSeconds: null,
    aspectRatio: '1:1',
    captionText: 'e2e sunset',
    width: 1,
    height: 1,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/={1,2}$/, '');
}

/**
 * Mints a session token in the app's own format (HS256 JWT — see
 * @fbuploadpro/contracts signSessionToken) for the disposable tenant.
 */
export function mintSessionToken(
  role: 'admin' | 'user' | 'seller' = 'admin'
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      userId: TENANT.userId,
      email: TENANT.email,
      name: TENANT.name,
      subdomain: TENANT.subdomain,
      role,
      status: 'active',
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = base64Url(
    createHmac('sha256', E2E_SESSION_SECRET).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

export const SESSION_COOKIE = {
  name: 'fbup_session',
  value: mintSessionToken(),
  domain: 'localhost',
  path: '/',
  httpOnly: true,
  sameSite: 'Lax' as const,
  expires: Math.floor(Date.now() / 1000) + 3600,
};

/** A 1×1 transparent PNG used as the media-upload fixture file. */
export const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function pngFixtureFile() {
  return {
    name: 'e2e-sunset.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BASE64, 'base64'),
  };
}
