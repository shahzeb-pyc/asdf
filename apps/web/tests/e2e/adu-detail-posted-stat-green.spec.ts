/**
 * ADU detail page — Posted stat numbers in the hub-card green
 * (spec 220).
 *
 * Bug: Total Posted and Posted Today rendered in gold
 * (`text-primary` = --color-brand-gold) on the white stat cards —
 * low contrast, hard to read. The owner picked the same green as
 * Posted on the ADU hub cards (`text-signal-operational`).
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the ADU detail route registered below —
 * after the shared fixtures, so it takes precedence — serves one
 * config. No live network, no real backend. The production build
 * itself (routing, middleware session verification, tenant layout,
 * components) runs for real.
 *
 * The colour is measured, not asserted from markup: each tile value's
 * computed colour is compared against probe elements carrying the
 * token utilities, so the test fails if the value renders in gold
 * (the old bug) or in any green other than the hub-card one. The
 * Pending/Failed tiles are pinned to their own tokens so a
 * well-meaning "make everything green" change fails here too.
 * Desktop 1280 and phone 390; the phone run also asserts zero
 * horizontal overflow.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const CONFIG_ID = 'cfg-1';

const CONFIG = {
  id: CONFIG_ID,
  destinationId: 'dest-1',
  destinationName: 'E2E Test Page',
  destinationExternalId: '100000000000001',
  destinationAvatarUrl: null,
  accountName: 'E2E Connected Account',
  accountAvatarUrl: null,
  sourcePlatform: 'tiktok',
  sourceUsername: 'creator_one',
  sourceLink: 'https://www.tiktok.com/@creator_one',
  sourceIdentity: '@creator_one',
  timezone: 'Asia/Karachi',
  postsPerDay: 2,
  scheduleType: 'dailyrandom',
  postingTimes: [],
  status: 'active',
  syncStatus: 'synced',
  displayStatus: 'Active posting',
  destinationStatus: 'active',
  destinationFbStatus: null,
  alert: null,
  followersCount: 120,
  followersGained: 132,
  createdAt: '2026-10-01T00:00:00.000Z',
  postedCount: 12,
  pendingCount: 5,
  failedCount: 3,
  postedToday: 1,
  pendingToday: 1,
  failedToday: 0,
};

async function installAduDetailFixtures(page: import('@playwright/test').Page) {
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/auto-download-upload/${CONFIG_ID}**`,
    (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      if (method === 'PATCH') return json({ ok: true });
      if (url.pathname.endsWith('/reels')) return json({ reels: [] });
      if (url.pathname.endsWith('/failed')) return json({ jobs: [] });
      return json({ config: CONFIG });
    },
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`ADU detail Posted stat colour — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await installAduDetailFixtures(page);
    });

    test('Posted tiles render in the hub-card green, others unchanged (spec 220)', async ({
      page,
    }) => {
      await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload/${CONFIG_ID}`);
      await expect(page.getByRole('heading', { name: 'Total Statistics' })).toBeVisible();

      const tileValueColor = async (label: string) => {
        const value = page
          .getByText(label, { exact: true })
          .locator('xpath=..')
          .locator('p.text-xxxl');
        await expect(value).toBeVisible();
        return value.evaluate((el) => getComputedStyle(el).color);
      };

      const probeColor = async (utilityClass: string) =>
        page.evaluate((cls) => {
          const probe = document.createElement('span');
          probe.className = cls;
          probe.textContent = 'x';
          document.body.appendChild(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }, utilityClass);

      const green = await probeColor('text-signal-operational');
      const gold = await probeColor('text-primary');
      const ink = await probeColor('text-ink');
      const destructive = await probeColor('text-destructive');
      expect(green).not.toBe(gold);

      // Spec 220: the two Posted numbers in the hub-card green.
      expect(await tileValueColor('Total Posted')).toBe(green);
      expect(await tileValueColor('Posted Today')).toBe(green);
      // Every other tile exactly as before.
      expect(await tileValueColor('Total Pending')).toBe(ink);
      expect(await tileValueColor('Pending Today')).toBe(ink);
      expect(await tileValueColor('Followers Gained')).toBe(ink);
      expect(await tileValueColor('Failed Posts')).toBe(destructive);
      expect(await tileValueColor('Failed Today')).toBe(destructive);

      if (viewport.name === 'phone') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBe(0);
      }
    });
  });
}
