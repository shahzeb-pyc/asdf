import { describe, it, expect } from 'vitest';
import { resolveAdminLoginRedirect } from './auth-redirect';

/**
 * Admin post-login redirect (shell isolation): a /admin/* returnUrl
 * is honored, an old tenant admin location maps through the compat
 * table, and anything else becomes /admin/subscriptions. Pure
 * function contract for resolveAdminLoginRedirect.
 */
describe('resolveAdminLoginRedirect', () => {
  it.each([
    // [input, expected]
    ['/admin/subscriptions', '/admin/subscriptions'],
    ['/admin/sellers', '/admin/sellers'],
    ['/admin/sellers/abc-123', '/admin/sellers/abc-123'],
    ['/admin', '/admin'],
    // Old tenant admin locations map through the compat table.
    ['/tenant/e2e/billing', '/admin/subscriptions'],
    ['/tenant/e2e/billing?view=payments', '/admin/subscriptions'],
    ['/tenant/e2e/sellers', '/admin/sellers'],
    ['/tenant/e2e/sellers/abc-123', '/admin/sellers/abc-123'],
    // Tenant home and bare tenant-host forms map to the panel home.
    ['/tenant/e2e', '/admin/subscriptions'],
    ['/tenant/e2e/', '/admin/subscriptions'],
    ['/', '/admin/subscriptions'],
    ['/billing', '/admin/subscriptions'],
    ['/sellers', '/admin/sellers'],
    ['/sellers/abc-123', '/admin/sellers/abc-123'],
    // Full URLs: the origin is dropped, the path maps the same way.
    ['https://e2e.localhost:3100/billing', '/admin/subscriptions'],
    ['https://preview.vercel.app/tenant/e2e/sellers', '/admin/sellers'],
    ['https://preview.vercel.app/tenant/e2e/sellers/abc-123', '/admin/sellers/abc-123'],
    // User sections are NOT honored.
    ['/pages', '/admin/subscriptions'],
    ['/tenant/e2e/pages', '/admin/subscriptions'],
    ['https://e2e.localhost:3100/pages', '/admin/subscriptions'],
    // Missing / dangerous targets fall back to the panel home.
    [null, '/admin/subscriptions'],
    ['', '/admin/subscriptions'],
    ['javascript:alert(1)', '/admin/subscriptions'],
    ['//evil.example.com/admin/sellers', '/admin/subscriptions'],
  ])('maps %s to %s', (input, expected) => {
    expect(resolveAdminLoginRedirect(input)).toBe(expected);
  });
});
