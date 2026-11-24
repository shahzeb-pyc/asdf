/**
 * Analytics page in a real browser (spec 241, plan test 12): the
 * combined page renders every mockup section from the stored-columns
 * aggregate, the 1/7/28-day switcher changes every value, and the
 * empty states show instead of fabricated numbers — at desktop width
 * and at 360px.
 *
 * SCOPE (honest): the e2e webServer runs with dummy env, so the real
 * aggregate route cannot reach a database here. What this spec
 * genuinely covers is the production build — routing, middleware
 * session verification, the tenant layout, the page components and
 * the client period/workspace switching — against fixture aggregate
 * responses served at the browser boundary (the same values the
 * vitest render contract uses in analytics-page.test.tsx). The
 * server-side aggregation itself is covered by route.test.ts and
 * aggregate.test.ts against a real database instead.
 *
 * Follows the billing-mobile / home-dashboard pattern: the desktop
 * project with the viewport set explicitly per describe, so CSS media
 * queries genuinely exercise the phone layout.
 */
import { test, expect, type Page } from '@playwright/test';

import { createFixtureState, installApiFixtures } from './fixtures/api';
import { expectNoDocumentOverflow, expectWithinViewport } from './fixtures/mobile';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

const WS_E2E = '44444444-4444-4444-8444-444444444444';

