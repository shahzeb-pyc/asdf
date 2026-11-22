/**
 * Bulk Delete Posts wizard at real widths (spec 218):
 *
 * - Desktop 1280px: the wizard is a centred, constrained column —
 *   the stepper and step cards measure max-w-2xl (672px), the preview
 *   step max-w-300 (1200px). Nothing stretches edge to edge.
 * - Phone 390px: full-width steps, no horizontal overflow, footer
 *   buttons full-width, the delete bar inside the viewport.
 * - The wizard itself walks end to end in a real browser: accounts
 *   → pages → preview, with the preview grid rendering.
 *
 * Spec 219: with many accounts/pages the picker lists stay bounded
 * (max-h-72, ~6 rows) — the step never grows unboundedly tall.
 *
 * Spec 226: a transient discover failure (429/5xx) is retried per
 * account inside the dialog, and Step 2 waits out the retries — so
 * a burst 429 no longer shows the "check the account connection"
 * error for an account whose connection is fine. A transient that
 * never clears says Facebook was busy, never the connection message.
 *
 * Data comes from page.route fixtures registered AFTER
 * installApiFixtures (Playwright matches routes in reverse
 * registration order, so the bulk-delete fixtures win over the
 * catch-all). User views use a minted 'user' cookie with a paid
 * entitlement, so the Paid-only section renders instead of the
 * free-plan gate.
 */

import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import {
  expectNoDocumentOverflow,
  expectWithinViewport,
} from './fixtures/mobile';
import {
  CONNECTED_ACCOUNT,
  FACEBOOK_PAGE,
  SESSION_COOKIE,
  TENANT,
  mintSessionToken,
} from './fixtures/tenant';

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

function paidEntitlement() {
  return {
    plan: 'paid',
    active: true,
    counts: { ...ZERO_COUNTS, facebook: 2 },
    usage: { ...ZERO_COUNTS },
    periodEndsAt: '2026-11-30T00:00:00.000Z',
    periodStartsAt: '2026-10-31T00:00:00.000Z',
    canPost: true,
    readOnly: false,
    reason: null,
    hasPriorPeriod: true,
  };
}

async function useUserSession(context: import('@playwright/test').BrowserContext) {
  const userCookie = { ...SESSION_COOKIE, value: mintSessionToken('user') };
  await context.addCookies([
    userCookie,
    { ...userCookie, domain: `${TENANT.subdomain}.localhost` },
  ]);
}

function previewCandidates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${FACEBOOK_PAGE.fbPageId}_${i + 1}`,
    type: 'posts' as const,
    title: `E2E post ${i + 1}`,
    createdTime: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00+0000`,
    permalinkUrl: null,
    previewImageUrl: null,
  }));
}

async function installBulkDeleteFixtures(page: Page) {
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/billing/entitlement`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(paidEntitlement()),
      })
  );
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/accounts/${CONNECTED_ACCOUNT.id}/pages/discover`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accountId: CONNECTED_ACCOUNT.id,
          accountDisplayName: CONNECTED_ACCOUNT.displayName,
          pages: [
            {
              fbPageId: FACEBOOK_PAGE.fbPageId,
              pageName: FACEBOOK_PAGE.pageName,
              profilePictureUrl: null,
              category: 'Business Page',
              currentFollowers: FACEBOOK_PAGE.currentFollowers,
              followersCount: FACEBOOK_PAGE.currentFollowers,
              tasks: [],
              isImported: false,
            },
          ],
          total: 1,
        }),
      })
  );
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/bulk-delete/preview`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ total: 12, candidates: previewCandidates(12) }),
      })
  );
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/bulk-delete/content`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: previewCandidates(25), paging: { after: null } }),
      })
  );
}

async function setup(page: Page) {
  const state = createFixtureState({ accounts: [CONNECTED_ACCOUNT] });
  await installApiFixtures(page, state);
  await installBulkDeleteFixtures(page);
  await useUserSession(page.context());
  await page.goto(`/tenant/${TENANT.subdomain}/bulk-delete-posts`);
  await expect(page.getByRole('heading', { name: 'Select accounts' })).toBeVisible();
}

async function walkToPreview(page: Page) {
  await page.getByText(CONNECTED_ACCOUNT.displayName).click();
  await page.getByRole('button', { name: 'Continue (1 account)' }).click();
  await expect(page.getByRole('heading', { name: 'Select pages' })).toBeVisible();
  await page.getByText(FACEBOOK_PAGE.pageName).click();
  await page.getByRole('button', { name: 'Continue (1 page)' }).click();
  await expect(page.getByText('Smart Filter')).toBeVisible();
}

function manyAccounts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...CONNECTED_ACCOUNT,
    id: `33333333-3333-4333-8333-3333333333${String(i + 1).padStart(2, '0')}`,
    fbAccountId: `100000000000${String(100 + i)}`,
    displayName: `E2E Account ${i + 1}`,
  }));
}

