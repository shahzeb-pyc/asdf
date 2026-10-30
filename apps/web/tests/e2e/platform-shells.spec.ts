/**
 * Platform accounts shells (spec 131 PR-131-5, audit #12) — mobile gate
 * evidence (spec 142).
 *
 * The three remaining placeholder platform account routes (TikTok,
 * X, YouTube) render through ONE shared shell
 * (`PlatformAccountsShell`). Instagram and Threads no longer use that
 * shell: both are real accounts pages (see the Instagram block
 * below), so neither is in the PLATFORMS list. Threads' mobile /
 * real-browser check for its real page is a separate follow-up; do
 * not re-add it here.
 * ByocGate credentials check is answered from the fixture below (details
 * present, so the gated connect links render); no production data, no
 * third-party traffic.
 *
 * Per viewport (320 / 390 / 768): each shell renders its identity
 * (platform heading), the verbatim testing notice and description, its
 * connect link where the platform has one today (X has none), and the
 * Return to Overview action — stacked with zero horizontal overflow and
 * compact 36px targets (compact default density — Shahzeb 2026-10-24,
 * spec 129 OD-4 as amended; supersedes the spec 142 F01 44px band).
 */
import { test, expect, type Page } from '@playwright/test';

import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const SUB = TENANT.subdomain;

const PLATFORMS = [
  // Instagram and Threads are NOT in this placeholder spec anymore:
  // both have real list pages (React Query + server prefetch +
  // connect modal), not the shared PlatformAccountsShell placeholder
  // this spec asserts on (testing notice, Return to Overview).
  // Instagram's real page is asserted in the block below; Threads'
  // mobile/real-browser check is a separate follow-up. Do not
  // re-add either here.
  {
    slug: 'tiktok',
    name: 'TikTok',
    heading: 'TikTok Accounts',
    description:
      'You connect your account through our publishing partner — there is nothing to set up or paste here. When you connect, you sign in with TikTok, approve the connection, and confirm your account.',
    connectTestId: 'tiktok-connect-link',
  },
  {
    slug: 'x',
    name: 'X (Twitter)',
    heading: 'X (Twitter) Accounts',
    description:
      'Simply sign in with X and approve the connection — there are no keys to create or paste. Your account is connected in a couple of clicks.',
    connectTestId: null,
  },
  {
    slug: 'youtube',
    name: 'YouTube',
    heading: 'YouTube Accounts',
    description:
      'You connect your channel through our publishing partner — there is nothing to set up or paste here. When you connect, you sign in with YouTube, approve the connection, and pick your channel.',
    connectTestId: 'youtube-connect-link',
  },
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el ? el.scrollWidth - el.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectCompactHeight(locator: ReturnType<Page['getByRole']>) {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
}

test.describe('platform accounts shells (one shared shell)', () => {
  for (const width of [320, 390, 768]) {
    for (const platform of PLATFORMS) {
      test(`${platform.name} shell renders at ${width}px with no overflow and compact 36px targets`, async ({
        page,
        context,
      }) => {
        await context.addCookies([SESSION_COOKIE]);
        const state = createFixtureState();
        await installApiFixtures(page, state);
        // ByocGate (Instagram/Threads): answer the credentials check with
        // details present so the gated connect link renders.
        await page.route(
          `**/api/tenant/${SUB}/settings/platform-credentials/**`,
          (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ appId: 'fixture-app-id', hasSecret: true }),
            })
        );

        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/tenant/${SUB}/${platform.slug}/accounts`);

        await expect(page.getByTestId('platform-placeholder-accounts')).toBeVisible();
        await expect(
          page.getByRole('heading', { name: platform.heading })
        ).toBeVisible();
        await expect(page.getByTestId('testing-placeholder-notice')).toHaveText(
          'Being tested — not available for public use'
        );
        await expect(page.getByText(platform.description)).toBeVisible();

        if (platform.connectTestId) {
          const connect = page.getByTestId(platform.connectTestId);
          await expect(connect).toBeVisible();
          await expect(connect).toHaveText(`Connect ${platform.name}`);
          await expectCompactHeight(connect);
        } else {
          await expect(
            page.locator('a[href*="/api/connect/"]')
          ).toHaveCount(0);
        }

        const back = page.getByRole('button', { name: 'Return to Overview' });
        await expect(back).toBeVisible();
        await expectCompactHeight(back);
        await expectNoHorizontalOverflow(page);
      });
    }
  }
});

/**
 * Instagram accounts (real page, not a placeholder shell): the page
 * container and title render at every mobile viewport with no
 * horizontal overflow, and the placeholder shell markers are gone.
 * The list content itself (empty state, load error, or cards) depends
 * on the fixture-served accounts API, so this block asserts only the
 * page frame that renders in every state.
 */
test.describe('instagram accounts real page', () => {
  for (const width of [320, 390, 768]) {
    test(`Instagram accounts page renders at ${width}px with no overflow`, async ({
      page,
      context,
    }) => {
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await page.route(
        `**/api/tenant/${SUB}/settings/platform-credentials/**`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ appId: 'fixture-app-id', hasSecret: true }),
          })
      );

      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/tenant/${SUB}/instagram/accounts`);

      await expect(page.getByTestId('instagram-accounts-page')).toBeVisible();
      await expect(
        page.getByTestId('instagram-accounts-page-title')
      ).toHaveText('Instagram Accounts');
      await expect(
        page.getByTestId('platform-placeholder-accounts')
      ).toHaveCount(0);
      await expect(
        page.getByTestId('testing-placeholder-notice')
      ).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });
  }
});
