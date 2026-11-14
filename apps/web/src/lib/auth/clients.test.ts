import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCookieDomain } from './clients';

// Login-cookie-loop fix: getCookieDomain must never silently fall back
// to a host-only cookie when a production custom-domain login cannot
// cover tenant subdomains — that silent cookie is what fed the
// login ↔ home loop. Localhost and *.vercel.app flows keep the old
// host-only behaviour (tenant paths live on the same host there).
describe('getCookieDomain (login-cookie-loop fix)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'fbuploadpro.com');
    vi.stubEnv('COOKIE_DOMAIN', '.fbuploadpro.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns the shared domain for a production custom-domain host', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getCookieDomain('app.fbuploadpro.com')).toBe('.fbuploadpro.com');
    expect(getCookieDomain('acme.fbuploadpro.com')).toBe('.fbuploadpro.com');
  });

  it('returns the root-derived domain when COOKIE_DOMAIN is unset in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_DOMAIN', '');
    expect(getCookieDomain('app.fbuploadpro.com')).toBe('.fbuploadpro.com');
  });

  it('throws (logged) in production when the root domain is missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', '');
    // No COOKIE_DOMAIN override either, or the override would (correctly)
    // cover the host on its own and there would be nothing to fail on.
    vi.stubEnv('COOKIE_DOMAIN', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => getCookieDomain('app.fbuploadpro.com')).toThrow(
      /cannot cover tenant subdomains/
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('throws (logged) in production when the root domain does not match the host', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'example.com');
    // Same note as above: a correct COOKIE_DOMAIN would cover the host
    // regardless of the root value, so clear it to test the root path.
    vi.stubEnv('COOKIE_DOMAIN', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => getCookieDomain('app.fbuploadpro.com')).toThrow(
      /cannot cover tenant subdomains/
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('throws (logged) in production when COOKIE_DOMAIN does not match the host', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_DOMAIN', '.example.com');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => getCookieDomain('app.fbuploadpro.com')).toThrow(
      /cannot cover tenant subdomains/
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('keeps the silent host-only fallback outside production', () => {
    // NODE_ENV is 'test' here: local/preview-style callers must not throw.
    expect(getCookieDomain('app.fbuploadpro.com')).toBe('.fbuploadpro.com');
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'example.com');
    expect(getCookieDomain('app.fbuploadpro.com')).toBeUndefined();
  });

  it('keeps host-only cookies for localhost and vercel hosts even in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getCookieDomain('localhost:3000')).toBeUndefined();
    expect(getCookieDomain('fbuploadpro-git-branch-velocta.vercel.app')).toBeUndefined();
  });
});

// Spec 191: the cookie domain follows the request's brand, not the
// configured root — and a COOKIE_DOMAIN set for our brand must never
// apply to the white-label brand.
describe('getCookieDomain white-label brand (spec 191)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'fbuploadpro.com');
    vi.stubEnv('COOKIE_DOMAIN', '.fbuploadpro.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns .app.nextrisehq.com for white-label hosts, ignoring COOKIE_DOMAIN', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getCookieDomain('app.nextrisehq.com')).toBe('.app.nextrisehq.com');
    expect(getCookieDomain('student1.app.nextrisehq.com')).toBe('.app.nextrisehq.com');
  });

  it('keeps our brand on .fbuploadpro.com when both brands are configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getCookieDomain('app.fbuploadpro.com')).toBe('.fbuploadpro.com');
    expect(getCookieDomain('app.nextrisehq.com')).toBe('.app.nextrisehq.com');
  });

  it('does not throw for a white-label host whose root does not match', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'example.com');
    // The white-label root does not come from the configured root at
    // all, so a mismatched configured root must not fail the login.
    expect(getCookieDomain('app.nextrisehq.com')).toBe('.app.nextrisehq.com');
  });
});
