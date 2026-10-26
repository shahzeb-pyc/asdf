/**
 * Pages list + Add Page flow (spec 131 PR-131-2).
 *
 * Drives the rebuilt Pages surface in the browser against the
 * fixture-served production build: populated list (attention-first
 * ordering + scale toolbar), empty state, filtered-to-zero with
 * one-click clear, and the two-step Add Page flow (account pick →
 * discover → select → import → finish summary banner). Also carries
 * the spec 142 mobile gate for this surface: the list and the
 * multi-step dialog are exercised at 320 / 390 / 768 CSS px with
 * zero-document-overflow and compact-target assertions (the Add action is the compact 36px control height — Shahzeb 2026-10-24, spec 129 OD-4 as amended).
 *
 * All API reads/writes are fixture-served at the browser boundary
 * (fixtures/api.ts + the route overrides below) — no production
 * data, no real third-party traffic.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

import {
  CONNECTED_ACCOUNT,
  createFixtureState,
  installApiFixtures,
} from './fixtures/api';
import { expectNoDocumentOverflow } from './fixtures/mobile';
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

const FIVE_PAGES = [
  fixturePage({ id: 'a1111111-1111-4111-8111-111111111111', pageName: 'Alpha Reels', fbPageId: '100000000000011', status: 'active', createdAt: '2026-10-01T00:00:00.000Z' }),
  fixturePage({ id: 'a2222222-2222-4222-8222-222222222222', pageName: 'Beta Paused', fbPageId: '100000000000012', status: 'paused', createdAt: '2026-10-02T00:00:00.000Z' }),
  fixturePage({ id: 'a3333333-3333-4333-8333-333333333333', pageName: 'Gamma Expired', fbPageId: '100000000000013', status: 'invalid_token', createdAt: '2026-10-03T00:00:00.000Z' }),
  fixturePage({ id: 'a4444444-4444-4444-8444-444444444444', pageName: 'Delta Daily', fbPageId: '100000000000014', status: 'active', createdAt: '2026-10-04T00:00:00.000Z' }),
  fixturePage({ id: 'a5555555-5555-4555-8555-555555555555', pageName: 'Epsilon Eats', fbPageId: '100000000000015', status: 'active', createdAt: '2026-10-05T00:00:00.000Z' }),
];

async function installPagesFixtures(
  page: Page,
  pages: Array<Record<string, unknown>>
) {
  const state = createFixtureState({ accounts: [CONNECTED_ACCOUNT] });
  await installApiFixtures(page, state);
  // Registered after the shared fixtures so these take precedence.
  await page.route(`**/api/tenant/${SUB}/pages`, (route) =>
    json(route, { pages, total: pages.length })
  );
  await page.route(
    `**/api/tenant/${SUB}/accounts/${CONNECTED_ACCOUNT.id}/pages/discover`,
    (route) =>
      json(route, {
        accountId: CONNECTED_ACCOUNT.id,
        accountDisplayName: CONNECTED_ACCOUNT.displayName,
        pages: [
          {
            fbPageId: '100000000000099',
            pageName: 'Discovered Page',
            profilePictureUrl: null,
            category: 'Business Page',
            currentFollowers: 42,
            followersCount: 42,
            tasks: [],
            isImported: false,
          },
        ],
        total: 1,
      })
  );
  await page.route(`**/api/tenant/${SUB}/pages/import`, (route) =>
    json(route, {
      success: true,
      importedCount: 1,
      pages: [
        {
          id: 'a9999999-9999-4999-8999-999999999999',
          fbPageId: '100000000000099',
          pageName: 'Discovered Page',
        },
      ],
    })
  );
}

test.describe('pages list + add page (spec 131 PR-131-2)', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([SESSION_COOKIE]);
  });

  test('populated list renders attention-first with the scale toolbar', async ({ page }) => {
    await installPagesFixtures(page, FIVE_PAGES);
    await page.goto(`/tenant/${SUB}/pages`);

    await expect(page.getByTestId('pages-grid')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pages-scale-toolbar')).toBeVisible();
    await expect(page.getByTestId('pages-page-subtitle')).toContainText(
      '5 connected pages'
    );
    await expect(page.getByTestId('pages-page-subtitle')).toContainText(
      '1 requires reconnecting'
    );
    // Attention-first: the invalid-token card leads the grid.
    const firstCard = page.getByTestId('pages-grid').locator('[data-testid^="page-card-"]').first();
    await expect(firstCard).toContainText('Gamma Expired');
  });

  test('empty state renders with its one primary action and the always-visible toolbar', async ({ page }) => {
    await installPagesFixtures(page, []);
    await page.goto(`/tenant/${SUB}/pages`);

    await expect(page.getByTestId('pages-empty-state')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('empty-state-add-page-btn')).toBeVisible();
    // Pages list redesign: the scale toolbar is no longer gated on page count.
    await expect(page.getByTestId('pages-scale-toolbar')).toBeVisible();
  });

  test('filtered-to-zero echoes filters and Clear filters restores the list', async ({ page }) => {
    await installPagesFixtures(page, FIVE_PAGES);
    await page.goto(`/tenant/${SUB}/pages`);

    await expect(page.getByTestId('pages-grid')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('pages-search-input').fill('no-such-page');
    await expect(page.getByTestId('pages-filter-empty')).toBeVisible();
    await page.getByTestId('pages-clear-filters-btn').click();
    await expect(page.getByTestId('pages-grid')).toBeVisible({ timeout: 15_000 });
  });

  test('add page flow: pick account, discover, select, import, finish summary', async ({ page }) => {
    await installPagesFixtures(page, FIVE_PAGES);
    await page.goto(`/tenant/${SUB}/pages`);

    await page.getByTestId('header-add-page-btn').click();
    await expect(page.getByTestId('add-page-modal')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`select-account-${CONNECTED_ACCOUNT.id}`).click();

    await expect(page.getByTestId('discovered-pages-list')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('discovered-page-checkbox-100000000000099').click();
    await page.getByTestId('confirm-add-pages-btn').click();

    await expect(page.getByTestId('pages-feedback-banner')).toContainText(
      '1 Facebook Page added to your workspace.'
    );
    await expect(page.getByTestId('add-page-modal')).toHaveCount(0);
  });

  test('mobile gate: list + add page dialog at 320 / 390 / 768 (spec 142)', async ({ page }) => {
    await installPagesFixtures(page, FIVE_PAGES);

    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/tenant/${SUB}/pages`);
      await expect(page.getByTestId('pages-grid')).toBeVisible({ timeout: 15_000 });
      await expectNoDocumentOverflow(page);

      const addBtn = page.getByTestId('header-add-page-btn');
      const addBox = await addBtn.boundingBox();
      expect(addBox, 'Add Page target at ' + width).not.toBeNull();
      expect(addBox!.height).toBeGreaterThanOrEqual(36);

      await addBtn.click();
      await expect(page.getByTestId('add-page-modal')).toBeVisible({ timeout: 15_000 });
      await expectNoDocumentOverflow(page);
      const accountRow = page.getByTestId(`select-account-${CONNECTED_ACCOUNT.id}`);
      const rowBox = await accountRow.boundingBox();
      expect(rowBox, 'account row target at ' + width).not.toBeNull();
      expect(rowBox!.height).toBeGreaterThanOrEqual(44);

      await accountRow.click();
      await expect(page.getByTestId('discovered-pages-list')).toBeVisible({ timeout: 15_000 });
      await expectNoDocumentOverflow(page);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('add-page-modal')).toHaveCount(0);
    }
  });
});
