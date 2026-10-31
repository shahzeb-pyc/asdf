/**
 * Billing at phone widths (360–390px): no horizontal overflow, controls
 * inside the viewport, and the new billing work behaving on a real
 * phone-width page — pending banner + disabled checkout, reduced
 * platform list, inclusions, summary stacking, and admin approvals.
 *
 * The mobile-* Playwright projects only match mobile-layout.spec.ts,
 * so this spec runs on the desktop project with the viewport set
 * explicitly per test: CSS media queries respond to viewport size,
 * so the phone layout is genuinely exercised.
 *
 * Data comes from page.route fixtures registered AFTER
 * installApiFixtures (Playwright matches routes in reverse
 * registration order, so the billing fixtures win over the catch-all).
 * User views use a minted 'user' cookie — the default fixture cookie
 * is an admin cookie, which renders AdminApprovalsView instead.
 */

import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import {
  expectNoDocumentOverflow,
  expectWithinViewport,
} from './fixtures/mobile';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

function freeEntitlement() {
  return {
    plan: 'free',
    active: false,
    counts: { ...ZERO_COUNTS },
    usage: { ...ZERO_COUNTS },
    periodEndsAt: null,
    periodStartsAt: null,
    canPost: false,
    readOnly: true,
    reason: 'Your plan is Free, which covers the Prompt Library only.',
    // Required by EntitlementResponseSchema since PR #75: never paid.
    hasPriorPeriod: false,
  };
}

function paidEntitlement() {
  return {
    plan: 'paid',
    active: true,
    counts: { facebook: 2, instagram: 1, threads: 1, x: 1, tiktok: 1, youtube: 1 },
    usage: { ...ZERO_COUNTS },
    periodEndsAt: '2026-11-30T00:00:00.000Z',
    periodStartsAt: '2026-10-31T00:00:00.000Z',
    canPost: true,
    readOnly: false,
    reason: null,
    // Required by EntitlementResponseSchema since PR #75: holds a period.
    hasPriorPeriod: true,
  };
}

function paymentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    method: 'bank',
    bankMethod: 'easypaisa',
    status: 'pending',
    counts: { ...ZERO_COUNTS, facebook: 1 },
    amountPkr: 70,
    isUpgrade: false,
    screenshotStorageKey: 'billing-screenshots/user-1/shot.png',
    nowpaymentsPaymentId: null,
    nowpaymentsPayAddress: null,
    nowpaymentsPayAmount: null,
    nowpaymentsNetwork: null,
    createdAt: '2026-10-31T12:00:00.000Z',
    approvedAt: null,
    ...overrides,
  };
}

async function useUserSession(context: import('@playwright/test').BrowserContext) {
  const userCookie = { ...SESSION_COOKIE, value: mintSessionToken('user') };
  await context.addCookies([
    userCookie,
    { ...userCookie, domain: `${TENANT.subdomain}.localhost` },
  ]);
}

async function installBillingFixture(
  page: Page,
  status: { entitlement: unknown; payments: unknown[] }
) {
  await page.route(`**/api/tenant/${TENANT.subdomain}/billing`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) })
  );
}

async function gotoBilling(page: Page, view: string) {
  await page.goto(`/tenant/${TENANT.subdomain}/billing?view=${view}`);
}

