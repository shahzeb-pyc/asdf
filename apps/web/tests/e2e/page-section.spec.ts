/**
 * Accounts → Facebook dedicated section click-through (spec 131 §8.7
 * e2e growth, PR-131-3) + the section frame's mobile gate (spec 142).
 *
 * Fixture-served per A3 discipline: every API read the flow makes is
 * answered from tests/e2e/fixtures (the route's server prefetch misses
 * against the fixture backend, so the frame shell's React Query reads
 * are the browser fetches the fixtures intercept — the same
 * fall-through the Accounts shell and destination frame use). No
 * production data, no third-party traffic.
 *
 * Flow: Accounts list renders the connected account → Pages list →
 * click the Page card → the section frame loads with the §1.3 identity
 * header + the five verbatim tabs → each 131-owned tab renders, the
 * 134 queue panel and 132 composer mount through their slots, and a
 * visited tab stays mounted across tab switches (state preservation,
 * §9.3 interlock).
 */
import { test, expect, type Page } from '@playwright/test';

import { createFixtureState, installApiFixtures } from './fixtures/api';
import { CONNECTED_ACCOUNT, FACEBOOK_PAGE, SESSION_COOKIE, TENANT } from './fixtures/tenant';

const SUB = TENANT.subdomain;

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el ? el.scrollWidth - el.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openSection(page: Page) {
  await page.goto(`/tenant/${SUB}/pages/${FACEBOOK_PAGE.id}`);
  await expect(page.getByTestId('dedicated-page-workspace')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('dedicated-page-heading')).toHaveText(
    FACEBOOK_PAGE.pageName
  );
}

test.describe('dedicated page section — click-through (spec 131 §8.7)', () => {
  test('Accounts → Pages → section frame, every tab renders, visited tabs stay mounted', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    const state = createFixtureState({ accounts: [CONNECTED_ACCOUNT] });
    await installApiFixtures(page, state);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Accounts list renders the connected account.
    await page.goto(`/tenant/${SUB}/accounts`);
    await expect(page.getByTestId('accounts-grid')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('E2E Connected Account').first()).toBeVisible();

    // Pages list → click the Page card into its dedicated section.
    await page.goto(`/tenant/${SUB}/pages`);
    await page.getByTestId(`page-card-${FACEBOOK_PAGE.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/pages/${FACEBOOK_PAGE.id}$`));
    await expect(page.getByTestId('dedicated-page-workspace')).toBeVisible({
      timeout: 15_000,
    });

    // Identity header (§1.3 pattern) + the five verbatim tabs.
    await expect(page.getByTestId('dedicated-page-heading')).toHaveText(
      FACEBOOK_PAGE.pageName
    );
    await expect(page.getByTestId('dedicated-page-status')).toContainText('Active');
    for (const tab of ['dashboard', 'insights', 'queue', 'calendar']) {
      await expect(page.getByTestId(`tab-${tab}-btn`)).toBeVisible();
    }
    await expect(page.getByTestId('tab-dashboard-btn')).toHaveText('Dashboard');
    await expect(page.getByTestId('tab-queue-btn')).toContainText('Queue');
    await expect(page.getByTestId('tab-calendar-btn')).toHaveText('Posting Times');
    await expect(page.getByTestId('tab-insights-btn')).toHaveText('Insights');

    // Dashboard (131-owned) renders first.
    await expect(page.getByTestId('page-tab-dashboard')).toBeVisible();
    await expect(page.getByTestId('metric-followers')).toBeVisible();

    // Queue tab renders the real queue panel (Queue section rebuild).
    await page.getByTestId('tab-queue-btn').click();
    await expect(page.getByTestId('queue-panel')).toBeVisible({ timeout: 15_000 });

    // Posting Times tab (134's panel through the slot).
    await page.getByTestId('tab-calendar-btn').click();
    await expect(page.getByTestId('page-tab-calendar')).toBeVisible({ timeout: 15_000 });

    // Insights tab (131-owned): fixture data renders the KPI grid.
    await page.getByTestId('tab-insights-btn').click();
    await expect(page.getByTestId('insights-kpi-grid')).toBeVisible({ timeout: 15_000 });


    // State preservation (§9.3): the visited queue panel stays
    // mounted (hidden) while another tab is active — switching never
    // destroys visited panels' state.
    await page.getByTestId('tab-dashboard-btn').click();
    await expect(page.getByTestId('page-tab-dashboard')).toBeVisible();
    await expect(page.getByTestId('queue-panel')).toBeAttached();
    await page.getByTestId('tab-queue-btn').click();
    await expect(page.getByTestId('queue-panel')).toBeVisible();

  });
});

test.describe('dedicated page section — mobile gate (spec 142)', () => {
  for (const width of [320, 390, 768]) {
    test(`frame renders cleanly at ${width}px`, async ({ page, context }) => {
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState({ accounts: [CONNECTED_ACCOUNT] });
      await installApiFixtures(page, state);
      await page.setViewportSize({ width, height: 800 });

      await openSection(page);

      // Header intact: identity + primary action reachable by tap.
      // (The old header-add-queue-btn was removed with the composer:
      // Create Posts is now the header's primary action.)
      await expect(page.getByTestId('header-create-posts-btn')).toBeVisible();
      const queueBtnBox = await page.getByTestId('header-create-posts-btn').boundingBox();
      expect(queueBtnBox?.height ?? 0).toBeGreaterThanOrEqual(36);

      // Tab bar usable: every tab is reachable (scrollable strip) and
      // switching works at this width.
      await page.getByTestId('tab-calendar-btn').click();
      await expect(page.getByTestId('page-tab-calendar')).toBeVisible({
        timeout: 15_000,
      });
      const settingsTabBox = await page.getByTestId('tab-calendar-btn').boundingBox();
      expect(settingsTabBox?.height ?? 0).toBeGreaterThanOrEqual(36);

      await expectNoHorizontalOverflow(page);
    });
  }
});
