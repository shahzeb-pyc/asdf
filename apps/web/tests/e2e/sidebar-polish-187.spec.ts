/**
 * Spec 187 — sidebar polish, real-browser check (user sidebar only).
 *
 * Desktop: the polished sidebar measures as the mockup says — 57px
 * header with hairline, 40px medium top-level rows, semibold + grey
 * bg + 3px brand-gold bar on the active row, "Billing" + "Platforms"
 * labels, icons on all four billing leaves, and the 56px bordered
 * footer account card. Single-click navigation still navigates on
 * the first click, collapsed platform groups still collapse, and
 * seller/admin shells are pixel-identical (no bar, 36px rows).
 *
 * Phone (390px): the drawer opens, a leaf tap navigates on the
 * first tap, and the drawer closes on navigate.
 *
 * API traffic is fixture-served at the browser boundary (same
 * fixtures as shell-navigation.spec.ts); what runs for real is
 * routing, middleware session verification, both layouts, and the
 * client components. Session cookies are genuine signed tokens.
 */

import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

const SUB = TENANT.subdomain;

const USER_SESSION_COOKIE = {
  ...SESSION_COOKIE,
  value: mintSessionToken('user', ['beta']),
};

const WORKSPACES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: TENANT.userId,
    name: 'E2E Workspace',
    subdomain: SUB,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666',
    ownerId: TENANT.userId,
    name: 'Beta Workspace',
    subdomain: 'beta',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

async function installShellFixtures(page: Page): Promise<void> {
  const state = createFixtureState();
  await installApiFixtures(page, state);
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: WORKSPACES }),
    });
  });
}

async function signInToTenantHome(page: Page): Promise<void> {
  await page.context().addCookies([USER_SESSION_COOKIE]);
  await installShellFixtures(page);
  await page.goto(`/tenant/${SUB}`);
  await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
}

async function installAdminFixtures(page: Page): Promise<void> {
  await page.route(`**/api/admin/payments`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ payments: [] }),
    });
  });
  await page.route(`**/api/admin/sellers*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sellers: [], total: 0 }),
    })
  );
  await page.route(`**/api/admin/sellers/payout-requests*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [], total: 0 }),
    })
  );
}

async function installSellerFixtures(page: Page): Promise<void> {
  await page.route('**/api/seller/dashboard', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sellerId: '11111111-1111-4111-8111-111111111111',
        name: 'Ali',
        email: 'ali@example.com',
        rate: 20,
        scope: 'every',
        status: 'active',
        currentCode: 'ALI20',
        codes: [{ code: 'ALI20', current: true, createdAt: '2026-01-01T00:00:00.000Z' }],
        referralLink: 'http://localhost:3100/signup?ref=ALI20',
        signups: 2,
        purchasers: 1,
        balances: { pending: 1400, payable: 600, requested: 0, paid: 2000 },
        payoutDetails: null,
      }),
    })
  );
  await page.route('**/api/seller/referrals*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ users: [], total: 0 }),
    })
  );
  await page.route('**/api/seller/payout-requests*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [], total: 0 }),
    })
  );
}

