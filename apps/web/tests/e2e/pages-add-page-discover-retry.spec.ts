/**
 * Pages Add Page dialog discover retry (spec 226): a transient
 * discover failure is retried inside the dialog, and the pages step
 * waits out the retries — so a 429 or a Graph timeout no longer
 * shows the "check the account connection" error for an account
 * whose connection is fine.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the routes registered below — after the
 * shared fixtures, so they take precedence — serve the pages list
 * and the live-discover call. The discover handler is scripted per
 * test: it fails once with a 429 (retryAfterSeconds 1), then
 * succeeds — or fails every time with a 500. No live network, no
 * real backend. The production build itself (routing, middleware
 * session verification, tenant layout, components) runs for real.
 *
 * The recovery is observed, not asserted from markup: with the 429,
 * the pages list shows with no error and no manual Retry clicked,
 * and the discover route was hit exactly twice (failed attempt +
 * retry). With the persistent 500, the step shows the busy message
 * — never the connection message — with its Retry button.
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

const FIVE_PAGES = [
  fixturePage({ id: 'a1111111-1111-4111-8111-111111111111', pageName: 'Alpha Reels', fbPageId: '100000000000011', status: 'active', createdAt: '2026-10-01T00:00:00.000Z' }),
  fixturePage({ id: 'a2222222-2222-4222-8222-222222222222', pageName: 'Beta Paused', fbPageId: '100000000000012', status: 'paused', createdAt: '2026-10-02T00:00:00.000Z' }),
  fixturePage({ id: 'a3333333-3333-4333-8333-333333333333', pageName: 'Gamma Expired', fbPageId: '100000000000013', status: 'invalid_token', createdAt: '2026-10-03T00:00:00.000Z' }),
  fixturePage({ id: 'a4444444-4444-4444-8444-444444444444', pageName: 'Delta Daily', fbPageId: '100000000000014', status: 'active', createdAt: '2026-10-04T00:00:00.000Z' }),
  fixturePage({ id: 'a5555555-5555-4555-8555-555555555555', pageName: 'Epsilon Eats', fbPageId: '100000000000015', status: 'active', createdAt: '2026-10-05T00:00:00.000Z' }),
];

/**
 * Registers the pages list and a scripted discover route.
 * `discover` scripts the discover: 'flaky-429' fails the first call
 * with a 429 (retryAfterSeconds 1) then succeeds; 'always-500' fails
 * every call with a 500. Returns the discover call count, read after
 * the assertions.
 */
async function installDialogFixtures(
  page: Page,
  discover: 'flaky-429' | 'always-500',
) {
  const state = createFixtureState({ accounts: [CONNECTED_ACCOUNT] });
  await installApiFixtures(page, state);
  // Registered after the shared fixtures so these take precedence.
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/pages`,
    (route) => {
      const { items, total, page: pageNum, limit, totalPages } =
        paginateFixtureList(route, FIVE_PAGES, () => true);
      return json(route, { pages: items, total, page: pageNum, limit, totalPages });
    }
  );
  let calls = 0;
  await page.route(
    (url) =>
      url.pathname ===
      `/api/tenant/${SUB}/accounts/${CONNECTED_ACCOUNT.id}/pages/discover`,
    (route) => {
      calls += 1;
      if (discover === 'always-500') {
        return json(route, { error: 'Failed to query Facebook Graph API' }, 500);
      }
      if (discover === 'flaky-429' && calls === 1) {
        return json(
          route,
          {
            error: 'Too many requests. Please wait 1 seconds before trying again.',
            retryAfterSeconds: 1,
          },
          429
        );
      }
      return json(route, {
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
      });
    }
  );
  return {
    get calls() {
      return calls;
    },
  };
}

async function openDiscover(page: Page) {
  await page.goto(`/tenant/${SUB}/inapp-schedule`);
  await page.getByTestId('header-add-page-btn').click();
  await expect(page.getByTestId('add-page-modal')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`select-account-${CONNECTED_ACCOUNT.id}`).click();
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`Pages Add Page discover retry — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
    });

    test('a 429 recovers by retry — the pages show, no error', async ({ page }) => {
      const fixture = await installDialogFixtures(page, 'flaky-429');
      await openDiscover(page);
      // The page shows with no error and no manual Retry clicked.
      await expect(page.getByTestId('discovered-pages-list')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Discovered Page', { exact: true })).toBeVisible();
      await expect(page.getByTestId('discover-error-state')).toHaveCount(0);
      // The retry happened: the failed first attempt + the retry.
      expect(fixture.calls).toBe(2);
    });

    test('a 500 that never clears shows the busy message, not the connection message', async ({ page }) => {
      const fixture = await installDialogFixtures(page, 'always-500');
      await openDiscover(page);
      // The failing discover shows the busy message with its Retry
      // button — never the "check the account connection" message.
      const error = page.getByTestId('discover-error-state');
      await expect(error).toBeVisible({ timeout: 15_000 });
      await expect(error).toContainText(
        "Facebook was busy and couldn't load this account's pages. Please try again."
      );
      await expect(page.getByText(/check the account connection/)).toHaveCount(0);
      await expect(page.getByTestId('discover-retry-btn')).toBeVisible();
      // Exactly three attempts: initial + two retries, then it stops.
      expect(fixture.calls).toBe(3);
    });
  });
}
