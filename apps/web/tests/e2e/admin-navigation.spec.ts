/**
 * Admin navigation must not bounce to Home — and admins never land
 * on Home at all.
 *
 * Regression net for the reported bug, extended by the shell
 * isolation change: the admin section is now global (/admin/*),
 * separate from the tenant section. An admin opening Home
 * (directly, via the logo, or from a Home-bound post-login
 * navigation) is redirected to /admin/subscriptions instead, and
 * selecting "Subscriptions approval" or "Sellers" in the admin
 * sidebar must land on that section and STAY there — never bounce
 * back to Home. Old tenant admin URLs (bookmarks, deep links)
 * redirect to the equivalent new admin page. Non-admin sessions
 * must still be kept out of admin sections exactly as today
 * (users redirect home; billing renders the user Billing view,
 * never the approvals view).
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
  await page.route(`**/api/admin/payments`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ payments: [] }),
    });
  });
  await page.route(`**/api/admin/sellers/payout-requests*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [], total: 0 }),
    })
  );
  await page.route(`**/api/admin/sellers*`, (route) =>
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

  test('admin home redirects to the admin section; sidebar clicks land on sellers, not home', async ({
    page,
    context,
  }) => {
    await useSession(context, 'admin');
    await installApiFixtures(page, createFixtureState());
    await installAdminFixtures(page);
    await page.goto(`/tenant/${SUB}`);

    // Admin Home redirects to the admin section: subscriptions URL
    // + approvals heading, and the Home admin-panel card never renders.
    await expect(page).toHaveURL(/\/admin\/subscriptions$/);
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();
    await expect(page.getByTestId('admin-panel-card')).toHaveCount(0);

    // Sellers: sidebar tap lands on the admin sellers list.
    await openDrawer(page);
    await page.getByRole('link', { name: 'Sellers' }).tap();
    await expect(page).toHaveURL(/\/admin\/sellers$/);
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();

    await expectNoDocumentOverflow(page);
  });

  test('admin sections stay put on refresh', async ({ page, context }) => {
    await useSession(context, 'admin');
    await installApiFixtures(page, createFixtureState());
    await installAdminFixtures(page);

    await page.goto(`/admin/sellers`);
    await expect(page).toHaveURL(/\/admin\/sellers$/);
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/admin\/sellers$/);
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();

    await page.goto(`/admin/subscriptions`);
    await expect(page).toHaveURL(/\/admin\/subscriptions$/);
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();
  });

  test('old tenant admin URLs redirect to the equivalent admin page', async ({
    page,
    context,
  }) => {
    await useSession(context, 'admin');
    await installApiFixtures(page, createFixtureState());
    await installAdminFixtures(page);

    await page.goto(`/tenant/${SUB}/billing`);
    await expect(page).toHaveURL(/\/admin\/subscriptions$/);
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();

    await page.goto(`/tenant/${SUB}/sellers`);
    await expect(page).toHaveURL(/\/admin\/sellers$/);
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();
  });

  test('non-admin sessions are still kept out of admin sections', async ({
    page,
    context,
  }) => {
    await useSession(context, 'user');
    await installApiFixtures(page, createFixtureState());

    // A user on the admin section redirects to their workspace home.
    await page.goto(`/admin/subscriptions`);
    await expect(page.getByText('Resellers who earn commission')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toHaveCount(0);

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
  test('admin home redirects to the admin section; sidebar clicks land on sellers, not home', async ({
    page,
    context,
  }) => {
    await useSession(context, 'admin');
    await installApiFixtures(page, createFixtureState());
    await installAdminFixtures(page);
    await page.goto(`/tenant/${SUB}`);

    // Admin Home redirects to the admin section: subscriptions URL
    // + approvals heading, and the Home admin-panel card never renders.
    await expect(page).toHaveURL(/\/admin\/subscriptions$/);
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();
    await expect(page.getByTestId('admin-panel-card')).toHaveCount(0);

    // Desktop: the sidebar is visible, no drawer to open.
    await page.getByRole('link', { name: 'Sellers' }).click();
    await expect(page).toHaveURL(/\/admin\/sellers$/);
    await expect(page.getByText('Resellers who earn commission')).toBeVisible();
  });

  test('non-admin sessions are still kept out of admin sections (desktop)', async ({
    page,
    context,
  }) => {
    await useSession(context, 'user');
    await installApiFixtures(page, createFixtureState());

    // A user on the admin section redirects to their workspace home.
    await page.goto(`/admin/subscriptions`);
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toHaveCount(0);

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
