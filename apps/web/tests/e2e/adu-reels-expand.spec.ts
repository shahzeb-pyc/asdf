/**
 * ADU detail page — Reels tab rebuild (spec 179): expanding a card
 * in place must not move the grid.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the ADU detail routes registered below —
 * after the shared fixtures, so they take precedence — serve one
 * config plus a 4-reel queue. No live network, no real backend. The
 * production build itself (routing, middleware session verification,
 * tenant layout, components) runs for real.
 *
 * The exact-fit claim is measured, not asserted from markup: every
 * card's bounding box and every card in the row below the expanded
 * card is recorded before and after the click, at a desktop width
 * (1280, 3 columns) and a phone width (390, 2 columns). The reel
 * media URLs point at a dead host and are aborted at the browser
 * boundary — the preview sizing is CSS (aspect-9/16), so a video
 * that never loads still proves the layout.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const CONFIG_ID = 'cfg-1';

const REELS = [
  { id: 'r1', source_reel_id: 'sr-1', caption: 'First caption', media_url: 'https://media.e2e.invalid/r1.mp4', status: 'downloaded', downloaded_at: '2026-11-12T10:00:00.000Z' },
  { id: 'r2', source_reel_id: 'sr-2', caption: 'Second caption', media_url: 'https://media.e2e.invalid/r2.mp4', status: 'downloaded', downloaded_at: '2026-11-12T09:00:00.000Z' },
  { id: 'r3', source_reel_id: 'sr-3', caption: 'Third caption is a longer one that wraps to two lines in the card', media_url: 'https://media.e2e.invalid/r3.mp4', status: 'downloaded', downloaded_at: '2026-11-12T08:00:00.000Z' },
  { id: 'r4', source_reel_id: 'sr-4', caption: 'Fourth caption', media_url: null, status: 'downloaded', downloaded_at: '2026-11-12T07:00:00.000Z' },
];

/** Serves the ADU detail endpoints for this spec. */
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
      if (url.pathname.endsWith('/reels')) {
        return json({ reels: REELS, page: 1, pageSize: 24, total: 4, totalPages: 1 });
      }
      if (url.pathname.endsWith('/failed')) return json({ jobs: [] });
      return json({
        config: {
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
          alert: null,
          followersCount: 120,
          followersGained: 132,
          createdAt: '2026-10-01T00:00:00.000Z',
          postedCount: 10,
          pendingCount: 4,
          failedCount: 1,
          postedToday: 2,
          pendingToday: 1,
          failedToday: 0,
        },
      });
    }
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, columns: 3 },
  { name: 'phone', width: 390, height: 844, columns: 2 },
]) {
  test.describe(`ADU reels expand — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await installAduDetailFixtures(page);
      // The preview media never loads (dead host) — abort it so the
      // page is not held up by a hanging video fetch.
      await page.route('**/media.e2e.invalid/**', (route) => route.abort());
    });

    test('expanding a card keeps its box and the row below exactly where it was', async ({ page }) => {
      await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload/${CONFIG_ID}`);
      await page.getByTestId('adu-detail-tab-reels-btn').click();
      await expect(page.getByTestId('adu-reels-page-label')).toBeVisible();
      // Settle webfonts before measuring — a font swap mid-test
      // would move text by a fraction of a pixel.
      await page.evaluate(() => document.fonts.ready);

      const grid = page.getByTestId('adu-reels-grid');
      const columnCount = await grid.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length
      );
      expect(columnCount).toBe(viewport.columns);

      // Document-relative boxes (getBoundingClientRect + scroll
      // offset): Playwright's click scrolls the card fully into
      // view, which moves viewport-relative boxes without moving
      // anything in the document — the claim is about the document.
      const box = async (id: string) =>
        page.getByTestId(`adu-reel-card-${id}`).evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
        });
      const before = {
        r1: await box('r1'),
        r2: await box('r2'),
        r3: await box('r3'),
        r4: await box('r4'),
      };

      // Expand the first card: the editor appears with the reel's
      // own caption prefilled.
      await page.getByRole('button', { name: /First caption/ }).click();
      await expect(page.getByLabel('Caption Editor')).toHaveValue('First caption');
      await expect(page.getByRole('button', { name: 'Save Caption' })).toBeVisible();

      const after = {
        r1: await box('r1'),
        r2: await box('r2'),
        r3: await box('r3'),
        r4: await box('r4'),
      };
      // The expanded card is exactly the compact card's size, and
      // no card in the row below moved a pixel.
      expect(after.r1).toEqual(before.r1);
      expect(after.r2).toEqual(before.r2);
      expect(after.r3).toEqual(before.r3);
      expect(after.r4).toEqual(before.r4);

      // Collapsing restores the compact card.
      await page.getByRole('button', { name: 'Close editor' }).click();
      await expect(page.getByLabel('Caption Editor')).toHaveCount(0);
      expect(await box('r1')).toEqual(before.r1);

      if (viewport.name === 'phone') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBe(0);
      }
    });
  });
}
