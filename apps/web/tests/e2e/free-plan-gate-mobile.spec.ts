/**
 * Free-plan gate at phone widths (390px), real browser (entitlement
 * rebuild, owner decision 2026-11-07):
 *
 * - A paid user opens a gated section and navigates between sections
 *   through the sidebar: the entitlement API is called exactly ONCE
 *   for the whole session — no re-check on navigation, no focus
 *   refetch, no dialog, no section unmount. That single fetch is the
 *   fix for the reload paid users reported.
 * - A free user on a gated section sees the hard-block dialogue with
 *   both exits inside the viewport and tappable; Back to Home lands
 *   on Home with the shell usable again.
 * - A free user never gets an automatic re-check: fast-forwarding
 *   the clock 65 seconds past the dialogue leaves the entitlement
 *   call count at one and shows no "Check again" button (the old
 *   30-second loop is deleted).
 * - An expired user browses a gated section like a paid user: no
 *   dialogue, section renders.
 *
 * Runs on the desktop project with the viewport set explicitly per
 * test (like billing-mobile.spec.ts): CSS media queries respond to
 * viewport size, so the phone layout is genuinely exercised.
 * Data comes from page.route fixtures registered AFTER
 * installApiFixtures (Playwright matches routes in reverse
 * registration order, so the billing fixtures win over the catch-all).
 * User views use a minted 'user' cookie.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import {
  expectNoDocumentOverflow,
  expectWithinViewport,
  expectMinTouchHeight,
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

type Plan = 'free' | 'paid' | 'expired';

function entitlement(plan: Plan) {
  const paid = plan === 'paid';
  return {
    plan,
    active: paid,
    counts: { ...ZERO_COUNTS, facebook: 10 },
    usage: { ...ZERO_COUNTS },
    periodEndsAt: paid ? '2026-12-07T00:00:00.000Z' : null,
    periodStartsAt: paid ? '2026-11-07T00:00:00.000Z' : null,
    canPost: paid,
    readOnly: !paid,
    reason:
      plan === 'free'
        ? 'Your plan is Free, which covers the Prompt Library only.'
        : plan === 'expired'
          ? 'Posting is paused. Your paid period has ended — renew it to post again.'
          : null,
    hasPriorPeriod: plan !== 'free',
  };
}

async function useUserSession(context: BrowserContext) {
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
  await page.route(`**/api/tenant/${TENANT.subdomain}/billing/entitlement`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(status.entitlement),
    })
  );
}

function countEntitlementRequests(page: Page): { count: () => number } {
  let calls = 0;
  page.on('request', (request) => {
    if (request.url().includes('/billing/entitlement')) calls += 1;
  });
  return { count: () => calls };
}

async function openSidebar(page: Page) {
  await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click();
}

test.describe('Free-plan gate at 390px', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('paid user: one entitlement fetch across sidebar navigations, no dialog', async ({
    page,
    context,
  }) => {
    await useUserSession(context);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await installBillingFixture(page, { entitlement: entitlement('paid'), payments: [] });
    const calls = countEntitlementRequests(page);

    await page.goto(`/tenant/${TENANT.subdomain}/inapp-schedule`);
    await expect(page.getByTestId('free-plan-upgrade-dialog')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/inapp-schedule`));
    expect(calls.count()).toBe(1);

    // SPA navigation through the sidebar drawer: the old provider
    // invalidated on every pathname change and refetched, unmounting
    // the section while the new answer pended.
    await openSidebar(page);
    await page.getByRole('link', { name: 'Accounts' }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/accounts`));
    await expect(page.getByTestId('free-plan-upgrade-dialog')).toHaveCount(0);
    expect(calls.count()).toBe(1);

    await openSidebar(page);
    await page.getByRole('link', { name: 'In-App Schedule' }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/inapp-schedule`));
    await expect(page.getByTestId('free-plan-upgrade-dialog')).toHaveCount(0);
    expect(calls.count()).toBe(1);
  });

  test('free user: dialogue fits the phone viewport, exits work, shell usable after', async ({
    page,
    context,
  }) => {
    await useUserSession(context);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await installBillingFixture(page, { entitlement: entitlement('free'), payments: [] });

    await page.goto(`/tenant/${TENANT.subdomain}/inapp-schedule`);
    const dialog = page.getByTestId('free-plan-upgrade-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByText("You're on the Free plan")).toBeVisible();
    await expect(
      page.getByText('This feature needs a paid plan. Upgrade to use it.')
    ).toBeVisible();
    const homeButton = page.getByTestId('free-plan-home-btn');
    const upgradeButton = page.getByTestId('free-plan-upgrade-btn');
    await expectWithinViewport(homeButton, page);
    await expectWithinViewport(upgradeButton, page);
    // Compact control height (36px) for dialog buttons.
    await expectMinTouchHeight(homeButton, 36);
    await expectMinTouchHeight(upgradeButton, 36);
    await expectNoDocumentOverflow(page);

    await homeButton.click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/?$`));
    await expect(dialog).toHaveCount(0);
    // The shell is usable again on the exempt Home route.
    await openSidebar(page);
    await expect(page.getByRole('link', { name: 'Media Library' })).toBeVisible();
  });

  test('free user: no automatic re-check while the dialogue shows', async ({
    page,
    context,
  }) => {
    await useUserSession(context);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await installBillingFixture(page, { entitlement: entitlement('free'), payments: [] });
    const calls = countEntitlementRequests(page);

    await page.goto(`/tenant/${TENANT.subdomain}/inapp-schedule`);
    await expect(page.getByTestId('free-plan-upgrade-dialog')).toBeVisible();
    expect(calls.count()).toBe(1);

    // The deleted loop re-checked every 30 seconds. Fast-forward
    // past two of its ticks: nothing may fetch, and no manual
    // "Check again" button may appear.
    await page.clock.install();
    await page.clock.fastForward(65_000);
    expect(calls.count()).toBe(1);
    await expect(page.getByTestId('free-plan-recheck-btn')).toHaveCount(0);
    await expect(page.getByTestId('free-plan-upgrade-dialog')).toBeVisible();
  });

  test('expired user: no dialogue, section browses like paid', async ({
    page,
    context,
  }) => {
    await useUserSession(context);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await installBillingFixture(page, { entitlement: entitlement('expired'), payments: [] });

    await page.goto(`/tenant/${TENANT.subdomain}/inapp-schedule`);
    await expect(page.getByTestId('free-plan-upgrade-dialog')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/inapp-schedule`));
    await expectNoDocumentOverflow(page);
  });
});
