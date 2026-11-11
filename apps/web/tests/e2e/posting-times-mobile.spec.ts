/**
 * Mobile gate evidence — posting-times surfaces (spec 134 PR-134-2,
 * spec 142).
 *
 * The posting-times tab is exercised at the phone/tablet widths the
 * task names (320 / 390 / 768 CSS px): the slot row and its controls
 * render with no horizontal overflow, primary targets are compact
 * 36px tall (compact default density — Shahzeb 2026-10-24, spec 129
 * OD-4 as amended), the Add posting-time dialog fits inside the viewport with
 * its submit reachable, and the two-step timezone dialog is usable —
 * all against the intercepted fixture boundary (no real backend).
 */

import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { FACEBOOK_PAGE, SESSION_COOKIE, TENANT } from './fixtures/tenant';

const VIEWPORTS = [
  { width: 320, height: 700 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const;

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectBoxInsideViewport(
  box: { x: number; width: number } | null,
  viewportWidth: number,
  label: string
) {
  expect(box, `${label} has a bounding box`).not.toBeNull();
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(viewportWidth + 1);
}

test.describe('posting times — mobile gate (spec 142)', () => {
  for (const viewport of VIEWPORTS) {
    test(`posting-times tab is usable at ${viewport.width}px`, async ({ page, context }) => {
      await context.addCookies([SESSION_COOKIE]);
      const state = createFixtureState();
      await installApiFixtures(page, state);
      await page.setViewportSize(viewport);

      await page.goto(`/tenant/${TENANT.subdomain}/inapp-schedule/${FACEBOOK_PAGE.id}`);
      await page.getByTestId('tab-calendar-btn').click();

      // The fixture's one 09:00 UTC slot renders as a row.
      const row = page.getByTestId(/posting-time-row-/).first();
      await expect(row).toBeVisible();
      await expect(page.getByTestId('posting-times-header')).toBeVisible();
      await expectNoHorizontalOverflow(page);

      // Primary actions are compact 36px tall and tappable at this width (compact default density — Shahzeb 2026-10-24, spec 129 OD-4 as amended).
      for (const testId of ['add-slot-button', 'schedule-timezone-trigger']) {
        const box = await page.getByTestId(testId).boundingBox();
        expect(box, `${testId} has a bounding box`).not.toBeNull();
        expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(36);
      }
      // The Switch's layout box is 24px by design; its hit area is the
      // design system's hit-area-44 utility (a centred 44px ::after) —
      // assert that effective hit area, and that a tap lands.
      const toggle = page.getByTestId(/toggle-slot-btn-/).first();
      const hitArea = await toggle.evaluate((el) => {
        const after = getComputedStyle(el, '::after');
        return { width: parseFloat(after.width), height: parseFloat(after.height) };
      });
      expect(hitArea.width, 'toggle hit area width').toBeGreaterThanOrEqual(44);
      expect(hitArea.height, 'toggle hit area height').toBeGreaterThanOrEqual(44);
      await toggle.click();

      // Add posting-time dialog: fits the viewport, submit reachable.
      await page.getByTestId('add-slot-button').click();
      const formDialog = page.getByTestId('add-posting-time-modal');
      await expect(formDialog).toBeVisible();
      await expectBoxInsideViewport(await formDialog.boundingBox(), viewport.width, 'form dialog');
      const saveBox = await page.getByTestId('save-slot-btn').boundingBox();
      expect(saveBox, 'save button has a bounding box').not.toBeNull();
      expect(saveBox!.height, 'save button height').toBeGreaterThanOrEqual(36);
      await expectNoHorizontalOverflow(page);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(formDialog).toBeHidden();

      // Timezone dialog: fits the viewport, search + options tappable,
      // and the flow reaches the review step at this width.
      await page.getByTestId('schedule-timezone-trigger').click();
      const tzDialog = page.getByTestId('schedule-timezone-modal');
      await expect(tzDialog).toBeVisible();
      await expectBoxInsideViewport(await tzDialog.boundingBox(), viewport.width, 'timezone dialog');
      await page.getByTestId('timezone-search-input').fill('Karachi');
      await page.getByTestId('timezone-option-Asia/Karachi').click();
      await page.getByTestId('proceed-to-step2-button').click();
      await expect(page.getByTestId('timezone-impact-metrics')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
