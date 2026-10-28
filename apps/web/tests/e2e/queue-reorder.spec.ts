/**
 * Queue section (dedicated Page) — real panel, rebuilt from the
 * placeholder guard this file used to be.
 *
 * The Queue tab now renders the professional section: rows in queue
 * order with derived estimates, status filter chips, and the five
 * actions (delete with confirmation, caption-only edit, up/down
 * reorder, publish now, retry on failed rows). Reorder is buttons,
 * not drag-and-drop — there are deliberately no drag handles, and
 * there is no Bulk add entry point (bulk-add was deleted with the
 * publisher-driven posting-times system).
 */

import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { FACEBOOK_PAGE, queueItemFixture, SESSION_COOKIE, TENANT } from './fixtures/tenant';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function seedQueue() {
  return createFixtureState({
    queue: [
      queueItemFixture({
        id: ID_A,
        caption: 'Queue first post',
        postFormat: 'text',
        status: 'queued',
      }),
      queueItemFixture({
        id: ID_B,
        caption: 'Queue second post',
        postFormat: 'text',
        status: 'queued',
      }),
      queueItemFixture({
        id: ID_C,
        caption: 'Queue failed post',
        postFormat: 'text',
        status: 'failed',
        retryCount: 1,
        maxRetries: 3,
      }),
      queueItemFixture({
        id: ID_D,
        caption: 'Queue published post',
        postFormat: 'text',
        status: 'published',
        publishedAt: '2026-10-27T09:00:00.000Z',
      }),
    ],
  });
}

async function openQueueTab(page: import('@playwright/test').Page) {
  await page.goto(`/tenant/${TENANT.subdomain}/pages/${FACEBOOK_PAGE.id}`);
  await page.getByTestId('tab-queue-btn').click();
  await expect(page.getByTestId('queue-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`queue-row-${ID_A}`)).toBeVisible({ timeout: 15_000 });
}

test.describe('queue section (dedicated page)', () => {
  test('rows render in queue order with estimates, no drag handles, no Bulk add', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    const rows = page.getByTestId('queue-panel').locator('ul > li');
    await expect(rows.first()).toContainText('Queue first post');
    await expect(rows.nth(1)).toContainText('Queue second post');
    // Queued rows carry a derived estimate (fixture slots cover all formats).
    await expect(page.getByTestId(`queue-row-${ID_A}`)).toContainText(/Est\./);
    await expect(page.getByTestId(`queue-row-${ID_C}`)).toContainText('Retry 1 of 3');

    // The removed UI must not be reachable from this tab.
    await expect(page.getByTestId(`queue-drag-handle-${ID_A}`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bulk add' })).toHaveCount(0);
  });

  test('move down persists: the list re-reads in the new order', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    await page
      .getByTestId(`queue-row-${ID_A}`)
      .getByTestId('queue-row-move-down')
      .click();
    await expect(page.getByText('Queue order updated.')).toBeVisible({ timeout: 15_000 });
    const rows = page.getByTestId('queue-panel').locator('ul > li');
    await expect(rows.first()).toContainText('Queue second post');
    await expect(rows.nth(1)).toContainText('Queue first post');
  });

  test('edit changes only the caption', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    await page.getByTestId(`queue-row-${ID_A}`).getByTestId('queue-row-edit').click();
    const textarea = page.getByTestId('queue-edit-caption');
    await expect(textarea).toHaveValue('Queue first post');
    await textarea.fill('Queue first post, edited');
    await page.getByTestId('queue-edit-save-btn').click();
    await expect(page.getByText('Caption updated.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`queue-row-${ID_A}`)).toContainText(
      'Queue first post, edited'
    );
  });

  test('delete asks first, then removes the row', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    await page.getByTestId(`queue-row-${ID_C}`).getByTestId('queue-row-delete').click();
    await page.getByTestId('queue-delete-confirm-btn').click();
    await expect(page.getByText('Post deleted.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`queue-row-${ID_C}`)).toHaveCount(0);
  });

  test('retry returns a failed row to queued', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    await page.getByTestId(`queue-row-${ID_C}`).getByTestId('queue-row-retry').click();
    await expect(page.getByText('Post queued again.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`queue-row-${ID_C}`)).toContainText('Queued');
  });

  test('publish now triggers without breaking the list', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    await page.getByTestId(`queue-row-${ID_A}`).getByTestId('queue-row-publish-now').click();
    await expect(page.getByText('Publishing triggered successfully.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId(`queue-row-${ID_A}`)).toBeVisible();
  });

  test('published rows refuse edit and delete in the UI', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    const row = page.getByTestId(`queue-row-${ID_D}`);
    await expect(row.getByTestId('queue-row-edit')).toBeDisabled();
    await expect(row.getByTestId('queue-row-delete')).toBeDisabled();
  });

  test('status filter chips narrow the list', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());
    await openQueueTab(page);

    await page.getByTestId('queue-filter-failed').click();
    await expect(page.getByTestId(`queue-row-${ID_C}`)).toBeVisible();
    await expect(page.getByTestId(`queue-row-${ID_A}`)).toHaveCount(0);
    await page.getByTestId('queue-filter-all').click();
    await expect(page.getByTestId(`queue-row-${ID_A}`)).toBeVisible();
  });

  test('queue panel is usable at mobile widths with no horizontal overflow', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());

    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/tenant/${TENANT.subdomain}/pages/${FACEBOOK_PAGE.id}`);
      await page.getByTestId('tab-queue-btn').click();
      await expect(page.getByTestId('queue-panel')).toBeVisible({ timeout: 15_000 });
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement;
        return el ? el.scrollWidth - el.clientWidth : 0;
      });
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
});
