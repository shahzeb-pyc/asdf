import { describe, it, expect } from 'vitest';
import { redirectAdminHomeToPanel } from './auth-redirect';

/**
 * Admin landing: a Home-bound post-login redirect becomes the admin
 * panel (Billing → approvals view); anything deeper passes through
 * unchanged. Pure-function contract for redirectAdminHomeToPanel.
 */
describe('redirectAdminHomeToPanel', () => {
  it.each([
    // [input, subdomain, expected]
    ['https://e2e.localhost:3100/', 'e2e', 'https://e2e.localhost:3100/billing'],
    [
      'https://e2e.localhost:3100/?notice=tenant_redirect#top',
      'e2e',
      'https://e2e.localhost:3100/billing',
    ],
    [
      'https://preview.vercel.app/tenant/e2e',
      'e2e',
      'https://preview.vercel.app/tenant/e2e/billing',
    ],
    [
      'https://preview.vercel.app/tenant/e2e/',
      'e2e',
      'https://preview.vercel.app/tenant/e2e/billing',
    ],
    ['/tenant/e2e', 'e2e', '/tenant/e2e/billing'],
    ['/tenant/e2e/', 'e2e', '/tenant/e2e/billing'],
    ['/', 'e2e', '/tenant/e2e/billing'],
    ['https://x.localhost/tenant/E2E', 'e2e', 'https://x.localhost/tenant/e2e/billing'],
  ])('rewrites Home %s to %s', (input, subdomain, expected) => {
    expect(redirectAdminHomeToPanel(input, subdomain)).toBe(expected);
  });

  it.each([
    '/tenant/e2e/sellers',
    '/tenant/e2e/billing',
    '/pages',
    'https://e2e.localhost:3100/tenant/e2e/billing',
    'https://e2e.localhost:3100/tenant/e2e/sellers',
    'https://e2e.localhost:3100/pages',
    // Another workspace's Home is not this admin's landing Home:
    // it passes through (middleware routes it to that workspace's
    // panel if the admin opens it directly).
    '/tenant/other',
    'https://x.localhost/tenant/other',
  ])('leaves deeper targets unchanged: %s', (input) => {
    expect(redirectAdminHomeToPanel(input, 'e2e')).toBe(input);
  });
});
