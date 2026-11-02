import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { NextResponse } from 'next/server';

const { findUserByEmailDetailedMock } = vi.hoisted(() => ({ findUserByEmailDetailedMock: vi.fn() }));

vi.mock('../../../src/lib/auth/users', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/auth/users')>();
  return {
    ...original,
    findUserByEmailDetailed: findUserByEmailDetailedMock,
  };
});

import {
  clearSessionCookiesBestEffort,
  validateSessionActive,
  validateSessionDetailed,
} from '../../../src/lib/auth/session';

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    userId: '11111111-1111-4111-a111-111111111111',
    email: 'user@example.com',
    status: 'active',
    iat: 2000,
    exp: 9999,
    role: 'user',
    subdomain: 'user',
    ...overrides,
  } as Parameters<typeof validateSessionActive>[0];
}

function foundUser(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    email: 'user@example.com',
    status: 'active',
    passwordUpdatedAt: undefined,
    ...overrides,
  };
}

/** Minimal response stub: the helper only appends Set-Cookie headers. */
function stubResponse(): { response: NextResponse; appended: string[] } {
  const appended: string[] = [];
  const response = {
    headers: {
      append: (_name: string, value: string) => {
        appended.push(value);
      },
    },
  } as unknown as NextResponse;
  return { response, appended };
}

describe('validateSessionActive (claim-only)', () => {
  it('trusts the status claim only', async () => {
    await expect(validateSessionActive(sessionPayload())).resolves.toBe(true);
    await expect(
      validateSessionActive(sessionPayload({ status: 'suspended' }))
    ).resolves.toBe(false);
  });

  it('never consults the database', async () => {
    findUserByEmailDetailedMock.mockClear();
    await validateSessionActive(sessionPayload());
    expect(findUserByEmailDetailedMock).not.toHaveBeenCalled();
  });
});

describe('validateSessionDetailed (global check verdict)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dead for a suspended claim without a lookup', async () => {
    await expect(
      validateSessionDetailed(sessionPayload({ status: 'suspended' }))
    ).resolves.toBe('dead');
    expect(findUserByEmailDetailedMock).not.toHaveBeenCalled();
  });

  it('returns error when the user lookup itself fails (never dead)', async () => {
    findUserByEmailDetailedMock.mockResolvedValue({ kind: 'error' });
    await expect(validateSessionDetailed(sessionPayload())).resolves.toBe('error');
  });

  it('returns dead when the user is genuinely absent', async () => {
    findUserByEmailDetailedMock.mockResolvedValue({ kind: 'absent' });
    await expect(validateSessionDetailed(sessionPayload())).resolves.toBe('dead');
  });

  it('returns dead when the user is not active', async () => {
    findUserByEmailDetailedMock.mockResolvedValue({
      kind: 'found',
      user: foundUser({ status: 'suspended' }),
    });
    await expect(validateSessionDetailed(sessionPayload())).resolves.toBe('dead');
  });

  it('returns dead when the password changed after login', async () => {
    findUserByEmailDetailedMock.mockResolvedValue({
      kind: 'found',
      user: foundUser({ passwordUpdatedAt: 2000 }),
    });
    await expect(validateSessionDetailed(sessionPayload({ iat: 2000 }))).resolves.toBe('dead');
  });

  it('returns active for a live user with an older password change', async () => {
    findUserByEmailDetailedMock.mockResolvedValue({
      kind: 'found',
      user: foundUser({ passwordUpdatedAt: 1000 }),
    });
    await expect(validateSessionDetailed(sessionPayload({ iat: 2000 }))).resolves.toBe('active');
  });

  it('returns active for a live user with no password change recorded', async () => {
    findUserByEmailDetailedMock.mockResolvedValue({ kind: 'found', user: foundUser() });
    await expect(validateSessionDetailed(sessionPayload())).resolves.toBe('active');
  });
});

describe('clearSessionCookiesBestEffort', () => {
  const originalRoot = process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  const originalCookieDomain = process.env.COOKIE_DOMAIN;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
    delete process.env.COOKIE_DOMAIN;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    else process.env.NEXT_PUBLIC_ROOT_DOMAIN = originalRoot;
    if (originalCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = originalCookieDomain;
  });

  it('emits host-only, shared-domain, and exact-host clears on a tenant host', () => {
    const { response, appended } = stubResponse();
    clearSessionCookiesBestEffort(response, 'creatorstack10.fbuploadpro.com');
    expect(appended).toHaveLength(3);
    for (const header of appended) {
      expect(header).toContain('fbup_session=;');
      expect(header).toContain('Path=/');
      expect(header).toContain('Max-Age=0');
      expect(header).toContain('HttpOnly');
    }
    // Host-only: no Domain attribute at all.
    expect(appended.some((h) => !h.includes('Domain='))).toBe(true);
    expect(appended.some((h) => h.includes('Domain=.fbuploadpro.com'))).toBe(true);
    expect(
      appended.some((h) => h.includes('Domain=creatorstack10.fbuploadpro.com'))
    ).toBe(true);
  });

  it('emits only the host-only clear on localhost', () => {
    const { response, appended } = stubResponse();
    clearSessionCookiesBestEffort(response, 'localhost:3000');
    expect(appended).toHaveLength(1);
    expect(appended[0]).not.toContain('Domain=');
  });

  it('emits only the host-only clear on a preview host outside the root', () => {
    const { response, appended } = stubResponse();
    clearSessionCookiesBestEffort(response, 'asdf-abc123-velocta.vercel.app');
    expect(appended).toHaveLength(1);
    expect(appended[0]).not.toContain('Domain=');
  });

  it('emits host-only, shared, and exact-host clears on the apex host', () => {
    const { response, appended } = stubResponse();
    clearSessionCookiesBestEffort(response, 'fbuploadpro.com');
    expect(appended).toHaveLength(3);
    expect(appended.some((h) => !h.includes('Domain='))).toBe(true);
    expect(appended.some((h) => h.includes('Domain=.fbuploadpro.com'))).toBe(true);
    expect(appended.some((h) => h.includes('Domain=fbuploadpro.com'))).toBe(true);
  });

  it('never throws, even with no host', () => {
    const { response, appended } = stubResponse();
    expect(() => clearSessionCookiesBestEffort(response, null)).not.toThrow();
    expect(appended.length).toBeGreaterThanOrEqual(1);
  });
});
