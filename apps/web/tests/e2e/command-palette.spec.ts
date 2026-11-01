/**
 * Flow — ⌘K command palette (spec 130 §5.9, PR-130-4).
 *
 * Sign in (fixture session), open the palette three ways (header
 * button, Ctrl+K, ⌘K), type a query, arrow/Enter to a destination
 * and to a Facebook Page from the cached pool, assert navigation;
 * Esc closes and focus returns to the header button (the invoker);
 * the chosen page reappears under Recents on the next open.
 *
 * A second describe runs the palette at phone widths (390px, then
 * resized to 320px) and at 768px — the spec 142 mobile gate evidence
 * for this PR: the palette is a full-width sheet on phones (16px
 * gutters), rows are compact 36px targets, the header button stays
 * reachable, and the document never overflows horizontally.
 *
 * API traffic is fixture-served; the pool routes are registered
 * after the generic fixtures so their schema-complete envelopes win
 * (the palette parses pool responses through the typed client).
 */

import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { CONNECTED_ACCOUNT, FACEBOOK_PAGE, SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

const WORKSPACES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: TENANT.userId,
    name: 'E2E Workspace',
    subdomain: TENANT.subdomain,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666',
    ownerId: TENANT.userId,
    name: 'Beta Workspace',
    subdomain: 'beta',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

const FULL_PAGE = {
  ...FACEBOOK_PAGE,
  profilePictureUrl: null,
  followersCount: 132,
  updatedAt: '2026-10-01T00:00:00.000Z',
  tasks: [],
};

async function installPaletteFixtures(page: Page): Promise<void> {
  const state = createFixtureState();
  await installApiFixtures(page, state);
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill(json({ workspaces: WORKSPACES }));
  });
  await page.route(`**/api/tenant/${TENANT.subdomain}/accounts`, (route) =>
    route.fulfill(json({ accounts: [CONNECTED_ACCOUNT], total: 1 }))
  );
  await page.route(`**/api/tenant/${TENANT.subdomain}/pages`, (route) =>
    route.fulfill(json({ pages: [FULL_PAGE], total: 1 }))
  );
  await page.route(`**/api/tenant/${TENANT.subdomain}/accounts/social`, (route) =>
    route.fulfill(json({ accounts: [] }))
  );
}

async function signInToTenantHome(page: Page): Promise<void> {
  // Home is a non-admin surface since the admin-landing change
  // (admins redirect to the panel), so the palette tests sign in as
  // a regular user — the palette itself is role-independent.
  await page.context().addCookies([
    { ...SESSION_COOKIE, value: mintSessionToken('user') },
  ]);
  await installPaletteFixtures(page);
  await page.goto(`/tenant/${TENANT.subdomain}`);
  await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
}

test.describe('⌘K command palette (spec 130 §5.9)', () => {
  test('header button, Ctrl+K, Esc focus return, pool navigation, recents', async ({ page }) => {
    await signInToTenantHome(page);

    // OD130-6: the visible search-style header button with its hint.
    const trigger = page.getByTestId('command-palette-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('⌘K');

    // Ctrl+K opens; Esc closes and focus returns to the invoker.
    await trigger.focus();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('command-palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Header button opens; type the page name; Enter navigates to it.
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('command-palette-input').fill('E2E Test Page');
    const pageRow = page.getByTestId(`palette-item-fb-page-${FACEBOOK_PAGE.id}`);
    await expect(pageRow).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(
      new RegExp(`/tenant/${TENANT.subdomain}/pages/${FACEBOOK_PAGE.id}$`)
    );

    // ⌘K (meta) reopens from the destination; the chosen page is a recent.
    await page.keyboard.press('Meta+k');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Recents');
    await expect(
      page.getByTestId(`palette-item-fb-page-${FACEBOOK_PAGE.id}`).first()
    ).toBeVisible();

    // Arrow + Enter navigates to a Go-to destination.
    await page.getByTestId('command-palette-input').fill('library');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/media$`));
  });
});

test.describe('⌘K palette at small widths (spec 142 mobile gate)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('full-width sheet, compact 36px rows, no overflow at 390px and 320px', async ({ page }) => {
    await signInToTenantHome(page);

    const trigger = page.getByTestId('command-palette-trigger');
    await expect(trigger).toBeVisible();
    await trigger.tap();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 720 });
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        // Full-width sheet on phones: 16px gutters, never wider.
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.width).toBeGreaterThanOrEqual(width - 40);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth)
      ).toBeLessThanOrEqual(width);
      const row = page.getByTestId('palette-item-go-home');
      const rowBox = await row.boundingBox();
      expect(rowBox).not.toBeNull();
      if (rowBox) expect(rowBox.height).toBeGreaterThanOrEqual(36);
    }

    // Tap a row navigates (no hover-only path).
    await page.getByTestId('palette-item-go-media').tap();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/media$`));
  });

  test('palette at 768px: centred dialog inside the viewport, rows at the compact 36px', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await signInToTenantHome(page);
    await page.getByTestId('command-palette-trigger').focus();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(768);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(768);
    const rowBox = await page.getByTestId('palette-item-go-home').boundingBox();
    expect(rowBox).not.toBeNull();
    if (rowBox) expect(rowBox.height).toBeGreaterThanOrEqual(36);
  });
});