test.describe('billing at phone widths', () => {
  for (const width of [360, 390]) {
    test(`Purchase fits ${width}px: pending banner, disabled checkout, inclusions, summary below chooser`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await useUserSession(context);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await installBillingFixture(page, {
        entitlement: freeEntitlement(),
        payments: [paymentItem()],
      });
      await gotoBilling(page, 'purchase');

      await expect(page.getByText('Payment in progress')).toBeVisible();
      // Exact match: the pending message itself contains the same
      // words as a substring ("payment waiting for approval").
      await expect(page.getByText('Waiting for approval', { exact: true })).toBeVisible();
      const continueBtn = page.getByRole('button', { name: 'Continue to checkout' });
      await expect(continueBtn).toBeDisabled();
      await expect(page.getByText('Included with your plan')).toBeVisible();
      await expect(
        page.getByText('5 GB of Media Library storage per page or account')
      ).toBeVisible();
      await expect(page.getByText('Creator Finder included free')).toBeVisible();
      await expect(
        page.getByText('Unlimited posts — no cap on the number of posts')
      ).toBeVisible();
      // Reduced platform list: no X/TikTok/YouTube steppers in Purchase.
      await expect(page.getByLabel('Increase X')).toHaveCount(0);
      await expect(page.getByLabel('Increase TikTok')).toHaveCount(0);
      await expect(page.getByLabel('Increase YouTube')).toHaveCount(0);

      // Summary stacks BELOW the chooser on phones: the summary
      // heading must start below the bottom of the stepper button.
      const stepperBox = await page.getByLabel('Increase Facebook').boundingBox();
      const summaryBox = await page.getByText('Order summary').boundingBox();
      expect(stepperBox).not.toBeNull();
      expect(summaryBox).not.toBeNull();
      expect(summaryBox!.y).toBeGreaterThan(stepperBox!.y + stepperBox!.height);

      await expectNoDocumentOverflow(page);
      await expectWithinViewport(continueBtn, page);
    });
  }

  test('Purchase checkout reaches confirmation at 360px', async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 844 });
    await useUserSession(context);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await installBillingFixture(page, {
      entitlement: freeEntitlement(),
      payments: [],
    });
    await page.route(`**/api/tenant/${TENANT.subdomain}/billing/payments`, (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(paymentItem()),
      })
    );
    await gotoBilling(page, 'purchase');

    await page.getByLabel('Increase Facebook').click();
    await page.getByRole('button', { name: 'Continue to checkout' }).click();
    // Radio, not bare text: the checkout description ("Manual payments
    // or crypto.") shares the same words.
    await expect(
      page.getByRole('radio', { name: 'Pay with a manual payment' })
    ).toBeVisible();
    await page.getByLabel('Pay with Binance').click();
    // The ID appears twice (method radio label + details panel):
    // assert the details-panel value and its copy button.
    await expect(page.getByText('983001576').nth(1)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Binance ID' })).toBeVisible();
    await page.setInputFiles('#billing-screenshot', {
      name: 'proof.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    await page.getByRole('button', { name: 'Submit payment for approval' }).click();
    await expect(page.getByText('Payment submitted')).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('My Plan and Payments history fit 360px', async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 844 });
    await useUserSession(context);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await installBillingFixture(page, {
      entitlement: paidEntitlement(),
      payments: [
        paymentItem({ status: 'approved', approvedAt: '2026-10-31T13:00:00.000Z' }),
        paymentItem({
          id: '22222222-2222-4222-a222-222222222222',
          method: 'nowpayments',
          bankMethod: null,
          status: 'paid',
          nowpaymentsPayAddress: 'TXYZ1234567890abcdefghijklmnopqrstuv',
          nowpaymentsNetwork: 'trc20',
        }),
      ],
    });

    await gotoBilling(page, 'my-plan');
    await expect(page.getByText('Pages and accounts by platform')).toBeVisible();
    await expectNoDocumentOverflow(page);

    await gotoBilling(page, 'payments');
    // Both fixture rows cost 70 PKR: assert each distinct row line.
    await expect(page.getByText('70 PKR · Easypaisa')).toBeVisible();
    await expect(page.getByText('70 PKR · Crypto · USDT (TRC20)')).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('Admin approvals fit 360px and Approve shows its notice', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 360, height: 844 });
    // Default fixture cookie is admin: the billing route renders the
    // approvals view for it.
    await context.addCookies([
      SESSION_COOKIE,
      { ...SESSION_COOKIE, domain: `${TENANT.subdomain}.localhost` },
    ]);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await page.route(`**/api/tenant/${TENANT.subdomain}/billing/admin/payments`, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            payments: [
              {
                ...paymentItem({ bankMethod: 'binance' }),
                userId: TENANT.userId,
                userEmail: TENANT.email,
              },
            ],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    });
    await gotoBilling(page, 'my-plan');

    await expect(page.getByText('Subscriptions approval')).toBeVisible();
    await expect(page.getByText('Binance')).toBeVisible();
    const approveBtn = page.getByRole('button', { name: 'Approve payment' });
    await expect(approveBtn).toBeVisible();
    await expectWithinViewport(approveBtn, page);
    await approveBtn.click();
    await expect(
      page.getByText('Approved. The plan starts now and runs for 30 days.')
    ).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
});
