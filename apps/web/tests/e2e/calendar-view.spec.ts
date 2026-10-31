/**
 * Calendar View section (dedicated Page) — the queue as a month
 * calendar: posts on their estimate / published / last-update days,
 * status filter chips, month navigation, and the shared edit
 * dialogue. Published entries are not clickable for edit.
 *
 * Time discipline (month-end fragility, fixed here): queued entries
 * sit on derived estimate days — the next 09:00/10:00 UTC slot
 * occurrences after "now". With real time, a run after 10:00 UTC on
 * the last day of a month pushes both estimates into the next month,
 * and when that month ends on a Saturday (October 2026 ends Sat
 * Oct 31) the current month's grid contains no next-month cells at
 * all — so the entries are nowhere on the initial grid and the old
 * tests, which asserted them there, failed. The fix is in the tests,
 * not the app: the app correctly shows next-month estimates once you
 * navigate to that month.
 *
 * So these tests freeze the browser clock (page.clock) instead of
 * trusting real time. App code runs for real; only the clock is a
 * fixture input. The frozen instant is always in the past relative
 * to the real session cookie's expiry, so the mocked clock can never
 * make the browser drop the session cookie. The main tests freeze
 * 08:00 UTC on the 15th of the previous month, so both slot
 * occurrences are still ahead that day and both estimates land on
 * the initial grid. The regression test freezes Oct 31 2026 10:30 UTC
 * — after both slots — and proves the Nov 1 estimates appear once
 * you navigate to November.
 */
import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { FACEBOOK_PAGE, queueItemFixture, SESSION_COOKIE, TENANT } from './fixtures/tenant';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** "October 2026" for a date (page timezone is UTC in these fixtures). */
function monthLabelOf(date: Date): string {
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * 08:00 UTC on the 15th of the previous month: mid-month, both daily
 * slots still ahead that day, and always in the past relative to the
 * real session cookie, so the frozen clock never invalidates auth.
 */
function safeNow(): Date {
  const real = new Date();
  return new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth() - 1, 15, 8, 0, 0));
}

/** The exact condition that broke the suite: Oct 31 2026, after both slots. */
const MONTH_END_NOW = new Date(Date.UTC(2026, 9, 31, 10, 30, 0));

function seedCalendar(now: Date = new Date()) {
  // Failed + published days on the 15th of the frozen month, so those
  // entries are always on the initial grid next to the queued estimates.
  const day15 = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 9, 0, 0)
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
        updatedAt: day15,
      }),
      queueItemFixture({
        id: ID_D,
        caption: 'Calendar published post',
        postFormat: 'text',
        status: 'published',
        publishedAt: day15,
      }),
    ],
  });
}

async function openCalendarTab(page: Page, fixedTime?: Date) {
  // Install before navigation so every app read of the clock sees it.
  if (fixedTime) await page.clock.install({ time: fixedTime });
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
    const now = safeNow();
    await installApiFixtures(page, seedCalendar(now));
    await openCalendarTab(page, now);

    await expect(page.getByTestId('calendar-month-label')).toHaveText(monthLabelOf(now));
    // Frozen mid-month before both slots, so both queued estimates
    // land the same day and are on the initial grid.
    await expect(page.getByTestId(`calendar-entry-${ID_A}`)).toBeVisible();
    await expect(page.getByTestId(`calendar-entry-${ID_B}`)).toBeVisible();

    await page.getByTestId('calendar-next-btn').click();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    await expect(page.getByTestId('calendar-month-label')).toHaveText(monthLabelOf(next));
    await page.getByTestId('calendar-today-btn').click();
    await expect(page.getByTestId('calendar-month-label')).toHaveText(monthLabelOf(now));
  });

  test('filter chips filter the calendar', async ({ page, context }) => {
    await context.addCookies([SESSION_COOKIE]);
    const now = safeNow();
    await installApiFixtures(page, seedCalendar(now));
    await openCalendarTab(page, now);

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
    const now = safeNow();
    await installApiFixtures(page, seedCalendar(now));
    await openCalendarTab(page, now);

    await page.getByTestId(`calendar-entry-${ID_A}`).click();
    const dialog = page.getByTestId('queue-edit-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('queue-edit-caption')).toHaveValue('Calendar first post');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByTestId(`calendar-entry-${ID_D}`).click();
    await expect(page.getByTestId('queue-edit-dialog')).toHaveCount(0);
  });

  test('estimates past month-end appear on the next month grid, not the current one', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, seedCalendar(MONTH_END_NOW));
    await openCalendarTab(page, MONTH_END_NOW);

    // Frozen Oct 31 2026 10:30 UTC: both slot occurrences today have
    // passed, so both estimates are Nov 1 — and October's grid ends
    // Sat Oct 31, so neither entry is on it.
    await expect(page.getByTestId('calendar-month-label')).toHaveText('October 2026');
    await expect(page.getByTestId(`calendar-entry-${ID_A}`)).toHaveCount(0);
    await expect(page.getByTestId(`calendar-entry-${ID_B}`)).toHaveCount(0);

    // Navigating to November reveals them: the estimates were never
    // lost, they were simply on the next month's grid.
    await page.getByTestId('calendar-next-btn').click();
    await expect(page.getByTestId('calendar-month-label')).toHaveText('November 2026');
    await expect(page.getByTestId(`calendar-entry-${ID_A}`)).toBeVisible();
    await expect(page.getByTestId(`calendar-entry-${ID_B}`)).toBeVisible();

    await page.getByTestId('calendar-today-btn').click();
    await expect(page.getByTestId('calendar-month-label')).toHaveText('October 2026');
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
