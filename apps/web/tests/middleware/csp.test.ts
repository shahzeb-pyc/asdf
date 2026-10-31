import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  CSP_HEADER_NAME,
  CSP_REPORT_PATH,
  buildContentSecurityPolicy,
  generateNonce,
  parseCspReports,
} from '../../src/lib/csp';
import { middleware } from '../../src/middleware';

describe('CSP nonce generation (Spec 114 Phase 1)', () => {
  it('returns base64-charset strings', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(nonce.length).toBeGreaterThan(0);
  });

  it('returns a different value on each call', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe('buildContentSecurityPolicy', () => {
  const policy = buildContentSecurityPolicy('testnonce123');

  it('contains every legacy directive verbatim', () => {
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("img-src 'self' data: https:");
    expect(policy).toContain(
      "connect-src 'self' https://*.supabase.co https://us.i.posthog.com https://eu.i.posthog.com"
    );
    expect(policy).toContain("font-src 'self' data:");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
  });

  it('includes the passed nonce in script-src without unsafe-inline', () => {
    const scriptSrc = policy
      .split('; ')
      .find((directive) => directive.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self' 'nonce-testnonce123'");
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('wires violation reporting to the first-party endpoint', () => {
    expect(policy).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy).toContain('report-to csp-endpoint');
    expect(CSP_REPORT_PATH).toBe('/api/csp-report');
  });
});

describe('parseCspReports', () => {
  it('normalizes the legacy report-uri format', () => {
    const reports = parseCspReports({
      'csp-report': {
        'document-uri': 'https://example.com/login',
        'blocked-uri': 'inline',
        'violated-directive': "script-src 'self'",
        'effective-directive': 'script-src',
        'source-file': 'https://example.com/login',
        'line-number': 12,
        'column-number': 34,
      },
    });
    expect(reports).toEqual([
      {
        documentUri: 'https://example.com/login',
        blockedUri: 'inline',
        effectiveDirective: 'script-src',
        sourceFile: 'https://example.com/login',
        lineNumber: '12',
        columnNumber: '34',
      },
    ]);
  });

  it('normalizes the Reporting API array format', () => {
    const reports = parseCspReports([
      {
        type: 'csp-violation',
        url: 'https://example.com/dashboard',
        body: {
          documentURL: 'https://example.com/dashboard',
          blockedURL: 'https://evil.example/script.js',
          effectiveDirective: 'script-src',
          sourceFile: 'https://example.com/dashboard',
          lineNumber: 5,
          columnNumber: 1,
        },
      },
    ]);
    expect(reports).toEqual([
      {
        documentUri: 'https://example.com/dashboard',
        blockedUri: 'https://evil.example/script.js',
        effectiveDirective: 'script-src',
        sourceFile: 'https://example.com/dashboard',
        lineNumber: '5',
        columnNumber: '1',
      },
    ]);
  });

  it('returns [] for garbage input', () => {
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports(undefined)).toEqual([]);
    expect(parseCspReports('not a report')).toEqual([]);
    expect(parseCspReports(42)).toEqual([]);
    expect(parseCspReports({})).toEqual([]);
    expect(parseCspReports({ 'csp-report': 'junk' })).toEqual([]);
    expect(parseCspReports(['junk', 42, null, { body: 'junk' }])).toEqual([]);
  });

  it('truncates long fields to 512 characters', () => {
    const longValue = 'a'.repeat(1000);
    const reports = parseCspReports({
      'csp-report': {
        'document-uri': longValue,
        'blocked-uri': 'inline',
        'effective-directive': 'script-src',
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.documentUri).toHaveLength(512);
  });
});

describe('middleware CSP headers', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
  });

  function expectCspHeaders(res: Awaited<ReturnType<typeof middleware>>) {
    const csp = res.headers.get(CSP_HEADER_NAME);
    expect(csp).not.toBeNull();
    expect(csp).toContain("'nonce-");
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('Reporting-Endpoints')).toBe(
      'csp-endpoint="/api/csp-report"'
    );
    return csp as string;
  }

  it.each([
    ['apex request', 'http://localhost:3000/', 'localhost:3000', 200],
    [
      'tenant unauthenticated redirect',
      'http://acme.localhost:3000/dashboard',
      'acme.localhost:3000',
      307,
    ],
    ['/api request', 'http://localhost:3000/api/health', 'localhost:3000', 200],
  ])(
    'sets Report-Only CSP with a nonce on a %s',
    async (_label, url, host, expectedStatus) => {
      const req = new NextRequest(url, {
        headers: { host },
      });
      const res = await middleware(req);
      expect(res.status).toBe(expectedStatus);
      expectCspHeaders(res);
    }
  );

  // Regression (verification gate on PR #639): Next 16's renderer derives
  // the script nonce from the CSP header forwarded on the REQUEST
  // (content-security-policy[-report-only]) — it has no reader of x-nonce.
  // Middleware responses expose the forwarded request headers as
  // `x-middleware-request-<name>` entries, which is how they are asserted.
  describe('forwarded request CSP header (Next renderer nonce source)', () => {
    const forwardedRequestHeader = (res: Awaited<ReturnType<typeof middleware>>) =>
      res.headers.get(`x-middleware-request-${CSP_HEADER_NAME.toLowerCase()}`);

    it.each([
      ['apex request', 'http://localhost:3000/', 'localhost:3000'],
      ['/api request', 'http://localhost:3000/api/health', 'localhost:3000'],
    ])(
      'forwards the same CSP (same nonce) on the request for a %s',
      async (_label, url, host) => {
        const res = await middleware(new NextRequest(url, { headers: { host } }));
        const responseCsp = res.headers.get(CSP_HEADER_NAME);
        expect(responseCsp).not.toBeNull();
        expect(forwardedRequestHeader(res)).toBe(responseCsp);
      }
    );

    it('forwards the CSP request header on the tenant rewrite path', async () => {
      const testSecret = 'csp-regression-session-secret-minimum-32-chars';
      process.env.SESSION_SECRET = testSecret;
      const token = await signSessionToken(
        {
          userId: '11111111-1111-4111-a111-111111111111',
          email: 'regularuser@gmail.com',
          name: 'Acme User',
          subdomain: 'acme',
          role: 'user',
          status: 'active',
        },
        testSecret
      );
      const res = await middleware(
        new NextRequest('http://acme.localhost:3000/', {
          headers: { host: 'acme.localhost:3000', cookie: `fbup_session=${token}` },
        })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).not.toBeNull();
      expect(forwardedRequestHeader(res)).toBe(res.headers.get(CSP_HEADER_NAME));
    });

    it('overwrites a client-supplied CSP request header', async () => {
      const req = new NextRequest('http://localhost:3000/', {
        headers: { host: 'localhost:3000', [CSP_HEADER_NAME]: "default-src *" },
      });
      const res = await middleware(req);
      const forwarded = forwardedRequestHeader(res);
      expect(forwarded).toBe(res.headers.get(CSP_HEADER_NAME));
      expect(forwarded).not.toContain('default-src *');
    });
  });

  it('uses a different nonce for each request', async () => {
    const first = await middleware(
      new NextRequest('http://localhost:3000/', {
        headers: { host: 'localhost:3000' },
      })
    );
    const second = await middleware(
      new NextRequest('http://localhost:3000/', {
        headers: { host: 'localhost:3000' },
      })
    );
    const firstNonce = /'nonce-([^']+)'/.exec(first.headers.get(CSP_HEADER_NAME) ?? '')?.[1];
    const secondNonce = /'nonce-([^']+)'/.exec(second.headers.get(CSP_HEADER_NAME) ?? '')?.[1];
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });
});
