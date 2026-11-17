/**
 * ADU hub card — page status, not setup status (spec 201).
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the ADU hub list route registered below —
 * after the shared fixtures, so it takes precedence — serves two
 * configs. No live network, no real backend. The production build
 * itself (routing, middleware session verification, tenant layout,
 * components) runs for real.
 *
 * The bug this pins (beekainternational, 2026-11-17): a destination
 * in `error` with an `active` config rendered `Active posting` on
 * the hub card while nothing posted. The server now derives
 * `displayStatus` from the destination, so the error card's fixture
 * carries the label the server produces (`Error`); this spec proves
 * the card renders that label — critical mark, never
 * `Active posting` — at a desktop width (1280) and a phone width
 * (390). The derivation itself is pinned by the contracts unit
 * tests and the server view tests; this spec is the real-browser
 * rendering check, including no horizontal overflow at phone width.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const CONFIGS = [
  {
    id: 'cfg-err',
    destinationId: 'dest-err',
    destinationName: 'Blocked Page',
    destinationExternalId: '100000000000001',
    destinationAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'creator_blocked',
    sourceIdentity: '@creator_blocked',
    sourceLink: 'https://www.tiktok.com/@creator_blocked',
    destinationStatus: 'error',
    accountName: 'E2E Connected Account',
    status: 'active',
    displayStatus: 'Error',
    timezone: 'Asia/Karachi',
    followersCount: 120,
    followersGained: 120,
    followersUpdatedAt: null,
    createdAt: '2026-11-08T10:00:00.000Z',
    postedCount: 1,
    pendingCount: 999,
    failedCount: 0,
    postedToday: 0,
    pendingToday: 3,
    failedToday: 0,
    postsPerDay: 3,
  },
  {
    id: 'cfg-ok',
    destinationId: 'dest-ok',
    destinationName: 'Posting Page',
    destinationExternalId: '100000000000002',
    destinationAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'creator_ok',
    sourceIdentity: '@creator_ok',
    sourceLink: 'https://www.tiktok.com/@creator_ok',
    destinationStatus: 'active',
    accountName: 'E2E Connected Account',
    status: 'active',
    displayStatus: 'Active posting',
    timezone: 'Asia/Karachi',
    followersCount: 80,
    followersGained: 80,
    followersUpdatedAt: null,
    createdAt: '2026-11-08T10:00:00.000Z',
    postedCount: 5,
    pendingCount: 10,
    failedCount: 0,
    postedToday: 1,
    pendingToday: 2,
    failedToday: 0,
    postsPerDay: 3,
  },
];

/** Serves the ADU hub list + stats endpoints for this spec. */
async function installAduHubFixtures(page: import('@playwright/test').Page) {
  await page.route(
    (url) => url.pathname === `/api/tenant/${TENANT.subdomain}/auto-download-upload`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configs: CONFIGS,
          stats: { totalPages: 2, followersGained: 200, totalFollowers: 200 },
          totalPages: 1,
          page: 1,
        }),
      })
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`ADU hub card page status — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await installAduHubFixtures(page);
    });

    test('error-destination card never reads as Active posting', async ({ page }) => {
      await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload`);
      const errorCard = page.getByTestId('adu-page-card-cfg-err');
      const okCard = page.getByTestId('adu-page-card-cfg-ok');
      await expect(errorCard).toBeVisible();
      await expect(okCard).toBeVisible();

      const errorMark = errorCard.getByTestId('adu-page-status');
      await expect(errorMark).toContainText('Error');
      await expect(errorMark).not.toContainText('Active posting');
      await expect(errorMark).toHaveAttribute('data-status', 'critical');
      // The whole card must not claim active posting anywhere.
      await expect(errorCard).not.toContainText('Active posting');

      const okMark = okCard.getByTestId('adu-page-status');
      await expect(okMark).toContainText('Active posting');
      await expect(okMark).toHaveAttribute('data-status', 'operational');

      if (viewport.name === 'phone') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBe(0);
      }
    });
  });
}
