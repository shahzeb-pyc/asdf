import { describe, it, expect } from 'vitest';
import {
  buildCentralAppUrl,
  buildPlatformAccountsUrl,
  buildSubdomainOAuthRedirectUri,
  buildSubdomainOAuthRedirectUriForCallback,
  buildTenantUrl,
  extractSubdomain,
  getPlatformAccountsPath,
  getTenantRewriteUrl,
} from '../src/domain/routing';

describe('Tenant Subdomain Routing Contracts', () => {
  describe('extractSubdomain', () => {
    it.each([
      ['fbuploadpro.com', 'fbuploadpro.com', 'apex domain without subdomain'],
      ['www.fbuploadpro.com', 'fbuploadpro.com', 'www prefix as apex domain'],
      ['localhost:3000', 'localhost', 'localhost:3000 as apex domain'],
      ['127.0.0.1:3000', 'localhost', 'IP address as apex domain'],
    ])('correctly identifies %s as %s', (host, rootDomain) => {
      const result = extractSubdomain(host, rootDomain);
      expect(result.isApex).toBe(true);
      expect(result.subdomain).toBeNull();
      expect(result.isReserved).toBe(false);
    });

    it('extracts valid tenant subdomain on production domain', () => {
      const result = extractSubdomain('acme.fbuploadpro.com', 'fbuploadpro.com');
      expect(result.isApex).toBe(false);
      expect(result.subdomain).toBe('acme');
      expect(result.isReserved).toBe(false);
    });

    it('extracts valid tenant subdomain on localhost with port', () => {
      const result = extractSubdomain('client-a.localhost:3000', 'localhost');
      expect(result.isApex).toBe(false);
      expect(result.subdomain).toBe('client-a');
      expect(result.isReserved).toBe(false);
    });

    it('identifies reserved subdomains', () => {
      const adminResult = extractSubdomain('admin.fbuploadpro.com', 'fbuploadpro.com');
      expect(adminResult.isApex).toBe(false);
      expect(adminResult.subdomain).toBe('admin');
      expect(adminResult.isReserved).toBe(true);

      const apiResult = extractSubdomain('api.localhost:3000', 'localhost');
      expect(apiResult.isApex).toBe(false);
      expect(apiResult.subdomain).toBe('api');
      expect(apiResult.isReserved).toBe(true);
    });

    it('normalizes uppercase host headers to lowercase', () => {
      const result = extractSubdomain('ACME-CORP.localhost:3000', 'localhost');
      expect(result.subdomain).toBe('acme-corp');
    });

    it('handles empty or missing host header gracefully', () => {
      const result = extractSubdomain(null, 'fbuploadpro.com');
      expect(result.isApex).toBe(true);
      expect(result.subdomain).toBeNull();
    });
  });

  describe('getTenantRewriteUrl', () => {
    it('generates internal rewrite URL for root tenant path', () => {
      const rewrite = getTenantRewriteUrl('acme', '/', 'http://acme.localhost:3000');
      expect(rewrite.pathname).toBe('/tenant/acme');
    });

    it('generates internal rewrite URL preserving nested subpaths', () => {
      const rewrite = getTenantRewriteUrl('acme', '/dashboard/settings', 'http://acme.localhost:3000/dashboard/settings');
      expect(rewrite.pathname).toBe('/tenant/acme/dashboard/settings');
    });

    it('preserves query search parameters during rewrite', () => {
      const rewrite = getTenantRewriteUrl('acme', '/dashboard', 'http://acme.localhost:3000/dashboard?tab=analytics');
      expect(rewrite.pathname).toBe('/tenant/acme/dashboard');
      expect(rewrite.searchParams.get('tab')).toBe('analytics');
    });
  });

  describe('buildTenantUrl', () => {
    it('constructs canonical https://{subdomain}.{rootDomain}{pathname} when given a production gateway URL and rootDomain', () => {
      const url = buildTenantUrl(
        'acme',
        '/accounts',
        'https://app.vinsmokemedia.online/api/auth/facebook/callback?code=123&state=abc',
        'vinsmokemedia.online'
      );
      expect(url.toString()).toBe('https://acme.vinsmokemedia.online/accounts');
    });

    it('normalizes pathname without leading slash on production domain', () => {
      const url = buildTenantUrl(
        'acme',
        'accounts',
        'https://app.vinsmokemedia.online/api/auth/facebook/callback',
        'vinsmokemedia.online'
      );
      expect(url.toString()).toBe('https://acme.vinsmokemedia.online/accounts');
    });

    it('falls back to /tenant/{subdomain}{pathname} on localhost, 127.0.0.1, or .vercel.app', () => {
      const localUrl = buildTenantUrl(
        'acme',
        '/accounts',
        'http://localhost:3000/api/auth/facebook/callback',
        'vinsmokemedia.online'
      );
      expect(localUrl.toString()).toBe('http://localhost:3000/tenant/acme/accounts');

      const ipUrl = buildTenantUrl(
        'acme',
        '/accounts',
        'http://127.0.0.1:3000/api/auth/facebook/callback',
        'vinsmokemedia.online'
      );
      expect(ipUrl.toString()).toBe('http://127.0.0.1:3000/tenant/acme/accounts');

      const previewUrl = buildTenantUrl(
        'acme',
        '/accounts',
        'https://fbuploadpro-git-feat-acme.vercel.app/api/auth/facebook/callback',
        'vinsmokemedia.online'
      );
      expect(previewUrl.toString()).toBe(
        'https://fbuploadpro-git-feat-acme.vercel.app/tenant/acme/accounts'
      );
    });

    it('falls back to /tenant/{subdomain}{pathname} when rootDomain is absent or localhost', () => {
      const noRootUrl = buildTenantUrl(
        'acme',
        '/accounts',
        'https://app.vinsmokemedia.online/api/auth/facebook/callback',
        ''
      );
      expect(noRootUrl.toString()).toBe(
        'https://app.vinsmokemedia.online/tenant/acme/accounts'
      );

      const localRootUrl = buildTenantUrl(
        'acme',
        '/accounts',
        'https://app.vinsmokemedia.online/api/auth/facebook/callback',
        'localhost:3000'
      );
      expect(localRootUrl.toString()).toBe(
        'https://app.vinsmokemedia.online/tenant/acme/accounts'
      );
    });
  });

  describe('buildCentralAppUrl', () => {
    it('constructs canonical absolute URL to app.{rootDomain}/login?logout=success on production domain', () => {
      const url = buildCentralAppUrl(
        '/login?logout=success',
        'https://acme.fbuploadpro.com/api/auth/logout',
        'fbuploadpro.com'
      );
      expect(url.toString()).toBe('https://app.fbuploadpro.com/login?logout=success');
    });

    it('constructs canonical absolute URL to app.{rootDomain}/login?logout=success on demo domain', () => {
      const url = buildCentralAppUrl(
        '/login?logout=success',
        'https://client1.vinsmokemedia.online/api/auth/logout',
        'vinsmokemedia.online'
      );
      expect(url.toString()).toBe('https://app.vinsmokemedia.online/login?logout=success');
    });

    it('constructs absolute URL to app.localhost:3000/login?logout=success in local development', () => {
      const url = buildCentralAppUrl(
        '/login?logout=success',
        'http://tenant.localhost:3000/api/auth/logout',
        'localhost:3000'
      );
      expect(url.toString()).toBe('http://app.localhost:3000/login?logout=success');
    });

    it('preserves preview deployment hostname on .vercel.app environments', () => {
      const url = buildCentralAppUrl(
        '/login?logout=success',
        'https://preview-deploy-123.vercel.app/api/auth/logout',
        'fbuploadpro.com'
      );
      expect(url.toString()).toBe('https://preview-deploy-123.vercel.app/login?logout=success');
    });

    it('defaults to https://app.fbuploadpro.com/login?logout=success when parameters are omitted', () => {
      const url = buildCentralAppUrl();
      expect(url.toString()).toBe('https://app.fbuploadpro.com/login?logout=success');
    });

    it('handles custom pathnames and query parameters', () => {
      const url = buildCentralAppUrl('/login', undefined, 'fbuploadpro.com');
      expect(url.toString()).toBe('https://app.fbuploadpro.com/login');
    });

    it('accepts URL instances as requestUrl and normalizes pathname', () => {
      const inputUrl = new URL('https://acme.fbuploadpro.com/some/path');
      const url = buildCentralAppUrl('login?logout=success', inputUrl, 'fbuploadpro.com');
      expect(url.toString()).toBe('https://app.fbuploadpro.com/login?logout=success');
    });

    it('gracefully falls back when requestUrl is an invalid string', () => {
      const url = buildCentralAppUrl('/login?logout=success', 'not-a-valid-url', 'fbuploadpro.com');
      expect(url.toString()).toBe('https://app.fbuploadpro.com/login?logout=success');
    });

    it('handles localhost rootDomain without port', () => {
      const url = buildCentralAppUrl('/login?logout=success', undefined, 'localhost');
      expect(url.toString()).toBe('http://app.localhost/login?logout=success');
    });

    it('adapts cleanRoot to localhost when requestUrl is local and rootDomain is omitted (Spec 056)', () => {
      const url = buildCentralAppUrl('/login?logout=success', 'http://localhost:3000/tenant/acme');
      expect(url.toString()).toBe('http://app.localhost:3000/login?logout=success');
      expect(url.toString()).not.toContain('fbuploadpro.com:3000');
    });

    it('adapts cleanRoot to localhost when requestUrl has .localhost subdomain and rootDomain is omitted (Spec 056)', () => {
      const url = buildCentralAppUrl('/login?logout=success', 'http://tenant.localhost:3000/api/auth/logout');
      expect(url.toString()).toBe('http://app.localhost:3000/login?logout=success');
      expect(url.toString()).not.toContain('fbuploadpro.com:3000');
    });
  });

  describe('buildSubdomainOAuthRedirectUri', () => {
    it('constructs https subdomain redirect URI on custom production domain', () => {
      const redirectUri = buildSubdomainOAuthRedirectUri(
        'shahzebpycozgy',
        'https://shahzebpycozgy.vinsmokemedia.online/api/auth/facebook',
        'vinsmokemedia.online'
      );
      expect(redirectUri).toBe(
        'https://shahzebpycozgy.vinsmokemedia.online/api/auth/facebook/callback'
      );
    });

    it('falls back to appUrlFallback when rootDomain is localhost', () => {
      const redirectUri = buildSubdomainOAuthRedirectUri(
        'acme',
        'http://localhost:3000/api/auth/facebook',
        'localhost:3000',
        'http://localhost:3000'
      );
      expect(redirectUri).toBe('http://localhost:3000/api/auth/facebook/callback');
    });

    it('falls back to requestUrl origin when rootDomain is missing', () => {
      const redirectUri = buildSubdomainOAuthRedirectUri(
        'acme',
        'http://localhost:3000/api/auth/facebook',
        undefined,
        undefined
      );
      expect(redirectUri).toBe('http://localhost:3000/api/auth/facebook/callback');
    });

    it('does not double-append the callback path when the fallback is already a full redirect URI (N6)', () => {
      const redirectUri = buildSubdomainOAuthRedirectUri(
        'acme',
        'http://localhost:3000/api/auth/facebook',
        'localhost:3000',
        'http://localhost:3000/api/auth/facebook/callback'
      );
      expect(redirectUri).toBe('http://localhost:3000/api/auth/facebook/callback');
    });
  });

  describe('buildSubdomainOAuthRedirectUriForCallback', () => {
    it('builds the Instagram callback URI on a custom production domain', () => {
      const redirectUri = buildSubdomainOAuthRedirectUriForCallback(
        'acme',
        '/api/auth/instagram/callback',
        'https://acme.vinsmokemedia.online/api/auth/instagram',
        'vinsmokemedia.online'
      );
      expect(redirectUri).toBe(
        'https://acme.vinsmokemedia.online/api/auth/instagram/callback'
      );
    });

    it('falls back to appUrlFallback on localhost', () => {
      const redirectUri = buildSubdomainOAuthRedirectUriForCallback(
        'acme',
        '/api/auth/instagram/callback',
        'http://localhost:3000/api/auth/instagram',
        'localhost:3000',
        'http://localhost:3000'
      );
      expect(redirectUri).toBe('http://localhost:3000/api/auth/instagram/callback');
    });
  });

  describe('getPlatformAccountsPath', () => {
    it.each([
      ['facebook', '/accounts'],
      ['instagram', '/instagram/accounts'],
      ['threads', '/threads/accounts'],
      ['tiktok', '/tiktok/accounts'],
      ['x', '/x/accounts'],
      ['youtube', '/youtube/accounts'],
      ['myspace', '/accounts'],
      ['', '/accounts'],
    ])('maps %s to %s', (platform, expected) => {
      expect(getPlatformAccountsPath(platform)).toBe(expected);
    });
  });

  describe('buildPlatformAccountsUrl', () => {
    it('builds the Instagram tenant accounts URL on localhost', () => {
      const url = buildPlatformAccountsUrl(
        'acme',
        'instagram',
        'http://localhost:3000/api/connect/instagram'
      );
      expect(url.toString()).toBe('http://localhost:3000/tenant/acme/instagram/accounts');
    });

    it('keeps the Facebook tenant accounts URL unchanged', () => {
      const url = buildPlatformAccountsUrl(
        'acme',
        'facebook',
        'http://localhost:3000/api/connect/facebook'
      );
      expect(url.toString()).toBe('http://localhost:3000/tenant/acme/accounts');
    });

    it('builds the workspace-subdomain host URL in production', () => {
      const url = buildPlatformAccountsUrl(
        'acme',
        'threads',
        'https://acme.fbuploadpro.com/api/connect/threads',
        'fbuploadpro.com'
      );
      expect(url.toString()).toBe('https://acme.fbuploadpro.com/threads/accounts');
    });
  });
});


