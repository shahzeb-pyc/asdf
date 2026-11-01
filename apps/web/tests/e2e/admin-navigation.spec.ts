/**
 * Admin navigation must not bounce to Home.
 *
 * Regression net for the reported bug: an admin who logs in lands on
 * Home (expected), but selecting "Subscriptions approval" or "Sellers"
 * in the admin sidebar must land on that section and STAY there — never
 * bounce back to Home. Non-admin sessions must still be kept out of
 * both sections exactly as today (sellers redirects home; billing
 * renders the user Billing view, never the approvals view).
 *
 * Runs at 360px: the admin sidebar is a drawer at phone widths, so the
 * test opens the drawer and taps the leaves, the same path a phone
 * user takes. API calls are fixture-intercepted at the browser
 * boundary (the production API routes never run); what runs for real
 * is routing, middleware session verification, both layouts, and the
 * client components. Session cookies are genuine signed tokens.
 */

import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { expectNoDocumentOverflow } from './fixtures/mobile';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

const SUB = TENANT.subdomain;

async function useSession(
  context: import('@playwright/test').BrowserContext,
  role: 'admin' | 'user'
) {
  const value = mintSessionToken(role);
  await context.addCookies([
    { ...SESSION_COOKIE, value },
    { ...SESSION_COOKIE, value, domain: `${SUB}.localhost` },
  ]);
}

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Toggle Sidebar' }).first().tap();
}

async function installAdminFixtures(page: Page) {
  await page.route(`**/api/tenant/${SUB}/billing/admin/payments`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ payments: [] }),
    });
  });
  await page.route(`**/api/tenant/${SUB}/sellers/payout-requests*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [], total: 0 }),
    })
  );
  await page.route(`**/api/tenant/${SUB}/sellers*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sellers: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Ali',
            email: 'ali@example.com',
            currentCode: 'ALI20',
            rate: 20,
            scope: 'every',
            status: 'active',
            signups: 2,
            purchasers: 1,
            payablePkr: 1500,
            paidPkr: 2000,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        total: 1,
      }),
    })
  );
}

test.describe('admin navigation stays on admin sections (360px)', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  test('admin sidebar clicks land on approvals and sellers, not home', async ({
    page,
    context,
  }) => {
    await useSession(context, 'admin');
    await installApiFixtures(page, createFixtureState());
    await installAdminFixtures(page);
    await page.goto(`/tenant/${SUB}`);

    // Admin home: the admin-panel card proves the admin session.
    await expect(page.getByTestId('admin-panel-card')).toBeVisible();

    // Subscriptions approval: sidebar tap lands on billing + approvals.
    await openDrawer(page);
    await page.getByRole('link', { name: 'Subscriptions approval' }).tap();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/billing$`));
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();
    await expect(page.getByTestId('admin-panel-card')).toHaveCount(0);

    // Sellers: sidebar tap lands on the admin sellers list.
    await openDrawer(page);
    await page.getByRole('link', { name: 'Sellers' }).tap();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/sellers$`));
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();

    await expectNoDocumentOverflow(page);
  });

  test('admin sections stay put on refresh', async ({ page, context }) => {
    await useSession(context, 'admin');
    await installApiFixtures(page, createFixtureState());
    await installAdminFixtures(page);

    await page.goto(`/tenant/${SUB}/sellers`);
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/sellers$`));
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/sellers$`));
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();

    await page.goto(`/tenant/${SUB}/billing`);
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/billing$`));
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();
  });

  test('non-admin sessions are still kept out of admin sections', async ({
    page,
    context,
  }) => {
    await useSession(context, 'user');
    await installApiFixtures(page, createFixtureState());

    // Sellers redirects a non-admin home, exactly as today.
    await page.goto(`/tenant/${SUB}/sellers`);
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/?$`));
    await expect(page.getByText('Resellers who earn commission')).toHaveCount(0);

    // Billing renders the user view for a non-admin, never approvals.
    await page.goto(`/tenant/${SUB}/billing`);
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/billing`));
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toHaveCount(0);
  });
});

test.describe('admin navigation at desktop width', () => {
  test('admin sidebar clicks land on approvals and sellers, not home', async ({
    page,
    context,
  }) => {
    await useSession(context, 'admin');
    await installApiFixtures(page, createFixtureState());
    await installAdminFixtures(page);
    await page.goto(`/tenant/${SUB}`);

    await expect(page.getByTestId('admin-panel-card')).toBeVisible();

    // Desktop: the sidebar is visible, no drawer to open.
    await page.getByRole('link', { name: 'Subscriptions approval' }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/billing$`));
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();

    await page.getByRole('link', { name: 'Sellers' }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/sellers$`));
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();
  });

  test('non-admin sessions are still kept out of admin sections (desktop)', async ({
    page,
    context,
  }) => {
    await useSession(context, 'user');
    await installApiFixtures(page, createFixtureState());

    // Sellers redirects a non-admin home, exactly as today.
    await page.goto(`/tenant/${SUB}/sellers`);
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/?$`));
    await expect(page.getByText('Resellers who earn commission')).toHaveCount(0);

    // Billing renders the user view for a non-admin, never approvals.
    await page.goto(`/tenant/${SUB}/billing`);
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/billing`));
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toHaveCount(0);
  });
});
