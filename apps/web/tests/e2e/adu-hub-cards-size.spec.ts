/**
 * ADU hub page cards redesign (spec 188): the card layout changes
 * (56px avatar, title-scale name, Posted-first divided counts strip,
 * Today footer strip) without changing the card's outer size or the
 * hub grid.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the ADU hub list route registered below —
 * after the shared fixtures, so it takes precedence — serves three
 * identical-structure configs. No live network, no real backend.
 * The production build itself (routing, middleware session
 * verification, tenant layout, components) runs for real.
 *
 * The "unchanged size/grid" claim is measured, not asserted from
 * markup: every card's document-relative bounding box and the grid's
 * computed column count are recorded at a desktop width (1280, 3
 * columns) and a phone width (390, 1 column). Run this spec against
 * main first to capture the baseline numbers, then against the
 * branch — the widths and column counts must match, and the three
 * cards must share one box height (identical fixture structure).
 *
 * Fix round (SEND BACK on #262): the first version asserted only
 * within-branch uniformity, so it passed while every card had grown
 * 13px — the Today divider group stacked on the line's margin. The
 * baseline box heights are now encoded as constants below, so a
 * height change vs main fails loudly here instead of needing a
 * manual console.log comparison.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const CONFIGS = [
  {
    id: 'cfg-1',
    destinationId: 'dest-1',
    destinationName: 'Ellie Blossom',
    destinationExternalId: '432724216597352',
    destinationAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'sdf',
    sourceIdentity: '@sdf',
    sourceLink: 'https://www.tiktok.com/@sdf',
    destinationStatus: 'active',
    accountName: 'Shahzeb Malik',
    status: 'active',
    displayStatus: 'Active posting',
    timezone: 'Asia/Karachi',
    followersCount: 150,
    followersGained: 150,
    followersUpdatedAt: null,
    createdAt: '2026-11-02T10:00:00.000Z',
    postedCount: 12,
    pendingCount: 5,
    failedCount: 2,
    postedToday: 0,
    pendingToday: 1,
    failedToday: 0,
    postsPerDay: 1,
  },
  {
    id: 'cfg-2',
    destinationId: 'dest-2',
    destinationName: 'Basit khan',
    destinationExternalId: '100000000000002',
    destinationAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'dreamingartsus',
    sourceIdentity: '@dreamingartsus.com',
    sourceLink: 'https://www.tiktok.com/@dreamingartsus',
    destinationStatus: 'active',
    accountName: 'Luna Olive',
    status: 'active',
    displayStatus: 'Active posting',
    timezone: 'Asia/Karachi',
    followersCount: 2,
    followersGained: 2,
    followersUpdatedAt: null,
    createdAt: '2026-11-08T10:00:00.000Z',
    postedCount: 1,
    pendingCount: 998,
    failedCount: 2,
    postedToday: 0,
    pendingToday: 4,
    failedToday: 0,
    postsPerDay: 1,
  },
  {
    id: 'cfg-3',
    destinationId: 'dest-3',
    destinationName: 'Amira Shah',
    destinationExternalId: '100000000000003',
    destinationAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'amira',
    sourceIdentity: '@amira',
    sourceLink: 'https://www.tiktok.com/@amira',
    destinationStatus: 'paused',
    accountName: 'Shahzeb Malik',
    status: 'paused',
    displayStatus: 'Paused',
    timezone: 'Asia/Karachi',
    followersCount: 80,
    followersGained: 80,
    followersUpdatedAt: null,
    createdAt: '2026-11-05T10:00:00.000Z',
    postedCount: 128,
    pendingCount: 42,
    failedCount: 9,
    postedToday: 3,
    pendingToday: 0,
    failedToday: 1,
    postsPerDay: 1,
  },
];

/** Serves the ADU hub list + stats endpoints for this spec. */

/**
 * Recorded card box heights on main (56ad14da), same fixtures,
 * both viewports: desktop 314.66 × 317.875, phone 342 × 317.875.
 * Any redesign that moves a card's height off this baseline fails
 * here — the three cards sharing a wrong height is not a pass.
 */
