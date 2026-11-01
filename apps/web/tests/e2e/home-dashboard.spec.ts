/**
 * Tenant Home at phone widths (360px): the hero, the fallback states,
 * and no horizontal overflow — on a real phone-width page.
 *
 * SCOPE (honest): the e2e webServer runs with dummy env, so the home
 * page's server-side Supabase load cannot succeed here. What this spec
 * genuinely covers is the fallback render a signed-in user gets under
 * those conditions — hero with the subdomain fallback, the visible
 * error card for a regular user, the admin-panel card for an admin —
 * plus the no-overflow contract at 360px. The paid/free/expired
 * dashboard sections are covered by the vitest render contract in
 * tests/api/dashboard.test.ts (mocked data) instead; they need a real
 * database and cannot run in this fixture environment.
 *
 * Follows the billing-mobile pattern: the desktop project with the
 * viewport set explicitly per test, so CSS media queries genuinely
 * exercise the phone layout.
 */
import { test, expect } from '@playwright/test';

import { expectNoDocumentOverflow } from './fixtures/mobile';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

test.describe('Tenant Home at 360px', () => {
  test.use({ viewport: { width: 360, height: 720 } });

  test('signed-in user sees the hero and the load-error card, no overflow', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { ...SESSION_COOKIE, value: mintSessionToken('user') },
    ]);
    await page.goto(`/tenant/${TENANT.subdomain}`);

    await expect(
      page.getByTestId('home-hero').getByRole('heading', { name: 'Welcome, e2e' })
    ).toBeVisible();
    await expect(page.getByTestId('old-users-notice-banner')).toBeVisible();
    await expect(page.getByTestId('old-users-notice-banner')).toContainText(
      'Old fbuploadpro users'
    );
    await expect(page.getByTestId('home-error')).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('admin sees the admin-panel card, no overflow', async ({ page, context }) => {
    await context.addCookies([
      { ...SESSION_COOKIE, value: mintSessionToken('admin') },
    ]);
    await page.goto(`/tenant/${TENANT.subdomain}`);

    await expect(
      page.getByTestId('home-hero').getByRole('heading', { name: 'Welcome, e2e' })
    ).toBeVisible();
    await expect(page.getByTestId('admin-panel-card')).toBeVisible();
    await expect(page.getByTestId('admin-panel-card').getByRole('link')).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
});
