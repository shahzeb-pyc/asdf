/**
 * Creator Finder daily cap at 360px: the usage display and the
 * blocked message on a real phone-width page.
 *
 * SCOPE (honest): the e2e webServer runs with dummy env, so the
 * API routes are intercepted at the browser boundary and answer
 * from fixtures — what runs for real is the production build,
 * the page, and the client code path that turns the 429 flag
 * into the distinct blocked message. The server-side gate itself
 * (99 allowed / 100 blocked / mid-flight completion) is covered
 * by the vitest route tests in tests/api/creator-finder-cap.test.ts,
 * which run the real gate helper against a fake database.
 *
 * Follows the billing-mobile pattern: the desktop project with
 * the viewport set explicitly per test, so CSS media queries
 * genuinely exercise the phone layout.
 */
import { test, expect } from '@playwright/test';

import { expectNoDocumentOverflow } from './fixtures/mobile';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

const SUB = TENANT.subdomain;
const NOTE =
  "This limit is temporary — I'll increase it later if you guys like this feature.";

async function installCreatorFinderFixtures(
  page: import('@playwright/test').Page,
  opts: {
    used: number;
    trendingStatus: number;
    trendingCreators?: Array<Record<string, unknown>>;
    enrichDelayMs?: number;
  },
) {
  await page.route(`**/api/tenant/${SUB}/creator-finder/regions`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        regions: [
          { code: 'PK', name: 'Pakistan' },
          { code: 'US', name: 'United States' },
        ],
        defaultRegion: 'PK',
      }),
    }),
  );
  await page.route(`**/api/tenant/${SUB}/creator-finder/saved*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        creators: [],
        total: 0,
        page: 1,
        pageSize: 30,
        totalPages: 0,
      }),
    }),
  );
  await page.route(`**/api/tenant/${SUB}/creator-finder/usage`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        used: opts.used,
        limit: 100,
        date: '2026-11-01',
      }),
    }),
  );
  await page.route(`**/api/tenant/${SUB}/creator-finder/trending*`, (route) =>
    route.fulfill({
      status: opts.trendingStatus,
      contentType: 'application/json',
      body: JSON.stringify(
        opts.trendingStatus === 429
          ? {
              error: 'DAILY_LIMIT_EXCEEDED',
              message: 'Daily limit exceeded',
              dailyLimitExceeded: true,
            }
          : {
              region: 'PK',
              creators: opts.trendingCreators ?? [],
              videosSeen: 0,
            },
      ),
    }),
  );
  await page.route(
    `**/api/tenant/${SUB}/creator-finder/enrich`,
    async (route) => {
      if (opts.enrichDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, opts.enrichDelayMs),
        );
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          creators: [
            {
              handle: 'alice',
              displayName: 'Alice Fit',
              avatarUrl: null,
              latestVideoTitle: null,
              latestVideoCover: null,
              profileUrl: 'https://www.tiktok.com/@alice',
              enrichment: {
                bio: 'Fitness creator',
                followerCount: 12400,
                verified: true,
                hashtags: [],
                mentions: [],
              },
            },
          ],
          saveFailed: false,
        }),
      });
    },
  );
}

/**
 * Return-first flow (spec 169): the search answers with basic
 * creators at once and the enrich call fills in the details after.
 * The enrich answer is delayed so the basic card is observably on
 * screen before the details fill in.
 */
async function searchFillsInDetails(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
) {
  await context.addCookies([
    { ...SESSION_COOKIE, value: mintSessionToken('user') },
  ]);
  await installCreatorFinderFixtures(page, {
    used: 0,
    trendingStatus: 200,
    trendingCreators: [
      {
        handle: 'alice',
        displayName: 'Alice Fit',
        avatarUrl: null,
        latestVideoTitle: null,
        latestVideoCover: null,
        profileUrl: 'https://www.tiktok.com/@alice',
      },
    ],
    enrichDelayMs: 500,
  });
  await page.goto(`/tenant/${SUB}/creator-finder`);

  await page.getByRole('button', { name: 'Find trending creators' }).click();

  await expect(page.getByText('@alice')).toBeVisible();
  await expect(
    page.getByText('Details unavailable for this creator.'),
  ).toBeVisible();
  await expect(page.getByText('Fitness creator')).toBeVisible();
  await expect(page.getByText('12.4K followers')).toBeVisible();
  await expect(
    page.getByText('Details unavailable for this creator.'),
  ).toHaveCount(0);
  await expectNoDocumentOverflow(page);
}

test.describe('Creator Finder daily cap at 360px', () => {
  test.use({ viewport: { width: 360, height: 720 } });

  test('usage display shows today’s count and the temporary note', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { ...SESSION_COOKIE, value: mintSessionToken('user') },
    ]);
    await installCreatorFinderFixtures(page, { used: 37, trendingStatus: 200 });
    await page.goto(`/tenant/${SUB}/creator-finder`);

    await expect(page.getByText('37 of 100 used today')).toBeVisible();
    await expect(page.getByText(NOTE).first()).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('a blocked search shows “Daily limit exceeded” plus the note', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { ...SESSION_COOKIE, value: mintSessionToken('user') },
    ]);
    await installCreatorFinderFixtures(page, {
      used: 100,
      trendingStatus: 429,
    });
    await page.goto(`/tenant/${SUB}/creator-finder`);

    const findButton = page.getByRole('button', {
      name: 'Find trending creators',
    });
    await expect(findButton).toBeEnabled();
    await findButton.click();

    const blocked = page
      .getByRole('alert')
      .filter({ hasText: 'Daily limit exceeded' });
    await expect(blocked).toBeVisible();
    await expect(blocked.getByText(NOTE)).toBeVisible();
    // No generic search-error banner alongside the cap block.
    await expect(page.getByText("Couldn't find creators")).toHaveCount(0);
    await expectNoDocumentOverflow(page);
  });

  test('a search shows basic cards first, then fills in details (spec 169)', async ({
    page,
    context,
  }) => {
    await searchFillsInDetails(page, context);
  });
});

test.describe('Creator Finder return-first enrichment at desktop width', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a search shows basic cards first, then fills in details (spec 169)', async ({
    page,
    context,
  }) => {
    await searchFillsInDetails(page, context);
  });
});