const WORKSPACES = {
  workspaces: [
    {
      id: WS_E2E,
      ownerId: TENANT.userId,
      name: 'E2E Workspace',
      subdomain: TENANT.subdomain,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

type ChartPoint = { date: string; mediaViews: number; uniqueViewers: number };

function chartPoints(days: number, mediaPerDay: number, viewersPerDay: number): ChartPoint[] {
  const points: ChartPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(2026, 10, 22 - i));
    points.push({
      date: date.toISOString().slice(0, 10),
      mediaViews: mediaPerDay + i,
      uniqueViewers: viewersPerDay + i,
    });
  }
  return points;
}

/**
 * Aggregate fixture, mirroring analytics-page.test.tsx (same mockup
 * example values). The aggregate route answers by `period`; the
 * workspace picker answers `all` with the all-workspaces roll-up.
 */
const FIXTURES = {
  '28': {
    success: true,
    workspace: WS_E2E,
    period: '28',
    dateRangeLabel: '26 Oct – 22 Nov 2026',
    periodLabel: 'Last 28 days · combined',
    pagesIncluded: 5,
    updatedAt: '2026-11-23T03:12:00.000Z',
    followers: { total: 60975, gained: 59803 },
    mediaViews: 590700,
    uniqueViewers: 250100,
    profileViews: 13600,
    engagement: 43740,
    videoViews: 458000,
    videoCompleteViews30s: 101000,
    watchTimeMs: 372 * 3_600_000,
    totalActions: 7600,
    newFollows: 6100,
    unfollows: 1370,
    netFollows: 4730,
    chart: chartPoints(28, 21000, 8900),
    topCountries: [
      { name: 'Pakistan', count: 40244, sharePct: 66 },
      { name: 'United States', count: 7927, sharePct: 13 },
      { name: 'United Kingdom', count: 3659, sharePct: 6 },
      { name: 'India', count: 2439, sharePct: 4 },
      { name: 'Bangladesh', count: 1829, sharePct: 3 },
      { name: 'Australia', count: 1219, sharePct: 2 },
    ],
    topCities: [
      { name: 'Karachi', count: 13415, sharePct: 22 },
      { name: 'Lahore', count: 8537, sharePct: 14 },
      { name: 'Islamabad', count: 4878, sharePct: 8 },
      { name: 'New York', count: 3659, sharePct: 6 },
      { name: 'Dhaka', count: 2439, sharePct: 4 },
      { name: 'London', count: 1829, sharePct: 3 },
    ],
    hasNoData: false,
  },
  '7': {
    success: true,
    workspace: WS_E2E,
    period: '7',
    dateRangeLabel: '16 – 22 Nov 2026',
    periodLabel: 'Last 7 days · combined',
    pagesIncluded: 5,
    updatedAt: '2026-11-23T03:12:00.000Z',
    followers: { total: 60975, gained: 59803 },
    mediaViews: 147650,
    uniqueViewers: 69750,
    profileViews: 3400,
    engagement: 10900,
    videoViews: 114000,
    videoCompleteViews30s: 25300,
    watchTimeMs: 93 * 3_600_000,
    totalActions: 1900,
    newFollows: 1480,
    unfollows: 340,
    netFollows: 1140,
    chart: chartPoints(7, 21000, 9900),
    topCountries: [
      { name: 'Pakistan', count: 40244, sharePct: 66 },
      { name: 'United States', count: 7927, sharePct: 13 },
      { name: 'United Kingdom', count: 3659, sharePct: 6 },
      { name: 'India', count: 2439, sharePct: 4 },
      { name: 'Bangladesh', count: 1829, sharePct: 3 },
      { name: 'Australia', count: 1219, sharePct: 2 },
    ],
    topCities: [
      { name: 'Karachi', count: 13415, sharePct: 22 },
      { name: 'Lahore', count: 8537, sharePct: 14 },
      { name: 'Islamabad', count: 4878, sharePct: 8 },
      { name: 'New York', count: 3659, sharePct: 6 },
      { name: 'Dhaka', count: 2439, sharePct: 4 },
      { name: 'London', count: 1829, sharePct: 3 },
    ],
    hasNoData: false,
  },
  '1': {
    success: true,
    workspace: WS_E2E,
    period: '1',
    dateRangeLabel: '22 Nov 2026',
    periodLabel: 'Yesterday · combined',
    pagesIncluded: 5,
    updatedAt: '2026-11-23T03:12:00.000Z',
    followers: { total: 60975, gained: 59803 },
    mediaViews: 20260,
    uniqueViewers: 11580,
    profileViews: 591,
    engagement: 1461,
    videoViews: 15800,
    videoCompleteViews30s: 3600,
    watchTimeMs: 13 * 3_600_000,
    totalActions: 265,
    newFollows: 210,
    unfollows: 48,
    netFollows: 162,
    chart: chartPoints(1, 20260, 11580),
    topCountries: [
      { name: 'Pakistan', count: 40244, sharePct: 66 },
      { name: 'United States', count: 7927, sharePct: 13 },
      { name: 'United Kingdom', count: 3659, sharePct: 6 },
      { name: 'India', count: 2439, sharePct: 4 },
      { name: 'Bangladesh', count: 1829, sharePct: 3 },
      { name: 'Australia', count: 1219, sharePct: 2 },
    ],
    topCities: [
      { name: 'Karachi', count: 13415, sharePct: 22 },
      { name: 'Lahore', count: 8537, sharePct: 14 },
      { name: 'Islamabad', count: 4878, sharePct: 8 },
      { name: 'New York', count: 3659, sharePct: 6 },
      { name: 'Dhaka', count: 2439, sharePct: 4 },
      { name: 'London', count: 1829, sharePct: 3 },
    ],
    hasNoData: false,
  },
  all: {
    success: true,
    workspace: 'all',
    period: '28',
    dateRangeLabel: '26 Oct – 22 Nov 2026',
    periodLabel: 'Last 28 days · combined',
    pagesIncluded: 5,
    updatedAt: '2026-11-23T03:12:00.000Z',
    followers: { total: 72000, gained: 61000 },
    mediaViews: 700000,
    uniqueViewers: 300000,
    profileViews: 13600,
    engagement: 43740,
    videoViews: 458000,
    videoCompleteViews30s: 101000,
    watchTimeMs: 372 * 3_600_000,
    totalActions: 7600,
    newFollows: 6100,
    unfollows: 1370,
    netFollows: 4730,
    chart: chartPoints(28, 21000, 8900),
    topCountries: [
      { name: 'Pakistan', count: 40244, sharePct: 66 },
      { name: 'United States', count: 7927, sharePct: 13 },
      { name: 'United Kingdom', count: 3659, sharePct: 6 },
      { name: 'India', count: 2439, sharePct: 4 },
      { name: 'Bangladesh', count: 1829, sharePct: 3 },
      { name: 'Australia', count: 1219, sharePct: 2 },
    ],
    topCities: [
      { name: 'Karachi', count: 13415, sharePct: 22 },
      { name: 'Lahore', count: 8537, sharePct: 14 },
      { name: 'Islamabad', count: 4878, sharePct: 8 },
      { name: 'New York', count: 3659, sharePct: 6 },
      { name: 'Dhaka', count: 2439, sharePct: 4 },
      { name: 'London', count: 1829, sharePct: 3 },
    ],
    hasNoData: false,
  },
  empty: {
    success: true,
    workspace: WS_E2E,
    period: '28',
    dateRangeLabel: '',
    periodLabel: 'Last 28 days · combined',
    pagesIncluded: 0,
    updatedAt: null,
    followers: { total: 0, gained: 0 },
    mediaViews: 0,
    uniqueViewers: 0,
    profileViews: 0,
    engagement: 0,
    videoViews: 0,
    videoCompleteViews30s: 0,
    watchTimeMs: 0,
    totalActions: 0,
    newFollows: 0,
    unfollows: 0,
    netFollows: 0,
    chart: [],
    topCountries: [],
    topCities: [],
    hasNoData: true,
  },
} as const;

async function openAnalytics(page: Page, mode: 'full' | 'empty' = 'full'): Promise<void> {
  await page.context().addCookies([{ ...SESSION_COOKIE, value: mintSessionToken('user') }]);
  const state = createFixtureState();
  await installApiFixtures(page, state);
  // The page reads the workspace list before the aggregate query is
  // enabled, so the catch-all empty object would fail schema
  // validation and land on the error state — intercept it explicitly,
  // like the workspace-switcher spec does.
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(WORKSPACES),
    });
  });
  await page.route(
    (url) => url.pathname === `/api/tenant/${TENANT.subdomain}/analytics`,
    (route) => {
      const params = new URL(route.request().url()).searchParams;
      const period = params.get('period');
      const workspace = params.get('workspace');
      let body: unknown;
      if (mode === 'empty') body = FIXTURES.empty;
      else if (workspace === 'all') body = FIXTURES.all;
      else if (period === '7') body = FIXTURES['7'];
      else if (period === '1') body = FIXTURES['1'];
      else body = FIXTURES['28'];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    },
  );
  await page.goto(`/tenant/${TENANT.subdomain}/analytics`);
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  await expect(page.getByText("Couldn't load analytics.")).toHaveCount(0);
}

