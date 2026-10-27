/**
 * Queue tab placeholder — dedicated Page section redesign.
 *
 * The old queue list (rows, drag handles, keyboard reorder, Bulk add)
 * was deliberately removed with the dedicated redesign: the Queue tab
 * is an empty placeholder ("This section is being rebuilt") until the
 * Queue section is rebuilt later, more professionally. The previous
 * spec 134 reorder tests and the spec 132 bulk-flow tests asserted
 * that removed UI, so they cannot pass on this branch — this spec
 * replaces them as the guard for the placeholder state: even with
 * queued items in the fixture, the Queue tab shows only the
 * placeholder, with no rows, no reorder controls, and no Bulk add
 * entry point. Reorder and bulk E2E coverage returns with the
 * professional queue rebuild, when these tests must be rewritten
 * again for the new UI.
 */

import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { FACEBOOK_PAGE, queueItemFixture, SESSION_COOKIE, TENANT } from './fixtures/tenant';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function seedQueue() {
  return createFixtureState({
    queue: [
      queueItemFixture({
        id: ID_A,
        caption: 'Reorder first post',
        scheduledTime: '2026-12-01T09:00:00.000Z',
      }),
      queueItemFixture({
        id: ID_B,
        caption: 'Reorder second post',
        scheduledTime: '2026-12-01T10:00:00.000Z',
      }),
    ],
  });
}

test.describe('queue tab placeholder (dedicated redesign)', () => {
  test('Queue tab shows only the placeholder, even with queued items', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());

    await page.goto(`/tenant/${TENANT.subdomain}/pages/${FACEBOOK_PAGE.id}`);
    await page.getByTestId('tab-queue-btn').click();

    const placeholder = page.getByTestId('page-tab-queue-placeholder');
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText('This section is being rebuilt.');

    // The removed UI must not be reachable from this tab.
    await expect(page.getByTestId(`queue-row-${ID_A}`)).toHaveCount(0);
    await expect(page.getByTestId(`queue-row-${ID_B}`)).toHaveCount(0);
    await expect(page.getByTestId(`queue-drag-handle-${ID_A}`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bulk add' })).toHaveCount(0);
  });

  test('placeholder tab is usable at mobile widths with no horizontal overflow (spec 142 gate)', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedQueue());

    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/tenant/${TENANT.subdomain}/pages/${FACEBOOK_PAGE.id}`);
      await page.getByTestId('tab-queue-btn').click();
      await expect(page.getByTestId('page-tab-queue-placeholder')).toBeVisible();
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement;
        return el ? el.scrollWidth - el.clientWidth : 0;
      });
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
});
