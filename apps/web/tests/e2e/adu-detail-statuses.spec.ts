/**
 * ADU detail page — status badges, alerts, and toggle locks (spec
 * acceptance 9, B3/B4).
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the ADU detail routes registered below —
 * after the shared fixtures, so they take precedence — serve one
 * config view per status from mutable fixture state. No live network,
 * no real backend. The production build itself (routing, middleware
 * session verification, tenant layout, components) runs for real.
 *
 * Statuses covered: the six the acceptance criterion names (paused,
 * missing_page_access, missing_permission, creator_suspended,
 * invalid_token, fb_rate_limited) plus active and completed, at a
 * desktop width (1280) and a phone width (390).
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const CONFIG_ID = 'cfg-1';

const DISPLAY_STATUS: Record<string, string> = {
  active: 'Active posting',
  paused: 'Paused',
  missing_page_access: 'Missing page access',
  missing_permission: 'Missing permission',
  creator_suspended: 'Creator suspended',
  invalid_token: 'Invalid token',
  fb_rate_limited: 'Rate limited',
  completed: 'All reels posted',
};

const MARK_KIND: Record<string, string> = {
  active: 'operational',
  paused: 'queued',
  missing_page_access: 'critical',
  missing_permission: 'critical',
  creator_suspended: 'critical',
  invalid_token: 'critical',
  fb_rate_limited: 'critical',
  completed: 'operational',
};

interface StatusCase {
  status: string;
  bannerTitle: string | null;
  bannerText: RegExp | null;
  toggleDisabled: boolean;
}

const CASES: StatusCase[] = [
  {
    status: 'active',
    bannerTitle: null,
    bannerText: null,
    toggleDisabled: false,
  },
  {
    status: 'paused',
    bannerTitle: 'Posting Paused',
    bannerText: /Turn automation on to resume/,
    toggleDisabled: false,
  },
  {
    status: 'missing_page_access',
    bannerTitle: 'Page Access Missing',
    bannerText: /restore your role in Business Manager/,
    toggleDisabled: false,
  },
  {
    status: 'missing_permission',
    bannerTitle: 'Page Permission Missing',
    bannerText: /grant the permission/,
    toggleDisabled: false,
  },
  {
    status: 'creator_suspended',
    bannerTitle: 'Source Creator Unavailable',
    bannerText: /More than 50 downloads/,
    toggleDisabled: false,
  },
  {
    status: 'invalid_token',
    bannerTitle: 'Access Token Expired',
    bannerText: /Reconnect your Facebook account/,
    toggleDisabled: true,
  },
  {
    status: 'fb_rate_limited',
    bannerTitle: 'Facebook Rate Limited',
    bannerText: /resume automatically/,
    toggleDisabled: true,
  },
  {
    status: 'completed',
    bannerTitle: 'All Reels Posted',
    bannerText: /update Settings > Source/,
    toggleDisabled: true,
  },
];

function configView(status: string) {
  return {
    id: CONFIG_ID,
    destinationId: 'dest-1',
    destinationName: 'E2E Test Page',
    destinationExternalId: '100000000000001',
    destinationAvatarUrl: null,
    accountName: 'E2E Connected Account',
    accountAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'creator_one',
    sourceLink: 'https://www.tiktok.com/@creator_one',
    sourceIdentity: '@creator_one',
    timezone: 'Asia/Karachi',
    postsPerDay: 2,
    scheduleType: 'dailyrandom',
    postingTimes: [],
    status,
    syncStatus: 'synced',
    displayStatus: DISPLAY_STATUS[status],
    alert: null,
    followersCount: 120,
    followersGained: 132,
    createdAt: '2026-10-01T00:00:00.000Z',
    postedCount: 10,
    pendingCount: 3,
    failedCount: 1,
    postedToday: 2,
    pendingToday: 1,
    failedToday: 0,
  };
}

/** Serves the ADU detail endpoints for whatever status is current. */
async function installAduDetailFixtures(
  page: import('@playwright/test').Page,
  getStatus: () => string
) {
  await page.route(
    `**/api/tenant/${TENANT.subdomain}/auto-download-upload/${CONFIG_ID}**`,
    (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      if (method === 'PATCH') return json({ ok: true });
      if (url.pathname.endsWith('/reels')) return json({ reels: [] });
      if (url.pathname.endsWith('/failed')) return json({ jobs: [] });
      return json({ config: configView(getStatus()) });
    }
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`ADU detail statuses — ${viewport.name} (${viewport.width}px)`, () => {
    let currentStatus = 'active';

    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await installAduDetailFixtures(page, () => currentStatus);
    });

    for (const c of CASES) {
      test(`${c.status}: badge, alert, and toggle lock`, async ({ page }) => {
        currentStatus = c.status;
        await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload/${CONFIG_ID}`);
        await expect(
          page.getByRole('heading', { name: 'Total Statistics' })
        ).toBeVisible();

        const mark = page.getByTestId('adu-detail-status-mark');
        await expect(mark).toContainText(DISPLAY_STATUS[c.status]);
        await expect(mark).toHaveAttribute('data-status', MARK_KIND[c.status]);

        if (c.bannerTitle && c.bannerText) {
          await expect(page.getByText(c.bannerTitle, { exact: true })).toBeVisible();
          await expect(page.getByText(c.bannerText)).toBeVisible();
        } else {
          // Active and synced: no status banner at all.
          await expect(page.getByText('Posting Paused', { exact: true })).toHaveCount(0);
          await expect(page.getByText('Access Token Expired', { exact: true })).toHaveCount(0);
          await expect(page.getByText('All Reels Posted', { exact: true })).toHaveCount(0);
        }
        if (c.status === 'creator_suspended') {
          await expect(page.getByText(/last 24 hours/)).toHaveCount(0);
          await expect(page.getByText(/Turn automation on to check/)).toBeVisible();
        }

        const toggle = page.getByRole('switch');
        if (c.toggleDisabled) {
          await expect(toggle).toBeDisabled();
        } else {
          await expect(toggle).toBeEnabled();
        }

        if (viewport.name === 'phone') {
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          );
          expect(overflow).toBe(0);
        }
      });
    }
  });
}
