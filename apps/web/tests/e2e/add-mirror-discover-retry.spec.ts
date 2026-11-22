/**
 * Auto Repost Add dialog discover retry (spec 227): a transient
 * discover failure is retried inside the dialog's `useQuery`, and
 * the dialog stays in its "Finding Facebook Pages..." state through
 * the retries — so a single 429/5xx/timeout no longer shows the
 * "check the account connection" error for an account whose
 * connection is fine.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the routes registered below — after the
 * shared fixtures, so they take precedence — serve the mirrors list
 * and the live-discover call. The discover handler is scripted per
 * test: it fails once with a 429 (retryAfterSeconds 1), then
 * succeeds — or fails every time with a 500 / a 403. No live
 * network, no real backend. The production build itself (routing,
 * middleware session verification, tenant layout, components) runs
 * for real.
 *
 * The recovery is observed, not asserted from markup: with the 429,
 * the pages list shows both pages with no error banner and no
 * manual Retry clicked, and the discover route was hit exactly
 * twice (failed attempt + retry). With the persistent 500, the
 * banner shows the busy message — never the connection message —
 * and the route was hit exactly three times. With a 403, the
 * connection message stays and the route was hit exactly once.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const MIRROR_ID = '44444444-4444-4444-a444-444444444444';
const DEST_ID = '33333333-3333-4333-a333-333333333333';
const SUB = TENANT.subdomain;

function discoverPayload() {
  return {
    accountId: ACCOUNT_ID,
    accountDisplayName: 'E2E FB Account',
    pages: [
      {
        fbPageId: '749557154917108',
        pageName: 'Alpha Page',
        profilePictureUrl: null,
        category: 'Tech',
        currentFollowers: 12000,
        followersCount: 12000,
        tasks: [],
        isImported: false,
      },
      {
        fbPageId: '123456789012345',
        pageName: 'Beta Bakery',
        profilePictureUrl: null,
        category: 'Food',
        currentFollowers: 350,
        followersCount: 350,
        tasks: [],
        isImported: false,
      },
    ],
    total: 2,
    truncated: false,
    partial: false,
    droppedCount: 0,
  };
}

function mirrorView() {
  return {
    id: MIRROR_ID,
    sourcePlatform: 'tiktok',
    targetPlatform: 'facebook',
    targetExternalId: '749557154917108',
    targetDestinationId: DEST_ID,
    targetDisplayName: 'E2E Test Page',
    targetAvatarUrl: null,
    sourceUsername: 'alice',
    sourceDisplayName: 'Alice',
    sourceAvatarUrl: null,
    status: 'active',
    lastPostedSourceId: 'v1',
    lastCheckedAt: '2026-10-29T11:00:00.000Z',
    nextCheckAt: '2026-10-29T12:00:00.000Z',
    lastError: null,
    targetAddedAt: '2026-11-02T00:00:00.000Z',
    targetFollowers: 0,
    targetCategory: 'Digital creator',
    targetAccountDisplayName: 'E2E FB Account',
    postCounts: { posted: 1, failed: 0 },
    postCountsError: false,
    lastMirroredPost: null,
    createdAt: '2026-10-29T00:00:00.000Z',
  };
}

/**
 * Registers the mirrors list and the scripted discover route.
 * `discover` scripts the discover call: 'flaky-429' fails the
 * first call with a 429 (retryAfterSeconds 1) then succeeds;
 * 'always-500' / 'always-403' fail every call. Returns the
 * discover call count, read after the assertions.
 */
async function installDialogFixtures(
  page: import('@playwright/test').Page,
  discover: 'flaky-429' | 'always-500' | 'always-403',
) {
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/tiktok-mirrors`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mirrors: [mirrorView()],
          total: 1,
          page: 1,
          limit: 30,
          totalPages: 1,
        }),
      }),
  );
  let calls = 0;
  await page.route(
    (url) =>
      url.pathname ===
      `/api/tenant/${SUB}/accounts/${ACCOUNT_ID}/pages/discover`,
    (route) => {
      calls += 1;
      if (discover === 'always-500') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Failed to query Facebook Graph API' }),
        });
      }
      if (discover === 'always-403') {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forbidden' }),
        });
      }
      if (discover === 'flaky-429' && calls === 1) {
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
        body: JSON.stringify(discoverPayload()),
      });
    },
  );
  return () => calls;
}

/** Opens the dialog and picks the account, landing on the pages step. */
async function openPagesStep(page: import('@playwright/test').Page) {
  await page.goto(`/tenant/${SUB}/tiktok-mirrors`);
  await expect(page.getByTestId('tiktok-mirrors-grid')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('header-add-mirror-btn').click();
  await expect(page.getByTestId('add-mirror-dialog')).toBeVisible();
  await page.getByTestId(`select-account-${ACCOUNT_ID}`).click();
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`Auto Repost Add dialog discover retry — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      await installApiFixtures(
        page,
        createFixtureState({
          accounts: [
            {
              id: ACCOUNT_ID,
              fbAccountId: 'fb_user_1',
              displayName: 'E2E FB Account',
              profilePictureUrl: null,
              status: 'active',
              tokenExpiresAt: null,
              connectedPagesCount: 2,
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        }),
      );
    });

    test('a 429 recovers by retry — pages show, no error', async ({ page }) => {
      const discoverCalls = await installDialogFixtures(page, 'flaky-429');
      await openPagesStep(page);
      // The 429'd discover recovers on retry: both pages list, no
      // error banner ever renders, with no manual Retry clicked.
      await expect(page.getByTestId('add-mirror-pages-list')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Alpha Page', { exact: true })).toBeVisible();
      await expect(page.getByText('Beta Bakery', { exact: true })).toBeVisible();
      await expect(page.getByTestId('add-mirror-error')).toHaveCount(0);
      // The retry happened: the failed first attempt + the retry.
      expect(discoverCalls()).toBe(2);
    });

    test('a 500 that never clears shows the busy message, not the connection message', async ({
      page,
    }) => {
      const discoverCalls = await installDialogFixtures(page, 'always-500');
      await openPagesStep(page);
      const error = page.getByTestId('add-mirror-error');
      await expect(error).toBeVisible({ timeout: 15_000 });
      await expect(error).toContainText(
        "Facebook was busy and couldn't load this account's pages.",
      );
      await expect(page.getByText(/check the account connection/)).toHaveCount(0);
      // Exactly three attempts: initial + two retries, then it stops.
      expect(discoverCalls()).toBe(3);
    });

    test('an auth-dead 403 is not retried and keeps the connection message', async ({
      page,
    }) => {
      const discoverCalls = await installDialogFixtures(page, 'always-403');
      await openPagesStep(page);
      const error = page.getByTestId('add-mirror-error');
      await expect(error).toBeVisible({ timeout: 15_000 });
      await expect(error).toContainText('check the account connection');
      // A dead token is tried exactly once — retrying it cannot help.
      expect(discoverCalls()).toBe(1);
    });
  });
}
