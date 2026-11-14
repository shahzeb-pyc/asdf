/**
 * In-App Schedule page cards profile treatment (spec 189): the card
 * header changes (56px avatar, title-scale name, vertically centred
 * identity) without changing the card's outer size or the list grid.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the pages list route registered below — after
 * the shared fixtures, so it takes precedence — serves three
 * identical-structure pages. No live network, no real backend. The
 * production build itself (routing, middleware session verification,
 * tenant layout, components) runs for real.
 *
 * The "unchanged size/grid" claim is measured, not asserted from
 * markup: every card's document-relative bounding box and the grid's
 * computed column count are recorded at a desktop width (1280, 3
 * columns) and a phone width (390, 1 column). Run this spec against
 * main first to capture the baseline numbers, then against the
 * branch — the widths and column counts must match, and the three
 * cards must share one box height (identical fixture structure).
 */
import { test, expect, type Page, type Route } from '@playwright/test';

import {
  CONNECTED_ACCOUNT,
  createFixtureState,
  installApiFixtures,
  paginateFixtureList,
} from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const SUB = TENANT.subdomain;

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function fixturePage(overrides: Record<string, unknown>) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    facebookAccountId: CONNECTED_ACCOUNT.id,
    accountDisplayName: CONNECTED_ACCOUNT.displayName,
    fbPageId: '100000000000001',
    pageName: 'E2E Test Page',
    profilePictureUrl: null,
    category: 'Business Page',
    timezone: 'UTC',
    startingFollowers: 120,
    currentFollowers: 132,
    followersGained: 12,
    followersCount: 132,
    status: 'active',
    tasks: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

// Three identical-structure pages: same status, followers, gained,
// dates, and counts, so any box difference is the header change.
const THREE_PAGES = [
  fixturePage({ id: 'a1111111-1111-4111-8111-111111111111', pageName: 'Alpha Reels', fbPageId: '100000000000011' }),
  fixturePage({ id: 'a2222222-2222-4222-8222-222222222222', pageName: 'Beta Reels', fbPageId: '100000000000012' }),
  fixturePage({ id: 'a3333333-3333-4333-8333-333333333333', pageName: 'Gamma Reels', fbPageId: '100000000000013' }),
];

/** Serves the pages list endpoint for this spec. */
async function installPagesSizeFixtures(page: Page) {
  const state = createFixtureState({ accounts: [CONNECTED_ACCOUNT] });
  await installApiFixtures(page, state);
  // Registered after the shared fixtures so this takes precedence.
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/pages`,
    (route) => {
      const { items, total, page: pageNum, limit, totalPages } =
        paginateFixtureList(route, THREE_PAGES, () => true);
      return json(route, { pages: items, total, page: pageNum, limit, totalPages });
    }
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, columns: 3 },
  { name: 'phone', width: 390, height: 844, columns: 1 },
]) {
  test.describe(`In-App Schedule cards size — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      await installPagesSizeFixtures(page);
    });

    test('cards keep the grid and one shared box size', async ({ page }) => {
      await page.goto(`/tenant/${SUB}/inapp-schedule`);
      await expect(page.getByTestId('page-card-a1111111-1111-4111-8111-111111111111')).toBeVisible();
      await expect(page.getByTestId('page-card-a2222222-2222-4222-8222-222222222222')).toBeVisible();
      await expect(page.getByTestId('page-card-a3333333-3333-4333-8333-333333333333')).toBeVisible();
      // Settle webfonts before measuring — a font swap mid-test
      // would move text by a fraction of a pixel.
      await page.evaluate(() => document.fonts.ready);

      const gridColumns = await page
        .getByTestId('page-card-a1111111-1111-4111-8111-111111111111')
        .evaluate((el) =>
          getComputedStyle(el.parentElement!).gridTemplateColumns.split(' ').length
        );
      expect(gridColumns).toBe(viewport.columns);

      // Document-relative boxes (getBoundingClientRect + scroll
      // offset): the claim is about the document, not the viewport.
      const box = async (id: string) =>
        page.getByTestId(`page-card-${id}`).evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
        });
      const boxes = {
        'a1111111-1111-4111-8111-111111111111': await box('a1111111-1111-4111-8111-111111111111'),
        'a2222222-2222-4222-8222-222222222222': await box('a2222222-2222-4222-8222-222222222222'),
        'a3333333-3333-4333-8333-333333333333': await box('a3333333-3333-4333-8333-333333333333'),
      };
      // Recorded for the before/after comparison against main.
      console.log(`inapp-schedule-cards ${viewport.name}: ${JSON.stringify(boxes)}`);
      // Same grid cell: identical widths, and identical heights for
      // identical-structure cards.
      expect(boxes['a2222222-2222-4222-8222-222222222222'].width).toBe(boxes['a1111111-1111-4111-8111-111111111111'].width);
      expect(boxes['a3333333-3333-4333-8333-333333333333'].width).toBe(boxes['a1111111-1111-4111-8111-111111111111'].width);
      expect(boxes['a2222222-2222-4222-8222-222222222222'].height).toBe(boxes['a1111111-1111-4111-8111-111111111111'].height);
      expect(boxes['a3333333-3333-4333-8333-333333333333'].height).toBe(boxes['a1111111-1111-4111-8111-111111111111'].height);

      // The avatar is the 56px one with the title-scale name.
      const card1 = page.getByTestId('page-card-a1111111-1111-4111-8111-111111111111');
      const avatar = card1.getByTestId('page-avatar-initials');
      const avatarBox = await avatar.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      expect(avatarBox.width).toBe(56);
      expect(avatarBox.height).toBe(56);
      const nameStyle = await card1
        .getByTestId('page-name')
        .evaluate((el) => {
          const style = getComputedStyle(el);
          return { fontSize: style.fontSize, fontWeight: style.fontWeight };
        });
      expect(nameStyle.fontSize).toBe('16.25px');
      expect(nameStyle.fontWeight).toBe('700');

      if (viewport.name === 'phone') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBe(0);
      }
    });
  });
}
