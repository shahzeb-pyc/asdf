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
 * Statuses covered: all 11 statuses (the eight error/lifecycle
 * statuses the display file defines plus paused, active and
 * completed — active/paused are the toggle states, completed is the
 * lifecycle status), at a desktop width (1280) and a phone width (390).
 * Banner copy comes from the Facebook detail page's own local alert
 * switch (`getAduDetailStatusAlert` in adu-detail-page.tsx), not the
 * contracts alert functions the IG/Threads pages use. Toggle lock
 * follows the spec 236 PATCH guard: only the terminal statuses
 * completed and invalid_username lock the toggle (invalid_username
 * added by owner decision 2026-11-09, for symmetry with completed).
 * The Facebook error statuses (fb_rate_limited, invalid_token, and
 * the others) leave the toggle enabled — spec 238: the toggle
 * reactivates the page, and the next publish falls back to the real
 * error. A disconnected destination locks it too.
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
  fb_verification_required: 'Verification required',
  account_suspended: 'Account suspended',
  check_developer_app: 'Check developer app',
  page_not_accessible: 'Page not accessible',
  invalid_username: 'Source disabled',
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
  fb_verification_required: 'critical',
  account_suspended: 'critical',
  check_developer_app: 'critical',
  page_not_accessible: 'critical',
  invalid_username: 'critical',
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
    bannerTitle: 'Missing Page Access',
    bannerText: /restore your role in Business Manager/,
    toggleDisabled: false,
  },
  {
    status: 'missing_permission',
    bannerTitle: 'Missing Permission',
    bannerText: /grant the permission/,
    toggleDisabled: false,
  },
  {
    status: 'creator_suspended',
    bannerTitle: 'Source Creator Unavailable',
    bannerText: /more than 50 failed downloads/,
    toggleDisabled: false,
  },
  {
    status: 'invalid_token',
    bannerTitle: 'Access Token Expired',
    bannerText: /Reconnect your Facebook account/,
    toggleDisabled: false,
  },
  {
    status: 'fb_rate_limited',
    bannerTitle: 'Facebook Rate Limited',
    bannerText: /resume automatically/,
    toggleDisabled: false,
  },
  {
    status: 'completed',
    bannerTitle: 'All Reels Posted',
    bannerText: /update Settings > Source/,
    toggleDisabled: true,
  },
  {
    // PATCH guards (§3.3) allow activation from here (direct activate),
    // so the toggle stays enabled: verify in the Meta app, then toggle ON.
    status: 'fb_verification_required',
    bannerTitle: 'Facebook Verification Required',
    bannerText: /Complete identity or phone verification in the Meta app/,
    toggleDisabled: false,
  },
  {
    // PATCH guards (§3.3) allow activation from here (direct activate),
    // so the toggle stays enabled: Meta clears the restriction, then toggle ON.
    status: 'account_suspended',
    bannerTitle: 'Facebook Account Suspended',
    bannerText: /Once Facebook clears the restriction/,
    toggleDisabled: false,
  },
  {
    // PATCH guards (§3.3) allow activation from here (direct activate),
    // so the toggle stays enabled: fix the developer app, then toggle ON.
    status: 'check_developer_app',
    bannerTitle: 'Developer App Access Blocked',
    bannerText: /Fix the problem in your developer app/,
    toggleDisabled: false,
  },
  {
    // PATCH guards (§3.3) allow activation from here (fresh page-token
    // check), so the toggle stays enabled: confirm the page, then toggle ON.
    status: 'page_not_accessible',
    bannerTitle: 'Facebook Page Not Accessible',
    bannerText: /Confirm the page still exists/,
    toggleDisabled: false,
  },
  {
    // Owner decision 2026-11-09: the toggle renders DISABLED here for
    // symmetry with completed — the PATCH guard already rejects
    // activation from invalid_username (400, "Update the source to
    // continue posting."), and the display now agrees with the server.
    status: 'invalid_username',
    bannerTitle: 'Source Account Disabled',
    bannerText: /Verify the source account is active/,
    toggleDisabled: true,
  },
];

function configView(
  status: string,
  destination?: { status: string; fbStatus: string | null },
) {
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
    // Spec 204: the destination's reason rides the view (the hub
    // omits it — the derived displayStatus carries the label there).
    destinationStatus: destination?.status ?? 'active',
    destinationFbStatus: destination?.fbStatus ?? null,
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
  getStatus: () => string,
  getDestination: () => { status: string; fbStatus: string | null } | null = () => null,
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
      return json({ config: configView(getStatus(), getDestination() ?? undefined) });
    }
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`ADU detail statuses — ${viewport.name} (${viewport.width}px)`, () => {
    let currentStatus = 'active';
    let currentDestination: { status: string; fbStatus: string | null } | null = null;

    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await installAduDetailFixtures(page, () => currentStatus, () => currentDestination);
    });

    for (const c of CASES) {
      test(`${c.status}: badge, alert, and toggle lock`, async ({ page }) => {
        currentStatus = c.status;
        currentDestination = null;
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

    test('spec 204: an error destination with a checkpoint marker shows the verification alert even when the config is active', async ({
      page,
    }) => {
      // The beekainternational shape: the config was reactivated, so
      // it reads active — the destination's marker is the only record
      // of the checkpoint, and the alert must come from it.
      currentStatus = 'active';
      currentDestination = { status: 'error', fbStatus: 'checkpoint' };
      await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload/${CONFIG_ID}`);
      await expect(
        page.getByRole('heading', { name: 'Total Statistics' })
      ).toBeVisible();

      const mark = page.getByTestId('adu-detail-status-mark');
      await expect(mark).toContainText('Active posting');
      await expect(page.getByText('Facebook Verification Required', { exact: true })).toBeVisible();
      await expect(
        page.getByText(/Complete identity or phone verification in the Meta app/)
      ).toBeVisible();

      if (viewport.name === 'phone') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBe(0);
      }
    });

    test('spec 238: a disconnected destination locks the toggle even when the config is active', async ({
      page,
    }) => {
      currentStatus = 'active';
      currentDestination = { status: 'disconnected', fbStatus: null };
      await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload/${CONFIG_ID}`);
      await expect(
        page.getByRole('heading', { name: 'Total Statistics' })
      ).toBeVisible();

      await expect(page.getByRole('switch')).toBeDisabled();

      if (viewport.name === 'phone') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBe(0);
      }
    });
  });
}