function manyPages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    fbPageId: `100000000000${String(200 + i)}`,
    pageName: `E2E Page ${i + 1}`,
    profilePictureUrl: null,
    category: 'Business Page',
    currentFollowers: 100,
    followersCount: 100,
    tasks: [],
    isImported: false,
  }));
}

function discoverPayload(
  accountId: string,
  accountName: string,
  pages: { fbPageId: string; pageName: string }[],
) {
  return {
    accountId,
    accountDisplayName: accountName,
    pages: pages.map((p) => ({
      fbPageId: p.fbPageId,
      pageName: p.pageName,
      profilePictureUrl: null,
      category: 'Business Page',
      currentFollowers: 100,
      followersCount: 100,
      tasks: [],
      isImported: false,
    })),
    total: pages.length,
    truncated: false,
    partial: false,
    droppedCount: 0,
  };
}

/**
 * Spec 226 setup: two accounts. Account A always discovers fine;
 * account B is scripted — 'flaky-429' fails the first discover
 * with a 429 (retryAfterSeconds 1) then succeeds, 'always-500'
 * fails every discover with a 500. Returns B's discover call
 * count, read after the assertions.
 */
async function setupDiscoverRetry(
  page: Page,
  discoverB: 'flaky-429' | 'always-500',
) {
  const accounts = manyAccounts(2);
  const state = createFixtureState({ accounts });
  await installApiFixtures(page, state);
  await installBulkDeleteFixtures(page);
  let discoverBCalls = 0;
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/accounts/${accounts[0].id}/pages/discover`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          discoverPayload(accounts[0].id, 'E2E Account 1', [
            { fbPageId: '100000000000201', pageName: 'E2E Page A1' },
          ]),
        ),
      }),
  );
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/accounts/${accounts[1].id}/pages/discover`,
    (route) => {
      discoverBCalls += 1;
      if (discoverB === 'flaky-429' && discoverBCalls === 1) {
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Too many requests. Please wait 1 seconds before trying again.',
            retryAfterSeconds: 1,
          }),
        });
      }
      if (discoverB === 'always-500') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Failed to query Facebook Graph API' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          discoverPayload(accounts[1].id, 'E2E Account 2', [
            { fbPageId: '100000000000202', pageName: 'E2E Page B1' },
          ]),
        ),
      });
    },
  );
  await useUserSession(page.context());
  await page.goto(`/tenant/${TENANT.subdomain}/bulk-delete-posts`);
  await expect(page.getByRole('heading', { name: 'Select accounts' })).toBeVisible();
  return { getDiscoverBCalls: () => discoverBCalls };
}

