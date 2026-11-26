/**
 * Instagram Publish Now (spec 251): the section renders end to end
 * in a real browser — sidebar leaf, account selector, and the
 * composer with Image / Video / Reel — at desktop and phone widths.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the Instagram accounts route registered
 * below — after the shared fixtures, so it takes precedence —
 * serves the seeded accounts list. No live network, no real
 * backend. The production build itself (routing, middleware session
 * verification, tenant layout, components) runs for real.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const IG_ACCOUNTS = [
  {
    id: '11111111-1111-4111-a111-111111111111',
    externalAccountId: '17841456440622459',
    displayName: 'shahzeb.pxp',
    profilePictureUrl: null,
    status: 'active',
    tokenExpiresAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-a444-444444444444',
    externalAccountId: '17841456440622460',
    displayName: 'Expired Creator',
    profilePictureUrl: null,
    status: 'expired',
    tokenExpiresAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

async function installInstagramAccountsFixture(
  page: import('@playwright/test').Page
) {
  await page.route(
    (url) =>
      url.pathname === `/api/tenant/${TENANT.subdomain}/instagram/accounts`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accounts: IG_ACCOUNTS,
          total: IG_ACCOUNTS.length,
          page: 1,
          limit: 50,
          totalPages: 1,
        }),
      })
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`Instagram Publish Now — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState({ accounts: [] });
      await installApiFixtures(page, state);
      await installInstagramAccountsFixture(page);
    });

    test('selector lists the accounts, then Continue opens the composer', async ({
      page,
    }) => {
      await page.goto(`/tenant/${TENANT.subdomain}/instagram/publish-now`);

      // Sidebar: Instagram has Accounts and Publish Now. The leaf
      // is in the DOM on both widths; on desktop the Instagram
      // group auto-opens for its own route so the leaf is visible,
      // while on phone the sidebar is a closed drawer.
      await expect(
        page.locator('a[href*="instagram/publish-now"]')
      ).toHaveCount(1);
      if (viewport.name === 'desktop') {
        await expect(
          page.locator('a[href*="instagram/publish-now"]').first()
        ).toBeVisible();
      }

      // Step 1: the heading, the account, and the counts.
      await expect(
        page.getByRole('heading', { name: 'Publish Now' })
      ).toBeVisible();
      await expect(
        page.getByText('Select Instagram accounts to publish to.')
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Select accounts' })
      ).toBeVisible();
      await expect(page.getByText('shahzeb.pxp', { exact: true })).toBeVisible();
      await expect(page.getByText('Expired Creator')).toBeVisible();
      // Instagram has no pages: no "pages" wording is shown.
      await expect(page.getByText(/No pages to pick/)).toHaveCount(0);
      await expect(page.getByText(/0 of 2 accounts selected/)).toBeVisible();

      await page.getByText('shahzeb.pxp', { exact: true }).click();
      await expect(page.getByText(/1 of 2 accounts selected/)).toBeVisible();
      await page.getByRole('button', { name: 'Continue (1 account)' }).click();

      // Composer: header names the account, three post types,
      // caption + first comment, media attach, Publish Now, and
      // the empty results panel.
      await expect(
        page.getByRole('heading', { name: 'shahzeb.pxp' })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Image', exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Video', exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Reel', exact: true })
      ).toBeVisible();
      await expect(
        page.getByPlaceholder('Write a caption...')
      ).toBeVisible();
      await expect(
        page.getByPlaceholder('Write a comment...')
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Attach from Media Library' })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Upload from device' })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Publish Now' })
      ).toBeVisible();
      await expect(
        page.getByText('No results yet — publish to see per-account results here.')
      ).toBeVisible();
    });

    test('switching post type shows the matching guidance', async ({ page }) => {
      await page.goto(`/tenant/${TENANT.subdomain}/instagram/publish-now`);
      await expect(page.getByText('shahzeb.pxp', { exact: true })).toBeVisible();
      await page.getByText('shahzeb.pxp', { exact: true }).click();
      await page.getByRole('button', { name: 'Continue (1 account)' }).click();

      await expect(
        page.getByText(/Instagram photos must be JPEG/)
      ).toBeVisible();
      await page.getByRole('button', { name: 'Video', exact: true }).click();
      await expect(
        page.getByText(/regular video post/)
      ).toBeVisible();
      await page.getByRole('button', { name: 'Reel', exact: true }).click();
      await expect(
        page.getByText(/Videos publish as Reels and appear in feed/)
      ).toBeVisible();
    });
  });
}
