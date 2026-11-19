/**
 * Maintenance page (spec 209) — real-browser check.
 *
 * The flag is OFF in the e2e server (the MAINTENANCE_MODE secret is
 * unset here), so the app renders normally and /maintenance is
 * reached directly: this spec proves the page itself in a real
 * browser at phone widths, plus the flag-off normal render and the
 * API bypass. The flag-on rewrite is covered per host by the
 * middleware unit tests (tests/middleware/middleware-maintenance.test.ts),
 * which flip the secret around the calls; a flag-on browser check
 * needs a server started with MAINTENANCE_MODE=true.
 *
 * Note: the e2e server runs on localhost, so the brand here is
 * FBUploadPro; the white-label brand name is covered per host by
 * the unit tests (tests/ui/maintenance-page.test.tsx), since a
 * white-label host cannot be reached from this server.
 */

import { test, expect } from '@playwright/test';
import { expectNoDocumentOverflow, expectWithinViewport } from './fixtures/mobile';

test.describe('maintenance page', () => {
  test('the maintenance page renders directly', async ({ page }) => {
    await page.goto('/maintenance');
    await expect(
      page.getByRole('heading', { name: 'Under maintenance' })
    ).toBeVisible();
    await expect(page.getByText("We'll be back in an hour.")).toBeVisible();
    await expect(page.getByText('FBUploadPro')).toBeVisible();
  });

  test('flag off: the login page renders normally, no maintenance screen', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email Address')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Under maintenance' })
    ).toHaveCount(0);
  });

  test('API routes are unaffected — they still answer JSON', async ({ page }) => {
    const res = await page.request.get('/api/auth/session');
    expect(res.headers()['content-type']).toContain('application/json');
  });

  test('phone width 390: no overflow, content inside the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/maintenance');
    await expectNoDocumentOverflow(page);
    await expectWithinViewport(
      page.getByRole('heading', { name: 'Under maintenance' }),
      page
    );
    await expectWithinViewport(page.getByText("We'll be back in an hour."), page);
  });

  test('narrowest width 320: no overflow, content inside the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/maintenance');
    await expectNoDocumentOverflow(page);
    await expectWithinViewport(
      page.getByRole('heading', { name: 'Under maintenance' }),
      page
    );
    await expectWithinViewport(page.getByText("We'll be back in an hour."), page);
  });
});