const BASELINE_CARD_HEIGHT = 317.875;
/** Baseline gap, counts-grid bottom to Today text top (mt-3). */
const BASELINE_TODAY_GAP = 12;
async function installAduHubFixtures(page: import('@playwright/test').Page) {
  await page.route(
    (url) => url.pathname === `/api/tenant/${TENANT.subdomain}/auto-download-upload`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configs: CONFIGS,
          stats: { totalPages: 3, followersGained: 232, totalFollowers: 232 },
          totalPages: 1,
          page: 1,
        }),
      })
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, columns: 3 },
  { name: 'phone', width: 390, height: 844, columns: 1 },
]) {
  test.describe(`ADU hub cards size — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await installAduHubFixtures(page);
    });

    test('cards keep the grid and one shared box size', async ({ page }) => {
      await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload`);
      await expect(page.getByTestId('adu-page-card-cfg-1')).toBeVisible();
      await expect(page.getByTestId('adu-page-card-cfg-2')).toBeVisible();
      await expect(page.getByTestId('adu-page-card-cfg-3')).toBeVisible();
      // Settle webfonts before measuring — a font swap mid-test
      // would move text by a fraction of a pixel.
      await page.evaluate(() => document.fonts.ready);

      const gridColumns = await page
        .getByTestId('adu-page-card-cfg-1')
        .evaluate((el) =>
          getComputedStyle(el.parentElement!).gridTemplateColumns.split(' ').length
        );
      expect(gridColumns).toBe(viewport.columns);

      // Document-relative boxes (getBoundingClientRect + scroll
      // offset): the claim is about the document, not the viewport.
      const box = async (id: string) =>
        page.getByTestId(`adu-page-card-${id}`).evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
        });
      const boxes = {
        'cfg-1': await box('cfg-1'),
        'cfg-2': await box('cfg-2'),
        'cfg-3': await box('cfg-3'),
      };
      // Recorded for the before/after comparison against main.
      console.log(`hub-cards ${viewport.name}: ${JSON.stringify(boxes)}`);
      // Same grid cell: identical widths and identical heights for
      // identical-structure cards. Compared within 1px: the browser
      // splits the row width across columns with sub-pixel
      // rounding, so the middle column can land a fraction of a
      // pixel wider than its neighbours.
      const within1px = (a: number, b: number) => Math.abs(a - b) < 1;
      expect(within1px(boxes['cfg-2'].width, boxes['cfg-1'].width)).toBe(true);
      expect(within1px(boxes['cfg-3'].width, boxes['cfg-1'].width)).toBe(true);
      expect(within1px(boxes['cfg-2'].height, boxes['cfg-1'].height)).toBe(true);
      expect(within1px(boxes['cfg-3'].height, boxes['cfg-1'].height)).toBe(true);
      // Baseline height, not just uniformity: a change that grows
      // (or shrinks) every card together must fail here — this is
      // what let the +13px Today divider group through in round 1.
      for (const id of ['cfg-1', 'cfg-2', 'cfg-3'] as const) {
        expect(within1px(boxes[id].height, BASELINE_CARD_HEIGHT)).toBe(true);
      }

      // The counts strip reads Posted / Pending / Failed, and the
      // avatar is the 56px one with the title-scale name.
      const card1 = page.getByTestId('adu-page-card-cfg-1');
      const counts = card1.getByTestId('adu-page-pending-counts');
      expect(
        await counts.evaluate((el) =>
          Array.from(el.children).map((child) => child.getAttribute('data-testid'))
        )
      ).toEqual(['adu-page-posted-stat', 'adu-page-pending-stat', 'adu-page-failed-stat']);
      const avatar = card1.getByTestId('adu-page-avatar-initials');
      const avatarBox = await avatar.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      expect(avatarBox.width).toBe(56);
      expect(avatarBox.height).toBe(56);
      const nameStyle = await card1
        .getByTestId('adu-page-name')
        .evaluate((el) => {
          const style = getComputedStyle(el);
          return { fontSize: style.fontSize, fontWeight: style.fontWeight };
        });
      // The name renders at the design-system lg token — read the
      // token itself rather than hard-coding its pixel value, so a
      // future type-scale change does not fake a failure here.
      const lgToken = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--font-size-lg').trim()
      );
      expect(nameStyle.fontSize).toBe(lgToken);
      expect(nameStyle.fontWeight).toBe('700');

      // The Today footer strip's divider is the Today line's own
      // 1px border-top — it must contribute ≤1px, and the gap from
      // the counts grid's bottom to the Today text must stay the
      // baseline 12px. A standalone divider group (pt-3 + border
      // stacked on the line's margin) is what grew the card 13px.
      const today = card1.getByTestId('adu-page-today-line');
      const todayStrip = await today.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          borderTopWidth: style.borderTopWidth,
          borderTopStyle: style.borderTopStyle,
          paddingTop: parseFloat(style.paddingTop),
        };
      });
      expect(todayStrip.borderTopWidth).toBe('1px');
      expect(todayStrip.borderTopStyle).toBe('solid');
      const todayGap = await page.evaluate(() => {
        const countsEl = document.querySelector(
          '[data-testid="adu-page-pending-counts"]'
        )!;
        const todayEl = document.querySelector(
          '[data-testid="adu-page-today-line"]'
        )!;
        const countsBottom = countsEl.getBoundingClientRect().bottom;
        const style = getComputedStyle(todayEl);
        const textTop =
          todayEl.getBoundingClientRect().top +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.paddingTop);
        return textTop - countsBottom;
      });
      expect(within1px(todayGap, BASELINE_TODAY_GAP)).toBe(true);

      if (viewport.name === 'phone') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBe(0);
      }
    });
  });
}