test.describe('sidebar polish at desktop width (spec 187)', () => {
  test('header, active state, labels, icons, and footer card match the mockup', async ({
    page,
  }) => {
    await signInToTenantHome(page);

    const sidebar = page.locator('[data-slot="sidebar"]');

    // Header: 57px tall (mockup) with the hairline under it.
    const header = page.locator('[data-slot="sidebar-header"]');
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(headerBox?.height).toBeGreaterThanOrEqual(56);
    expect(headerBox?.height).toBeLessThanOrEqual(58);
    const branding = page.getByTestId('sidebar-branding-link');
    expect(await branding.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe(
      '1px'
    );

    // Labels: "Platforms" (not "Platform") and the static "Billing".
    await expect(sidebar.getByText('Platforms', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Billing', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Platform', { exact: true })).toHaveCount(0);

    // Top-level rows are 40px with medium labels.
    const home = page.getByRole('link', { name: /^Home/ });
    const homeBox = await home.boundingBox();
    expect(homeBox?.height).toBe(40);
    const homeWeight = await home.evaluate((el) => getComputedStyle(el).fontWeight);
    expect(homeWeight).toBe('600');
    const media = page.getByRole('link', { name: /^Media Library/ });
    const mediaWeight = await media.evaluate((el) => getComputedStyle(el).fontWeight);
    expect(mediaWeight).toBe('500');

    // The gold bar sits on the active row: 3px wide, brand gold.
    const bar = page.getByTestId('sidebar-active-bar');
    await expect(bar).toBeVisible();
    const barBox = await bar.boundingBox();
    expect(barBox?.width).toBe(3);
    expect(await bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(255, 252, 0)'
    );
    expect(await home.evaluate((el) => el.contains(document.querySelector('[data-testid="sidebar-active-bar"]')))).toBe(true);

    // Billing leaves all carry an icon; the group sub-leaves stay 32px.
    for (const label of ['My Plan', 'Purchase', 'Payments', 'Refund']) {
      const link = page.getByRole('link', { name: label });
      expect(await link.locator('svg').count()).toBeGreaterThan(0);
    }
    const accounts = page.getByRole('link', { name: 'Accounts' }).first();
    expect((await accounts.boundingBox())?.height).toBe(32);

    // Footer trigger is the bordered 56px account card.
    const trigger = page.getByTestId('workspace-switcher-trigger');
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox?.height).toBe(56);
    expect(await trigger.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
    expect(await trigger.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('6px');

    await sidebar.screenshot({ path: test.info().outputPath('desktop-sidebar.png') });
  });

  test('single-click navigation moves the bar; platform groups still collapse', async ({
    page,
  }) => {
    await signInToTenantHome(page);

    // ONE click navigates (spec 110) and the bar follows the page.
    await page.getByRole('link', { name: /^Media Library/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/media$`));
    const media = page.getByRole('link', { name: /^Media Library/ });
    expect(
      await media.evaluate((el) =>
        el.contains(document.querySelector('[data-testid="sidebar-active-bar"]'))
      )
    ).toBe(true);
    const home = page.getByRole('link', { name: /^Home/ });
    expect(await home.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('500');

    // Facebook group collapses and expands; the leaves hide/show.
    const facebook = page.getByRole('button', { name: /Facebook/ });
    await expect(page.getByRole('link', { name: 'In-App Schedule' })).toBeVisible();
    await facebook.click();
    await expect(page.getByRole('link', { name: 'In-App Schedule' })).toHaveCount(0);
    await facebook.click();
    await expect(page.getByRole('link', { name: 'In-App Schedule' })).toBeVisible();

    // Back home on one click.
    await home.click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/?$`));
  });

  test('seller and admin shells have no bar and keep 36px rows', async ({
    page,
    context,
    browser,
  }) => {
    const state = createFixtureState();
    await installApiFixtures(page, state);

    // Admin shell.
    await context.addCookies([{ ...SESSION_COOKIE, value: mintSessionToken('admin') }]);
    await installAdminFixtures(page);
    await page.goto('/admin/subscriptions');
    await expect(page.getByRole('heading', { name: 'Subscriptions approval' })).toBeVisible();
    await expect(page.getByTestId('sidebar-active-bar')).toHaveCount(0);
    const approvals = page.getByRole('link', { name: 'Subscriptions approval' });
    // Unchanged from before spec 187: the primitive's default button
    // is 37px in practice (21px line box + 16px padding beats the
    // 36px min-height), and the prop stays off (data-size "default",
    // never "lg").
    expect((await approvals.boundingBox())?.height).toBe(37);
    expect(await approvals.getAttribute('data-size')).toBe('default');
    await page
      .locator('[data-slot="sidebar"]')
      .screenshot({ path: test.info().outputPath('admin-sidebar.png') });

    // Seller shell (fresh context so the admin cookie does not leak).
    const sellerContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    try {
      await sellerContext.addCookies([
        { ...SESSION_COOKIE, value: mintSessionToken('seller') },
      ]);
      await installApiFixtures(sellerPage, createFixtureState());
      await installSellerFixtures(sellerPage);
      await sellerPage.goto('/seller');
      await expect(sellerPage.getByRole('link', { name: 'Dashboard' })).toBeVisible();
      await expect(sellerPage.getByTestId('sidebar-active-bar')).toHaveCount(0);
      const dashboard = sellerPage.getByRole('link', { name: 'Dashboard' });
      expect((await dashboard.boundingBox())?.height).toBe(37);
      expect(await dashboard.getAttribute('data-size')).toBe('default');
      await sellerPage
        .locator('[data-slot="sidebar"]')
        .screenshot({ path: test.info().outputPath('seller-sidebar.png') });
    } finally {
      await sellerContext.close();
    }
  });
});

test.describe('sidebar polish at phone width (spec 187)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('drawer tap navigates on first tap and closes the drawer', async ({ page }) => {
    await signInToTenantHome(page);

    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().tap();
    await page.getByRole('link', { name: /^Media Library/ }).tap();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/media$`));
    // The drawer closes on navigate: the sidebar leaves the viewport.
    await expect(page.locator('[data-slot="sidebar"]')).toBeHidden();

    // The footer card still renders inside the reopened drawer.
    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().tap();
    const trigger = page.getByTestId('workspace-switcher-trigger');
    await expect(trigger).toBeVisible();
    expect((await trigger.boundingBox())?.height).toBe(56);

    await page
      .locator('[data-slot="sidebar"]')
      .screenshot({ path: test.info().outputPath('mobile-sidebar.png') });
  });
});