/** Like setup(), but with 17 accounts and 12 pages for the first one. */
async function setupMany(page: Page) {
  const accounts = manyAccounts(17);
  const state = createFixtureState({ accounts });
  await installApiFixtures(page, state);
  await installBulkDeleteFixtures(page);
  // Discover for the first many-account returns 12 pages.
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/accounts/${accounts[0].id}/pages/discover`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accountId: accounts[0].id,
          accountDisplayName: accounts[0].displayName,
          pages: manyPages(12),
          total: 12,
        }),
      })
  );
  await useUserSession(page.context());
  await page.goto(`/tenant/${TENANT.subdomain}/bulk-delete-posts`);
  await expect(page.getByRole('heading', { name: 'Select accounts' })).toBeVisible();
}

/** With 17 accounts and 12 pages, both picker lists measure ≤ 288px. */
async function expectBoundedPickers(page: Page) {
  // Step 1: all 17 accounts render, but the list is capped at max-h-72.
  await expect(page.getByText('E2E Account 17', { exact: true })).toBeVisible();
  const accountsList = page.getByTestId('bulk-delete-accounts-list');
  const accountsBox = await accountsList.boundingBox();
  expect(accountsBox).not.toBeNull();
  expect(accountsBox!.height).toBeLessThanOrEqual(289);
  // The footer stays reachable without the page blowing out.
  await expectWithinViewport(
    page.getByRole('button', { name: 'Continue', exact: true }),
    page
  );

  // Step 2: 12 pages render, bounded the same way.
  await page.getByText('E2E Account 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue (1 account)' }).click();
  await expect(page.getByRole('heading', { name: 'Select pages' })).toBeVisible();
  await expect(page.getByText('E2E Page 12')).toBeVisible();
  const pagesList = page.getByTestId('bulk-delete-pages-list');
  const pagesBox = await pagesList.boundingBox();
  expect(pagesBox).not.toBeNull();
  expect(pagesBox!.height).toBeLessThanOrEqual(289);
  await expectWithinViewport(
    page.getByRole('button', { name: 'Continue', exact: true }),
    page
  );
  await expectNoDocumentOverflow(page);
}

test.describe('bulk delete wizard layout', () => {
  test('desktop 1280px: wizard is a centred constrained column, preview step wide', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);

    // Step 1: the stepper and the step card are max-w-2xl (672px),
    // centred — the wizard never spans the content area. Centring is
    // measured against #tenant-content (the area beside the desktop
    // sidebar), not the raw viewport.
    const stepper = page.locator('nav[aria-label="Bulk delete steps"]');
    const stepperBox = await stepper.boundingBox();
    expect(stepperBox).not.toBeNull();
    expect(stepperBox!.width).toBeLessThanOrEqual(673);
    expect(stepperBox!.width).toBeLessThan(1280);
    const contentBox = await page.locator('#tenant-content').boundingBox();
    expect(contentBox).not.toBeNull();
    const leftGap = stepperBox!.x - contentBox!.x;
    const rightGap =
      contentBox!.x + contentBox!.width - (stepperBox!.x + stepperBox!.width);
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);

    await walkToPreview(page);
    await page.getByRole('button', { name: 'Preview Targets' }).click();
    await expect(page.getByText('Items Found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'E2E post 1 — Posts' })).toBeVisible();
    await expect(page.getByText('12 items selected')).toBeVisible();

    // Step 3: the preview grid is max-w-300 (1200px), still narrower
    // than the viewport — wide, but not stretched edge to edge.
    const gridWidth = await page.evaluate(() => {
      const grid = document.querySelector('[class*="lg:grid-cols-4"]');
      return grid ? grid.getBoundingClientRect().width : -1;
    });
    expect(gridWidth).toBeGreaterThan(0);
    expect(gridWidth).toBeLessThanOrEqual(1201);
    expect(gridWidth).toBeLessThan(1280);

    await expectNoDocumentOverflow(page);
  });

  test('phone 390px: full-width steps, no overflow, full-width footer buttons', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);

    // Step 1 footer button spans the card (full-width on phones).
    // Measure it before selecting anything: walkToPreview below does
    // the selecting, and clicking the account twice would toggle it off.
    const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
    const buttonBox = await continueButton.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.width).toBeGreaterThanOrEqual(300);
    expect(buttonBox!.width).toBeLessThanOrEqual(390);

    await walkToPreview(page);
    await page.getByRole('button', { name: 'Preview Targets' }).click();
    await expect(page.getByText('Items Found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'E2E post 1 — Posts' })).toBeVisible();

    // The floating delete bar wraps inside the viewport instead of
    // overflowing it, and the page never scrolls horizontally.
    await expectWithinViewport(page.getByText('12 items selected'), page);
    await expectNoDocumentOverflow(page);
  });

  test('desktop 1280px: picker lists stay bounded with many accounts and pages (spec 219)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupMany(page);
    await expectBoundedPickers(page);
  });

  test('phone 390px: picker lists stay bounded with many accounts and pages (spec 219)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupMany(page);
    await expectBoundedPickers(page);
  });

  test('a transient discover 429 recovers on retry, and Step 2 waits it out (spec 226)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { getDiscoverBCalls } = await setupDiscoverRetry(page, 'flaky-429');
    await page.getByText('E2E Account 1', { exact: true }).click();
    await page.getByText('E2E Account 2', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue (2 accounts)' }).click();
    // The gate holds through the retry: the Continue button is still
    // finding pages and Step 2 is not rendered yet — the fast
    // account's pages must not appear before the retrying account
    // settles. ('Finding Facebook Pages...' is NOT the signal here:
    // it only renders on a manual retry from Step 2, while the
    // Continue flow discovers with Step 1 still showing and the
    // button reading 'Finding pages...'.)
    await expect(page.getByRole('button', { name: 'Finding pages...' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Select pages' })).toHaveCount(0);
    // Once the retry lands, Step 2 shows both accounts' pages with
    // no error and no manual Retry clicked.
    await expect(page.getByRole('heading', { name: 'Select pages' })).toBeVisible();
    await expect(page.getByText('E2E Page A1')).toBeVisible();
    await expect(page.getByText('E2E Page B1')).toBeVisible();
    await expect(
      page.getByText(/Facebook was busy|check the account connection/),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Retry finding pages/ })).toHaveCount(0);
    // Exactly two discover calls for B: the failed attempt + retry.
    expect(getDiscoverBCalls()).toBe(2);
  });

  test('a discover 500 that never clears ends in the busy message, not the connection message (spec 226)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { getDiscoverBCalls } = await setupDiscoverRetry(page, 'always-500');
    await page.getByText('E2E Account 1', { exact: true }).click();
    await page.getByText('E2E Account 2', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue (2 accounts)' }).click();
    await expect(page.getByRole('heading', { name: 'Select pages' })).toBeVisible();
    await expect(page.getByText('E2E Page A1')).toBeVisible();
    await expect(page.getByText(/Facebook was busy/)).toBeVisible();
    await expect(page.getByText(/check the account connection/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Retry finding pages/ })).toBeVisible();
    // Exactly three attempts: initial + two retries, then it stops.
    expect(getDiscoverBCalls()).toBe(3);
  });
});
