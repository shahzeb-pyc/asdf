/**
 * Publish Now discover retry (spec 226): a transient discover
 * failure is retried inside the picker, and the pages view waits
 * out the retries — so a burst 429 or a Graph timeout no longer
 * shows the "check the account connection" error for an account
 * whose connection is fine. After the wait every selected
 * account's pages are listed.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, the accounts list (seeded below), and the BYOC
 * settings, and the routes registered below — after the shared
 * fixtures, so they take precedence — serve the live-discover call
 * per account. The discover handler for account B is scripted per
 * test: it fails once with a 429 (retryAfterSeconds 1), then
 * succeeds — or fails every time with a 500. No live network, no
 * real backend. The production build itself (routing, middleware
 * session verification, tenant layout, components) runs for real.
 *
 * The recovery is observed, not asserted from markup: with the 429,
 * the pages view shows all five pages from both accounts with no
 * error banner and no manual Retry clicked, and the discover route
 * for B was hit exactly twice (failed attempt + retry). With the
 * persistent 500, the pages view shows the busy message — never the
 * connection message — and A's pages stay listed.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

const ACCOUNTS = [
  {
    id: ACCOUNT_A,
    fbAccountId: 'fb-acc-1',
    displayName: 'Shahzeb Malik',
    profilePictureUrl: null,
    status: 'active',
    tokenExpiresAt: null,
    connectedPagesCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: ACCOUNT_B,
    fbAccountId: 'fb-acc-2',
    displayName: 'Example Account',
    profilePictureUrl: null,
    status: 'active',
    tokenExpiresAt: null,
    connectedPagesCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

function discoverPayload(accountId: string, accountName: string, pages: { fbPageId: string; pageName: string }[]) {
  return {
    accountId,
    accountDisplayName: accountName,
    pages: pages.map((p) => ({
      fbPageId: p.fbPageId,
      pageName: p.pageName,
      profilePictureUrl: null,
      category: 'Digital creator',
      currentFollowers: 10,
      followersCount: 10,
      tasks: [],
      isImported: false,
    })),
    total: pages.length,
    truncated: false,
    partial: false,
    droppedCount: 0,
  };
}

const PAGES_A = [
  { fbPageId: 'fb-page-101', pageName: 'Ellie Blossom' },
  { fbPageId: 'fb-page-102', pageName: 'UK Videos' },
  { fbPageId: 'fb-page-105', pageName: 'No Category Page' },
];
const PAGES_B = [
  { fbPageId: 'fb-page-103', pageName: 'Example Page' },
  { fbPageId: 'fb-page-108', pageName: 'Shared Page' },
];

/**
 * Registers the per-account discover routes. `discoverB` scripts
 * account B's discover: 'flaky-429' fails the first call with a 429
 * (retryAfterSeconds 1) then succeeds; 'always-500' fails every call
 * with a 500. Returns the per-account discover call counts, read
 * after the assertions.
 */
async function installDiscoverFixtures(
  page: import('@playwright/test').Page,
  discoverB: 'flaky-429' | 'always-500',
) {
  const calls: Record<string, number> = { [ACCOUNT_A]: 0, [ACCOUNT_B]: 0 };
  for (const [accountId, accountName, pages] of [
    [ACCOUNT_A, 'Shahzeb Malik', PAGES_A],
    [ACCOUNT_B, 'Example Account', PAGES_B],
  ] as const) {
    await page.route(
      (url) =>
        url.pathname ===
        `/api/tenant/${TENANT.subdomain}/accounts/${accountId}/pages/discover`,
      (route) => {
        calls[accountId] += 1;
        if (accountId === ACCOUNT_B && discoverB === 'always-500') {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Failed to query Facebook Graph API' }),
          });
        }
        if (accountId === ACCOUNT_B && discoverB === 'flaky-429' && calls[accountId] === 1) {
          return route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'Too many requests. Please wait 1 seconds before trying again.',
              retryAfterSeconds: 1,
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(discoverPayload(accountId, accountName, pages)),
        });
      },
    );
  }
  return calls;
}

/** Opens the picker, picks both accounts, and walks to the pages view. */
async function openPagesView(page: import('@playwright/test').Page) {
  await page.goto(`/tenant/${TENANT.subdomain}/publish-now`);
  await expect(page.getByText('Shahzeb Malik', { exact: true })).toBeVisible();
  await page.getByText('Shahzeb Malik', { exact: true }).click();
  await page.getByText('Example Account', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue (2 accounts)' }).click();
  await expect(page.getByRole('heading', { name: 'Select pages' })).toBeVisible();
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`Publish Now discover retry — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState({ accounts: ACCOUNTS });
      await installApiFixtures(page, state);
    });

    test('a 429 on one account recovers by retry — every page shows, no error', async ({ page }) => {
      const calls = await installDiscoverFixtures(page, 'flaky-429');
      await openPagesView(page);
      // Every page from both accounts is listed — nothing missing
      // because a discover was still trying — and no error banner
      // ever rendered, with no manual Retry clicked.
      await expect(page.getByText('5 pages found')).toBeVisible();
      for (const name of ['Ellie Blossom', 'UK Videos', 'No Category Page', 'Example Page', 'Shared Page']) {
        await expect(page.getByText(name, { exact: true })).toBeVisible();
      }
      await expect(page.getByTestId('publish-now-error')).toHaveCount(0);
      // The retry happened: the failed first attempt + the retry.
      expect(calls[ACCOUNT_B]).toBe(2);
      expect(calls[ACCOUNT_A]).toBe(1);
    });

    test('a 500 that never clears shows the busy message, not the connection message', async ({ page }) => {
      const calls = await installDiscoverFixtures(page, 'always-500');
      await openPagesView(page);
      // The healthy account's pages stay listed.
      await expect(page.getByText('Ellie Blossom')).toBeVisible();
      await expect(page.getByText('UK Videos')).toBeVisible();
      // The failing account shows the busy message — never the
      // "check the account connection" message.
      const error = page.getByTestId('publish-now-error');
      await expect(error).toBeVisible();
      await expect(error).toContainText("Facebook was busy and couldn't load this account's pages.");
      await expect(page.getByText(/check the account connection/)).toHaveCount(0);
      // Exactly three attempts: initial + two retries, then it stops.
      expect(calls[ACCOUNT_B]).toBe(3);
    });
  });
}