/** Every value the 28-day fixture shows, in one place. */
async function expect28DayValues(page: Page): Promise<void> {
  await expect(page.getByText('60,975')).toBeVisible();
  await expect(page.getByText('+59,803')).toBeVisible();
  await expect(page.getByText('590,700')).toBeVisible();
  await expect(page.getByText('250,100')).toBeVisible();
  await expect(page.getByText('458,000')).toBeVisible();
  await expect(page.getByText('101,000')).toBeVisible();
  await expect(page.getByText(/^372 hours$/)).toBeVisible();
  await expect(page.getByText('43,740')).toBeVisible();
  await expect(page.getByText('13,600')).toBeVisible();
  await expect(page.getByText('7,600')).toBeVisible();
  await expect(page.getByText('+4,730')).toBeVisible();
  await expect(page.getByText('6,100')).toBeVisible();
  await expect(page.getByText('1,370')).toBeVisible();
  // exact: true — the chart subtitle ("Daily · 26 Oct – 22 Nov 2026")
  // also contains the range.
  await expect(page.getByText('26 Oct – 22 Nov 2026', { exact: true })).toBeVisible();
  await expect(page.getByText('Last 28 days · combined')).toBeVisible();
}

test.describe('Analytics page at desktop width (spec 241)', () => {
  test('renders every mockup section; the 1/7/28-day switcher changes every value', async ({
    page,
  }) => {
    await openAnalytics(page);

    // Workspace picker defaults to the current workspace. exact: true
    // — the sidebar switcher trigger ("Workspace and profile menu")
    // also matches the loose label.
    await expect(page.getByLabel('Workspace', { exact: true })).toHaveValue(WS_E2E);
    await expect(
      page.getByRole('option', { name: 'E2E Workspace — current workspace' }),
    ).toHaveCount(1);

    // Audience overview: hero strip + locations.
    await expect(
      page.getByRole('heading', { name: 'Audience overview' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top countries' })).toBeVisible();
    await expect(page.getByText('Pakistan')).toBeVisible();
    await expect(page.getByText('40,244')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top cities' })).toBeVisible();
    await expect(page.getByText('Karachi')).toBeVisible();
    await expect(page.getByText('13,415')).toBeVisible();

    // Performance bar + Views & reach.
    await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Media views & unique viewers over time' }),
    ).toBeVisible();
    await expect(
      page.getByRole('img', { name: /Line chart of combined daily media views.*590,700/ }),
    ).toBeVisible();

    // Video funnel + watch time.
    await expect(page.getByRole('heading', { name: 'Video' })).toBeVisible();
    await expect(page.getByText('Watch time')).toBeVisible();

    // Interactions ledger + Follows net-first.
    await expect(page.getByRole('heading', { name: 'Interactions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Follows' })).toBeVisible();
    await expect(page.getByText('Net follows')).toBeVisible();
    await expect(page.getByText('82% of movement')).toBeVisible();
    await expect(page.getByText('18% of movement')).toBeVisible();
    await expect(
      page.getByText("Facebook's count in the period — not the gained number"),
    ).toBeVisible();

    await expect28DayValues(page);

    // 7 days: every value swaps (keepPreviousData keeps the old ones
    // visible until the refetch lands — the text assertions wait).
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page.getByText('147,650')).toBeVisible();
    await expect(page.getByText('69,750')).toBeVisible();
    await expect(page.getByText('114,000')).toBeVisible();
    await expect(page.getByText('25,300')).toBeVisible();
    await expect(page.getByText(/^93 hours$/)).toBeVisible();
    await expect(page.getByText('10,900')).toBeVisible();
    await expect(page.getByText('3,400')).toBeVisible();
    await expect(page.getByText('1,900')).toBeVisible();
    await expect(page.getByText('+1,140')).toBeVisible();
    await expect(page.getByText('1,480')).toBeVisible();
    await expect(page.getByText('340')).toBeVisible();
    await expect(page.getByText('16 – 22 Nov 2026', { exact: true })).toBeVisible();
    await expect(page.getByText('Last 7 days · combined')).toBeVisible();
    await expect(
      page.getByRole('img', { name: /Line chart of combined daily media views.*147,650/ }),
    ).toBeVisible();
    // The 28-day numbers are gone — the switch really swapped data.
    await expect(page.getByText('590,700')).toHaveCount(0);
    await expect(page.getByText('26 Oct – 22 Nov 2026')).toHaveCount(0);

    // 1 day: every value swaps again.
    await page.getByRole('button', { name: '1 day' }).click();
    await expect(page.getByText('20,260')).toBeVisible();
    await expect(page.getByText('11,580')).toBeVisible();
    await expect(page.getByText('15,800')).toBeVisible();
    await expect(page.getByText('3,600')).toBeVisible();
    await expect(page.getByText(/^13 hours$/)).toBeVisible();
    await expect(page.getByText('1,461')).toBeVisible();
    await expect(page.getByText('591')).toBeVisible();
    await expect(page.getByText('265')).toBeVisible();
    await expect(page.getByText('+162')).toBeVisible();
    await expect(page.getByText('210')).toBeVisible();
    await expect(page.getByText('48')).toBeVisible();
    await expect(page.getByText('22 Nov 2026', { exact: true })).toBeVisible();
    await expect(page.getByText('Yesterday · combined')).toBeVisible();
    await expect(page.getByText('147,650')).toHaveCount(0);

    // Back to 28 days: the round trip works.
    await page.getByRole('button', { name: '28 days' }).click();
    await expect28DayValues(page);

    // Workspace switch: All workspaces rolls up differently.
    await page.getByLabel('Workspace', { exact: true }).selectOption('all');
    await expect(page.getByText('72,000')).toBeVisible();
    await expect(page.getByText('700,000')).toBeVisible();
    await expect(page.getByText('60,975')).toHaveCount(0);

    await expectNoDocumentOverflow(page);
  });

  test('empty states instead of fabricated numbers', async ({ page }) => {
    await openAnalytics(page, 'empty');

    await expect(
      page.getByText(
        'No analytics data yet — pages with 100+ followers are picked up on the next daily run.',
      ),
    ).toBeVisible();
    await expect(page.getByText('No location data yet.')).toHaveCount(2);
    await expect(page.getByText('No daily data for this period yet.')).toBeVisible();
  });
});

test.describe('Analytics page at 360px (spec 241)', () => {
  test.use({ viewport: { width: 360, height: 720 } });

  test('renders, switches period, and does not overflow', async ({ page }) => {
    await openAnalytics(page);

    await expect(page.getByText('60,975')).toBeVisible();
    await expect(page.getByText('+4,730')).toBeVisible();
    await expect(page.getByText('590,700')).toBeVisible();

    // The picker and the period switcher stay inside the viewport.
    await expectWithinViewport(page.getByLabel('Workspace', { exact: true }), page);
    await expectWithinViewport(page.getByRole('group', { name: 'Period' }), page);

    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page.getByText('147,650')).toBeVisible();
    await expect(page.getByText('+1,140')).toBeVisible();
    await expect(page.getByText('590,700')).toHaveCount(0);

    await expectNoDocumentOverflow(page);
  });
});
