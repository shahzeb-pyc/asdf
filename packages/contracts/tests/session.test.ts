import { describe, it, expect } from 'vitest';
import {
  asWorkspaceIdClaim,
  SessionPayloadSchema,
  signSessionToken,
  verifySessionToken,
} from '../src/domain/session';
import { DomainError, DomainErrorCode } from '../src/errors/domain-error';
import {
  TEST_SESSION_SECRET,
  mockUserSession,
} from './fixtures/session';

describe('Session Authentication Contracts (SessionPayload & Web Crypto Tokens)', () => {
  it('validates a conformant SessionPayload', () => {
    const result = SessionPayloadSchema.safeParse(mockUserSession);
    expect(result.success).toBe(true);
  });

  it('rejects SessionPayload with invalid UUID', () => {
    const invalid = { ...mockUserSession, userId: 'not-a-uuid' };
    const result = SessionPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects SessionPayload with reserved or malformed subdomain', () => {
    const invalidSubdomain = { ...mockUserSession, subdomain: 'api' };
    const result = SessionPayloadSchema.safeParse(invalidSubdomain);
    expect(result.success).toBe(false);
  });

  it('rejects SessionPayload with invalid role or status', () => {
    const invalidRole = { ...mockUserSession, role: 'super-hacker' };
    expect(SessionPayloadSchema.safeParse(invalidRole).success).toBe(false);

    const invalidStatus = { ...mockUserSession, status: 'banned' };
    expect(SessionPayloadSchema.safeParse(invalidStatus).success).toBe(false);
  });

  it('signs and verifies a valid session token using Web Crypto API', async () => {
    const token = await signSessionToken(mockUserSession, TEST_SESSION_SECRET);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    const decoded = await verifySessionToken(token, TEST_SESSION_SECRET);
    expect(decoded.userId).toBe(mockUserSession.userId);
    expect(decoded.email).toBe(mockUserSession.email);
    expect(decoded.subdomain).toBe(mockUserSession.subdomain);
    expect(decoded.role).toBe(mockUserSession.role);
    expect(decoded.status).toBe(mockUserSession.status);
  });

  it('signs and verifies session token preserving allowedSubdomains', async () => {
    const sessionWithAllowed = {
      ...mockUserSession,
      allowedSubdomains: ['acme', 'acme-two', 'acme-three'],
    };
    const token = await signSessionToken(sessionWithAllowed, TEST_SESSION_SECRET);
    const decoded = await verifySessionToken(token, TEST_SESSION_SECRET);
    expect(decoded.allowedSubdomains).toEqual(['acme', 'acme-two', 'acme-three']);
  });

  it('rejects session token verified with wrong secret', async () => {
    const token = await signSessionToken(mockUserSession, TEST_SESSION_SECRET);
    await expect(
      verifySessionToken(token, 'different-wrong-secret-minimum-32-chars-long')
    ).rejects.toThrow(DomainError);

    try {
      await verifySessionToken(token, 'different-wrong-secret-minimum-32-chars-long');
    } catch (err: unknown) {
      const error = err as DomainError;
      expect(error.code).toBe(DomainErrorCode.UNAUTHORIZED);
    }
  });

  it('rejects tampered session token payload', async () => {
    const token = await signSessionToken(mockUserSession, TEST_SESSION_SECRET);
    const [header, payload, sig] = token.split('.');
    
    // Tamper payload by modifying characters
    const tamperedPayload = payload + 'x';
    const tamperedToken = `${header}.${tamperedPayload}.${sig}`;

    await expect(verifySessionToken(tamperedToken, TEST_SESSION_SECRET)).rejects.toThrow();
  });

  it('rejects expired session token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredSession = {
      ...mockUserSession,
      iat: now - 3600, // issued 1 hour ago
      exp: now - 100, // expired in past, but after iat
    };
    const token = await signSessionToken(expiredSession, TEST_SESSION_SECRET);

    await expect(verifySessionToken(token, TEST_SESSION_SECRET)).rejects.toThrow(DomainError);
    try {
      await verifySessionToken(token, TEST_SESSION_SECRET);
    } catch (err: unknown) {
      const error = err as DomainError;
      expect(error.code).toBe(DomainErrorCode.UNAUTHORIZED);
      expect(error.message).toContain('expired');
    }
  });

  describe('JWT header and timestamp sanity validation (ISSUE-40)', () => {
    it.each([
      ['alg is none', { alg: 'none', typ: 'JWT' }, 'Unsupported or missing algorithm in session token header'],
      ['alg is HS512', { alg: 'HS512', typ: 'JWT' }, 'Unsupported or missing algorithm in session token header'],
      ['typ is not JWT', { alg: 'HS256', typ: 'JOSE' }, 'Invalid session token header type'],
      ['missing header claims', {}, 'Unsupported or missing algorithm in session token header'],
    ])('rejects token when header %s', async (_, header, expectedMessage) => {
      const encoder = new TextEncoder();
      const b64 = (s: string) => Buffer.from(s).toString('base64url');
      const headerPart = b64(JSON.stringify(header));
      const payloadPart = b64(JSON.stringify(mockUserSession));
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(TEST_SESSION_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(`${headerPart}.${payloadPart}`));
      const sigPart = b64(Buffer.from(sigBuffer).toString('binary'));
      const forgedToken = `${headerPart}.${payloadPart}.${sigPart}`;

      await expect(verifySessionToken(forgedToken, TEST_SESSION_SECRET)).rejects.toThrow(
        expectedMessage
      );
    });

    it('rejects token when exp is less than or equal to iat', async () => {
      const now = Math.floor(Date.now() / 1000);
      const invalidTimeSession = {
        ...mockUserSession,
        iat: now,
        exp: now, // exp <= iat
      };
      const token = await signSessionToken(invalidTimeSession, TEST_SESSION_SECRET);
      await expect(verifySessionToken(token, TEST_SESSION_SECRET)).rejects.toThrow(
        'Session token expiration must be strictly after issued-at time'
      );
    });

    it('rejects token with futuristic iat exceeding clock skew allowance', async () => {
      const farFuture = Math.floor(Date.now() / 1000) + 600; // 10 minutes in future
      const futureSession = {
        ...mockUserSession,
        iat: farFuture,
        exp: farFuture + 3600,
      };
      const token = await signSessionToken(futureSession, TEST_SESSION_SECRET);
      await expect(verifySessionToken(token, TEST_SESSION_SECRET)).rejects.toThrow(
        'Session token issued in the future'
      );
    });
  });

  describe('workspaceId claim (S3)', () => {
    const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';

    it('A1: accepts a payload with and without workspaceId', () => {
      expect(
        SessionPayloadSchema.safeParse({ ...mockUserSession, workspaceId: WORKSPACE_ID })
          .success
      ).toBe(true);
      expect(SessionPayloadSchema.safeParse(mockUserSession).success).toBe(true);
    });

    it('A1: rejects a non-UUID workspaceId', () => {
      const result = SessionPayloadSchema.safeParse({
        ...mockUserSession,
        workspaceId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });

    it('A2: a pre-S3 token (no claim) verifies cleanly with workspaceId undefined', async () => {
      const token = await signSessionToken(mockUserSession, TEST_SESSION_SECRET);
      const decoded = await verifySessionToken(token, TEST_SESSION_SECRET);
      expect(decoded.workspaceId).toBeUndefined();
    });

    it('A3: signSessionToken round-trips the workspaceId claim', async () => {
      const token = await signSessionToken(
        { ...mockUserSession, workspaceId: WORKSPACE_ID },
        TEST_SESSION_SECRET
      );
      const decoded = await verifySessionToken(token, TEST_SESSION_SECRET);
      expect(decoded.workspaceId).toBe(WORKSPACE_ID);
    });

    it('A4: a token whose workspaceId is tampered with fails verification', async () => {
      const token = await signSessionToken(
        { ...mockUserSession, workspaceId: WORKSPACE_ID },
        TEST_SESSION_SECRET
      );
      const [header, payload, sig] = token.split('.');
      const payloadJson = JSON.parse(
        Buffer.from(payload as string, 'base64url').toString('utf8')
      ) as Record<string, unknown>;
      payloadJson.workspaceId = '66666666-6666-4666-8666-666666666666';
      const tamperedPayload = Buffer.from(JSON.stringify(payloadJson)).toString('base64url');
      const tamperedToken = `${header}.${tamperedPayload}.${sig}`;
      await expect(verifySessionToken(tamperedToken, TEST_SESSION_SECRET)).rejects.toThrow(
        DomainError
      );
    });

    it('A5: a new token parses under the old schema (unknown key stripped), so rollback cannot lock users out', () => {
      // The pre-S3 schema had no workspaceId field. Zod strips unknown
      // keys, so a new token verifies as a claimless token under old
      // code and every route falls back to the DB lookup.
      const oldSchema = SessionPayloadSchema.omit({ workspaceId: true });
      const parsed = oldSchema.safeParse({
        ...mockUserSession,
        workspaceId: WORKSPACE_ID,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect('workspaceId' in parsed.data).toBe(false);
      }
    });

    it('A5b: asWorkspaceIdClaim passes a valid UUID through and drops anything else, so a non-UUID id can never make signSessionToken throw', () => {
      // Regression: the full web suite 500'd the workspaces
      // create/switch routes because fake ids like 'ws-1' hit the
      // schema's UUID validation. Mint sites guard through this
      // helper, so those ids mint claimless instead of failing auth.
      expect(asWorkspaceIdClaim(WORKSPACE_ID)).toBe(WORKSPACE_ID);
      expect(asWorkspaceIdClaim('ws-1')).toBeUndefined();
      expect(asWorkspaceIdClaim('not-a-uuid')).toBeUndefined();
      expect(asWorkspaceIdClaim(null)).toBeUndefined();
      expect(asWorkspaceIdClaim(undefined)).toBeUndefined();
    });
  });

  describe('getSessionSecret', () => {
    it('throws DomainError in production when SESSION_SECRET is missing', async () => {
      const { getSessionSecret } = await import('../src/domain/session');
      expect(() =>
        getSessionSecret({ NODE_ENV: 'production' })
      ).toThrowError(/strictly required in production/);
    });

    it('throws DomainError when SESSION_SECRET is shorter than 32 chars', async () => {
      const { getSessionSecret } = await import('../src/domain/session');
      expect(() =>
        getSessionSecret({ SESSION_SECRET: 'short-key' })
      ).toThrowError(/at least 32 characters long/);
    });

    it('throws DomainError when NODE_ENV is undefined and SESSION_SECRET is missing (ISSUE-39)', async () => {
      const { getSessionSecret } = await import('../src/domain/session');
      expect(() =>
        getSessionSecret({})
      ).toThrowError(/strictly required/);
    });

    it('throws DomainError when NODE_ENV is staging and SESSION_SECRET is missing (ISSUE-39)', async () => {
      const { getSessionSecret } = await import('../src/domain/session');
      expect(() =>
        getSessionSecret({ NODE_ENV: 'staging' })
      ).toThrowError(/strictly required/);
    });

    it('returns development fallback secret when NODE_ENV is development or test', async () => {
      const { getSessionSecret } = await import('../src/domain/session');
      const devSecret = getSessionSecret({ NODE_ENV: 'development' });
      expect(devSecret).toBe('super-secret-session-signing-key-minimum-32-chars-long');

      const testSecret = getSessionSecret({ NODE_ENV: 'test' });
      expect(testSecret).toBe('super-secret-session-signing-key-minimum-32-chars-long');
    });

    it('returns configured SESSION_SECRET when valid', async () => {
      const { getSessionSecret } = await import('../src/domain/session');
      const secret = getSessionSecret({
        SESSION_SECRET: 'valid-custom-secret-key-that-is-at-least-32-chars',
      });
      expect(secret).toBe('valid-custom-secret-key-that-is-at-least-32-chars');
    });
  });

  describe('isSessionAuthorizedForSubdomain (ISSUE-23)', () => {
    it('authorizes when requestedSubdomain matches session.subdomain', async () => {
      const { isSessionAuthorizedForSubdomain } = await import('../src/domain/session');
      expect(
        isSessionAuthorizedForSubdomain(
          { subdomain: 'acme', role: 'user', allowedSubdomains: ['acme'] },
          'acme'
        )
      ).toBe(true);
    });

    it('authorizes when requestedSubdomain is in allowedSubdomains', async () => {
      const { isSessionAuthorizedForSubdomain } = await import('../src/domain/session');
      expect(
        isSessionAuthorizedForSubdomain(
          { subdomain: 'acme', role: 'user', allowedSubdomains: ['acme', 'acme-beta'] },
          'acme-beta'
        )
      ).toBe(true);
    });

    it('authorizes case-insensitively', async () => {
      const { isSessionAuthorizedForSubdomain } = await import('../src/domain/session');
      expect(
        isSessionAuthorizedForSubdomain(
          { subdomain: 'ACME', role: 'user', allowedSubdomains: ['ACME', 'ACME-BETA'] },
          'acme-beta'
        )
      ).toBe(true);
    });

    it('always authorizes admin role across any subdomain', async () => {
      const { isSessionAuthorizedForSubdomain } = await import('../src/domain/session');
      expect(
        isSessionAuthorizedForSubdomain(
          { subdomain: 'platform-admin', role: 'admin' },
          'any-tenant'
        )
      ).toBe(true);
    });

    it('denies access when requestedSubdomain is not in subdomain or allowedSubdomains', async () => {
      const { isSessionAuthorizedForSubdomain } = await import('../src/domain/session');
      expect(
        isSessionAuthorizedForSubdomain(
          { subdomain: 'acme', role: 'user', allowedSubdomains: ['acme', 'acme-beta'] },
          'unauthorized-org'
        )
      ).toBe(false);
    });
  });
});


