/**
 * Sellers at phone widths (390px): the seller dashboard and the
 * admin sellers list render inside the viewport with no horizontal
 * overflow, and the key controls behave (payout blocked below the
 * minimum, payout queue actions present).
 *
 * API calls are fixture-intercepted at the browser boundary (the
 * production API routes never run); what runs for real is routing,
 * middleware session verification, both layouts, and the client
 * components. The seller cookie is a genuine signed 'seller' token.
 */

import { test, expect, type Page } from '@playwright/test';
import { expectNoDocumentOverflow, expectWithinViewport } from './fixtures/mobile';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

async function useSellerSession(context: import('@playwright/test').BrowserContext) {
  await context.addCookies([{ ...SESSION_COOKIE, value: mintSessionToken('seller') }]);
}

async function useAdminSession(context: import('@playwright/test').BrowserContext) {
  await context.addCookies([{ ...SESSION_COOKIE, value: mintSessionToken('admin') }]);
}

function sellerDashboardFixture() {
  return {
    sellerId: 'seller-1',
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
  };
}

function sellerReferralsFixture() {
  return {
    users: [
      {
        id: 'buyer-1',
        name: 'Bilal',
        email: 'bilal@example.com',
        referralCode: 'ALI20',
        purchased: true,
        signedUpAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    total: 1,
  };
}

async function installSellerFixtures(page: Page) {
  await page.route('**/api/seller/dashboard', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sellerDashboardFixture()),
    })
  );
  await page.route('**/api/seller/referrals*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sellerReferralsFixture()),
    })
  );
  await page.route('**/api/seller/payout-requests', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [], total: 0 }),
    })
  );
}

function adminSellersFixture() {
  return {
    sellers: [
      {
        id: 'seller-1',
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
  };
}

function adminPayoutQueueFixture() {
  return {
    requests: [
      {
        id: 'req-1',
        sellerId: 'seller-1',
        sellerName: 'Ali',
        sellerEmail: 'ali@example.com',
        totalPkr: 1500,
        commissionCount: 2,
        status: 'pending',
        payoutMethod: 'easypaisa',
        payoutAccount: '03270000000',
        requestedAt: '2026-01-05T00:00:00.000Z',
        decidedAt: null,
      },
    ],
    total: 1,
  };
}

async function installAdminSellersFixtures(page: Page) {
  // Registered first so the queue fixture below (registered
  // later) wins for its path — Playwright matches routes in
  // reverse registration order.
  await page.route(`**/api/tenant/${TENANT.subdomain}/sellers*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(adminSellersFixture()),
    })
  );
  await page.route(`**/api/tenant/${TENANT.subdomain}/sellers/payout-requests`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(adminPayoutQueueFixture()),
    })
  );
}

test.describe('sellers at phone widths', () => {
  test('seller dashboard fits 390px and blocks payout below the minimum', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useSellerSession(context);
    await installSellerFixtures(page);
    await page.goto('/seller');

    await expect(page.getByText('Your referral link')).toBeVisible();
    await expect(page.getByLabel('Referral link')).toHaveValue(
      'http://localhost:3100/signup?ref=ALI20'
    );
    await expect(page.getByText('20% · Every purchase')).toBeVisible();
    await expect(page.getByText('Bilal')).toBeVisible();

    const payoutButton = page.getByRole('button', { name: 'Request payout' });
    await expect(payoutButton).toBeVisible();
    await expect(payoutButton).toBeDisabled();
    await expect(page.getByText(/PKR 400 more/)).toBeVisible();

    await expectWithinViewport(payoutButton, page);
    await expectNoDocumentOverflow(page);
  });

  test('admin sellers list fits 390px with the payout queue', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useAdminSession(context);
    await installAdminSellersFixtures(page);
    await page.goto(`/tenant/${TENANT.subdomain}/sellers`);

    await expect(page.getByText('Resellers who earn commission')).toBeVisible();
    await expect(page.getByText('ali@example.com')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create seller' })).toBeVisible();

    const markSent = page.getByRole('button', { name: 'Mark as sent' });
    await expect(markSent).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();

    await expectWithinViewport(markSent, page);
    await expectNoDocumentOverflow(page);
  });
});
