/**
 * Calendar View section (dedicated Page) — the queue as a month
 * calendar: posts on their estimate / published / last-update days,
 * status filter chips, month navigation, and the shared edit
 * dialogue. Published entries are not clickable for edit.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { FACEBOOK_PAGE, queueItemFixture, SESSION_COOKIE, TENANT } from './fixtures/tenant';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function seedCalendar() {
  // Published day inside the current month, whatever month the suite
  // runs in, so the published entry is always on the initial grid.
  const now = new Date();
  const publishedAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    15,
    9,
    0,
    0
  ).toISOString();
  return createFixtureState({
    queue: [
      queueItemFixture({
        id: ID_A,
        caption: 'Calendar first post',
        postFormat: 'text',
        status: 'queued',
      }),
      queueItemFixture({
        id: ID_B,
        caption: 'Calendar second post',
        postFormat: 'text',
        status: 'queued',
      }),
      queueItemFixture({
        id: ID_C,
        caption: 'Calendar failed post',
        postFormat: 'text',
        status: 'failed',
        retryCount: 1,
        maxRetries: 3,
      }),
      queueItemFixture({
        id: ID_D,
        caption: 'Calendar published post',
        postFormat: 'text',
        status: 'published',
        publishedAt,
      }),
    ],
  });
}

async function openCalendarTab(page: import('@playwright/test').Page) {
  await page.goto(`/tenant/${TENANT.subdomain}/pages/${FACEBOOK_PAGE.id}`);
  await page.getByTestId('tab-calendar-view-btn').click();
  await expect(page.getByTestId('calendar-view-panel')).toBeVisible({ timeout: 15_000 });
}

test.describe('calendar view section (dedicated page)', () => {
  test('renders the month grid with queued posts and navigates months', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedCalendar());
    await openCalendarTab(page);

    const now = new Date();
    const thisMonth = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    await expect(page.getByTestId('calendar-month-label')).toHaveText(thisMonth);
    // Fixture slots are daily, so both queued estimates land within
    // a day of now and are on the initial grid.
    await expect(page.getByTestId(`calendar-entry-${ID_A}`)).toBeVisible();
    await expect(page.getByTestId(`calendar-entry-${ID_B}`)).toBeVisible();

    await page.getByTestId('calendar-next-btn').click();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await expect(page.getByTestId('calendar-month-label')).toHaveText(
      next.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    );
    await page.getByTestId('calendar-today-btn').click();
    await expect(page.getByTestId('calendar-month-label')).toHaveText(thisMonth);
  });

  test('filter chips filter the calendar', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedCalendar());
    await openCalendarTab(page);

    await expect(page.getByTestId(`calendar-entry-${ID_A}`)).toBeVisible();
    await page.getByTestId('calendar-filter-failed').click();
    await expect(page.getByTestId(`calendar-entry-${ID_C}`)).toBeVisible();
    await expect(page.getByTestId(`calendar-entry-${ID_A}`)).toHaveCount(0);
    await page.getByTestId('calendar-filter-all').click();
    await expect(page.getByTestId(`calendar-entry-${ID_A}`)).toBeVisible();
  });

  test('clicking a post opens the shared edit dialogue; published posts do not', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedCalendar());
    await openCalendarTab(page);

    await page.getByTestId(`calendar-entry-${ID_A}`).click();
    const dialog = page.getByTestId('queue-edit-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('queue-edit-caption')).toHaveValue('Calendar first post');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByTestId(`calendar-entry-${ID_D}`).click();
    await expect(page.getByTestId('queue-edit-dialog')).toHaveCount(0);
  });

  test('no horizontal overflow at phone widths', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedCalendar());
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await openCalendarTab(page);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(overflows).toBe(false);
    }
  });

  test('a crowded day cell holds many posts without horizontal overflow at 320px', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    const now = new Date();
    const day15 = new Date(
      now.getFullYear(),
      now.getMonth(),
      15,
      15,
      30,
      0
    ).toISOString();
    const crowded = Array.from({ length: 8 }, (_, i) =>
      queueItemFixture({
        id: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee${i}`,
        caption: `Crowded post ${i + 1}`,
        postFormat: 'text',
        status: 'failed',
        retryCount: 1,
        maxRetries: 3,
        updatedAt: day15,
      })
    );
    await installApiFixtures(page, createFixtureState({ queue: crowded }));
    await page.setViewportSize({ width: 320, height: 800 });
    await openCalendarTab(page);
    // Count, not visibility: entries below the cell's scroll fold
    // are present but legitimately out of view until scrolled.
    await expect(page.locator('[data-testid^="calendar-entry-"]')).toHaveCount(8);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows).toBe(false);
  });
});
