/**
 * ADU Add Page dialog step 3 (spec 221): the sources list must be
 * capped like steps 1–2 (max-h-85 + overflow-y-auto) so the step
 * stays the same height with many pages picked and the list scrolls
 * inside itself; a short list gains no dead space (the cap is a max,
 * not a fixed height).
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout, and the routes registered below — after the
 * shared fixtures, so they take precedence — serve the hub list, the
 * options picker data, and the live-discover call for one account
 * with N pages. No live network, no real backend. The production
 * build itself (routing, middleware session verification, tenant
 * layout, components) runs for real.
 *
 * The cap is measured, not asserted from markup: with 12 pages
 * picked, the sources list's clientHeight is the cap (~340px) while
 * its scrollHeight is far larger, the dialog itself does not scroll,
 * and the last row is reachable by scrolling the list; with 2 pages,
 * the list is its content height with nothing to scroll.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

/** max-h-85 = 85 × 0.25rem = 21.25rem = 340px. */
const SOURCES_LIST_CAP_PX = 340;

function pagesFor(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `page-${i + 1}`,
    account_id: ACCOUNT_ID,
    external_destination_id: `${100 + i}`,
    name: `Page ${i + 1}`,
    avatar_url: null,
    status: 'connected',
    metadata: null,
  }));
}

async function installDialogFixtures(
  page: import('@playwright/test').Page,
  pageCount: number
) {
  const pages = pagesFor(pageCount);
  await page.route(
    (url) => url.pathname === `/api/tenant/${TENANT.subdomain}/auto-download-upload`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configs: [],
          stats: { totalPages: 0, followersGained: 0, totalFollowers: 0 },
          totalPages: 0,
          page: 1,
        }),
      })
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/tenant/${TENANT.subdomain}/auto-download-upload/options`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accounts: [
            {
              id: ACCOUNT_ID,
              external_account_id: '111',
              display_name: 'My FB Account',
              avatar_url: null,
              status: 'connected',
            },
          ],
          pages,
          configured: [],
        }),
      })
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/tenant/${TENANT.subdomain}/accounts/${ACCOUNT_ID}/pages/discover`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accountId: ACCOUNT_ID,
          accountDisplayName: 'My FB Account',
          pages: pages.map((p) => ({
            fbPageId: p.external_destination_id,
            pageName: p.name,
            profilePictureUrl: null,
            category: null,
            currentFollowers: 0,
            followersCount: 0,
            tasks: [],
            isImported: true,
          })),
          total: pages.length,
          truncated: false,
          partial: false,
          droppedCount: 0,
        }),
      })
  );
}

/** Opens the dialog and walks it to step 3 with every page picked. */
async function openStep3(page: import('@playwright/test').Page, pageCount: number) {
  await page.goto(`/tenant/${TENANT.subdomain}/auto-download-upload`);
  await page.getByRole('button', { name: 'Add Page' }).click();
  await expect(page.getByText('Step 1 of 4: Select Accounts')).toBeVisible();
  await page.getByTestId(`adu-account-checkbox-${ACCOUNT_ID}`).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Step 2 of 4: Select Pages')).toBeVisible();
  // Exact: the substring match would also hit Page 10/11/12.
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await page.getByTestId('adu-select-all-pages-btn').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Step 3 of 4: Sources')).toBeVisible();
  const list = page.getByTestId('adu-add-page-sources-list');
  await expect(list).toBeVisible();
  // Every picked page renders its row (name + platform picker +
  // username input) before any measurement.
  await expect(page.getByPlaceholder('@username').first()).toBeVisible();
  expect(await page.getByPlaceholder('@username').count()).toBe(pageCount);
  return list;
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`ADU Add Page step 3 sources cap — ${viewport.name} (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
    });

    test('many pages: list is capped, scrolls internally, last row reachable', async ({
      page,
    }) => {
      await installDialogFixtures(page, 12);
      const list = await openStep3(page, 12);
      await page.evaluate(() => document.fonts.ready);

      const dims = await list.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowY: getComputedStyle(el).overflowY,
        maxHeight: getComputedStyle(el).maxHeight,
      }));
      // The cap, not the content, sets the height: 340px within 2px
      // (sub-pixel rounding), with ~400px more content below it.
      // Without the cap the list would be ~736px tall and grow the
      // dialog off the bottom (spec 221).
      expect(Math.abs(dims.clientHeight - SOURCES_LIST_CAP_PX)).toBeLessThanOrEqual(2);
      expect(dims.scrollHeight).toBeGreaterThan(dims.clientHeight + 100);
      expect(dims.overflowY).toBe('auto');
      expect(dims.maxHeight).toBe('340px');

      // The dialog itself must not scroll: the list scrolls inside
      // it, so the whole step fits on screen.
      const dialog = page.getByRole('dialog');
      const dialogScroll = await dialog.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
      expect(dialogScroll.scrollHeight).toBeLessThanOrEqual(dialogScroll.clientHeight + 1);

      // The last row is reachable: scroll the list to the bottom and
      // the final row sits inside the list's box.
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const reachable = await page.evaluate(() => {
        const listEl = document.querySelector(
          '[data-testid="adu-add-page-sources-list"]'
        )!;
        const lastRow = listEl.lastElementChild!;
        const listBox = listEl.getBoundingClientRect();
        const rowBox = lastRow.getBoundingClientRect();
        return rowBox.bottom <= listBox.bottom + 1 && rowBox.top >= listBox.top - 1;
      });
      expect(reachable).toBe(true);
    });

    test('few pages: no dead space — list is its content height', async ({ page }) => {
      await installDialogFixtures(page, 2);
      const list = await openStep3(page, 2);
      await page.evaluate(() => document.fonts.ready);

      const dims = await list.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
      // Two rows are ~104px of content: far under the 340px cap, and
      // nothing to scroll — the cap is a max, not a fixed height.
      expect(dims.clientHeight).toBeLessThan(SOURCES_LIST_CAP_PX);
      expect(dims.scrollHeight).toBeLessThanOrEqual(dims.clientHeight + 1);
    });
  });
}
