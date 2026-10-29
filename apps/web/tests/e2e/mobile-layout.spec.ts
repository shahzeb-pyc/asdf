/**
 * Mobile layout evidence (spec 142, PR-M142-3; closes M142-INFRA-001).
 *
 * Runs ONLY on the six mobile projects (see playwright.config.ts):
 * mobile-320, mobile-360, mobile-390, mobile-430, mobile-768, and
 * mobile-1024 — the full spec 142 §2 viewport matrix (compact phone
 * 320/360, standard phone 390/430, tablet portrait 768, tablet
 * landscape 1024). The desktop `chromium` project ignores this spec and
 * the mobile projects match only this spec, so the desktop critical
 * flows are not re-run per width.
 *
 * Each project gives both hermetic routes below evidence at its own
 * width (12 tests across the matrix):
 * - `/login`, including the failed-sign-in error line (PR #5 removed the
 *   error-summary box from auth pages; the server error is a plain rose
 *   line now).
 * - The fixture workspace home (`/tenant/<subdomain>` on the tenant
 *   subdomain).
 *
 * Assertions are honest to what this PR owns: no document-level
 * horizontal overflow, and the key controls geometrically inside the
 * viewport, at every width. Touch-height assertions are deliberately
 * NOT made on the login controls here — that geometry lands in
 * PR-M142-1 on a separate branch. The `expectMinTouchHeight` helper
 * stays in fixtures/mobile.ts for that slice and surface suites to
 * adopt.
 *
 * PR-M142-1 adds the tall-dialog case at the bottom of this file: the
 * shared Dialog geometry (F04/F05) proven at mobile-320 against the
 * app's own compiled CSS.
 */

import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import {
  expectMinTouchHeight,
  expectNoDocumentOverflow,
  expectWithinViewport,
} from './fixtures/mobile';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

/**
 * The project name carries its width (`mobile-320` … `mobile-1024`);
 * assert the live viewport really is that width so a misconfigured
 * project cannot silently produce evidence for the wrong size.
 */
function expectProjectViewport(page: Page, testInfo: TestInfo): void {
  const match = /^mobile-(\d+)$/.exec(testInfo.project.name);
  if (!match) {
    throw new Error(`mobile-layout spec ran on unexpected project "${testInfo.project.name}"`);
  }
  const expectedWidth = Number(match[1]);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('expectProjectViewport: page has no viewport');
  expect(viewport.width, 'project viewport width must match the project name').toBe(expectedWidth);
}

test.describe('mobile layout', () => {
  test('login fits the viewport; the error line stays inside it', async (
    { page },
    testInfo
  ) => {
    expectProjectViewport(page, testInfo);
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid email or password' }),
      })
    );

    await page.goto('/login');
    const email = page.getByLabel('Email Address');
    const password = page.getByLabel('Password', { exact: true });
    const signIn = page.getByRole('button', { name: 'Sign In' });
    await expect(email).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expectWithinViewport(email, page);
    await expectWithinViewport(password, page);
    await expectWithinViewport(signIn, page);

    await email.fill(TENANT.email);
    await password.fill(TENANT.wrongPassword);
    await signIn.click();

    // PR #5 removed the FormErrorSummary box from auth pages: the server
    // error is a plain rose line (role="alert"), and the viewport
    // assertion now applies to that line. Note the selector: the line is
    // a <p role="alert"> whose text is NOT its accessible name, so
    // getByRole('alert', { name }) does not match it — match the <p>
    // itself and filter by its text instead.
    await expect(page.locator('[data-slot="form-error-summary"]')).toHaveCount(0);
    const errorLine = page.locator('p[role="alert"]', {
      hasText: 'Invalid email or password',
    });
    await expect(errorLine).toBeVisible();
    await expectWithinViewport(errorLine, page);
    await expectNoDocumentOverflow(page);
  });

  test('workspace home fits the viewport', async ({ page, context }, testInfo) => {
    expectProjectViewport(page, testInfo);
    await context.addCookies([
      SESSION_COOKIE,
      { ...SESSION_COOKIE, domain: `${TENANT.subdomain}.localhost` },
    ]);
    const state = createFixtureState();
    await installApiFixtures(page, state);

    await page.goto(`http://${TENANT.subdomain}.localhost:3100/tenant/${TENANT.subdomain}`);
    const heading = page.getByRole('heading', { name: /Workspace:/ });
    await expect(heading).toBeVisible();
    await expect(page.getByText('Welcome to your FBUploadPro workspace.')).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expectWithinViewport(heading, page);
    await expectWithinViewport(
      page.getByText('Welcome to your FBUploadPro workspace.'),
      page
    );
    const topbar = page.getByTestId('workspace-topbar');
    await expect(topbar).toBeVisible();
    await expectWithinViewport(topbar, page);
    // The current shell renders two "Toggle Sidebar" buttons at tablet
    // widths and above (sidebar + topbar); assert on the visible one.
    // Duplicate-control cleanup belongs to the spec 130 shell rebuild.
    const sidebarTrigger = page
      .getByRole('button', { name: 'Toggle Sidebar' })
      .filter({ visible: true })
      .first();
    await expect(sidebarTrigger).toBeVisible();
    await expectWithinViewport(sidebarTrigger, page);
    await expectNoDocumentOverflow(page);
  });
});

/**
 * Tall-dialog geometry (spec 142 F04/F05, PR-M142-1).
 *
 * No shipped route renders the shared Dialog primitive yet — surfaces
 * adopt it in specs 130–136 — so this case cannot open a real surface
 * dialog. Instead it renders a harness page whose markup is the
 * primitive's exact rendered output (the DialogContent, close-button,
 * footer and Button class contracts as of this PR, copied from
 * dialog.tsx / button.tsx) styled by the app's own compiled stylesheet
 * (the same CSS bundle /login ships). That proves the geometry
 * contract those classes produce in a real browser: 16px gutters,
 * dvh-bounded height, internal scrolling, reachable footer actions,
 * and compact 36px targets (classes refreshed to the compact primitives, 2026-10-24). When a surface ships a shared Dialog, a
 * surface-owned case should supersede this harness.
 */
test.describe('mobile layout — shared dialog geometry (PR-M142-1)', () => {
  test('tall dialog at 320px: gutters, dvh bound, internal scroll, Action/Cancel reachable', async (
    { page },
    testInfo
  ) => {
    test.skip(
      testInfo.project.name !== 'mobile-320',
      'the tall-dialog case is specified at mobile-320 only'
    );
    // A short viewport as well as a narrow one: 320×480.
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto('/login');
    const cssHrefs = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((links) =>
        links
          .map((link) => link.getAttribute('href'))
          .filter((href): href is string => Boolean(href))
      );
    expect(cssHrefs.length, 'the app ships a compiled stylesheet').toBeGreaterThan(0);

    const buttonBase =
      'inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-body font-medium whitespace-nowrap transition-colors duration-base ease-standard outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:pointer-events-none disabled:opacity-50';
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) =>
        `<p>Paragraph ${i + 1}: deleting this workspace removes every queued post, media item and connected account for all members, and cannot be undone.</p>`
    ).join('');
    await page.setContent(`<!DOCTYPE html>
<html>
  <head>
    ${cssHrefs.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
  </head>
  <body>
    <div data-slot="dialog-overlay" class="fixed inset-0 z-dialog bg-neutral-black/60"></div>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="harness-dialog-title"
      data-slot="dialog-content"
      class="fixed inset-x-4 top-1/2 z-dialog grid max-h-dvh -translate-y-1/2 gap-4 overflow-y-auto rounded-md border border-line bg-panel p-5 text-ink shadow-modal duration-base outline-none sm:right-auto sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2"
    >
      <div data-slot="dialog-header" class="flex flex-col gap-2 text-left">
        <h2 id="harness-dialog-title" data-slot="dialog-title" class="text-lg leading-heading font-semibold">
          Delete this workspace?
        </h2>
        <p data-slot="dialog-description" class="text-body text-ink-sub">
          Read the consequences in full before confirming.
        </p>
      </div>
      <div class="flex flex-col gap-3 text-body">${paragraphs}</div>
      <div data-slot="dialog-footer" class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" data-slot="button" class="${buttonBase} border border-line bg-panel text-ink shadow-card hover:bg-hover h-control px-3 py-2">
          Cancel
        </button>
        <button type="button" data-slot="button" class="${buttonBase} bg-brand-rose text-neutral-white hover:bg-brand-rose/90 focus-visible:outline-signal-critical h-control px-3 py-2">
          Delete workspace
        </button>
      </div>
      <button
        type="button"
        data-slot="dialog-close"
        aria-label="Close"
        class="absolute top-1 right-1 inline-flex size-9 items-center justify-center rounded-sm text-ink-sub outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:pointer-events-none"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 6 6 18"></path>
          <path d="m6 6 12 12"></path>
        </svg>
        <span class="sr-only">Close</span>
      </button>
    </div>
  </body>
</html>`);

    const panel = page.locator('[data-slot="dialog-content"]');
    await expect(panel).toBeVisible();
    // The compiled stylesheet is applied (the panel is really fixed).
    await expect
      .poll(() => panel.evaluate((el) => getComputedStyle(el).position))
      .toBe('fixed');

    const viewport = page.viewportSize();
    if (!viewport) throw new Error('dialog case: page has no viewport');
    const panelBox = await panel.boundingBox();
    if (!panelBox) throw new Error('dialog case: panel has no bounding box');
    // F04: 16px gutters on both sides — never edge-to-edge at 320px.
    expect(panelBox.x, 'dialog left gutter').toBeGreaterThanOrEqual(12);
    expect(panelBox.x + panelBox.width, 'dialog right edge inside the viewport').toBeLessThanOrEqual(
      viewport.width - 12
    );
    // F04: height bounded by the (dynamic) viewport, top on screen.
    expect(panelBox.y, 'dialog top must be on screen').toBeGreaterThanOrEqual(-1);
    expect(panelBox.height, 'dialog height must not exceed the viewport height').toBeLessThanOrEqual(
      viewport.height + 1
    );
    // Tall content scrolls inside the panel; the document never scrolls sideways.
    const scrollable = await panel.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable, 'tall dialog content must overflow the panel internally').toBe(true);
    await expectNoDocumentOverflow(page);

    // F05/F01 as amended (compact default density — Shahzeb 2026-10-24, spec 129 OD-4 as amended): close and footer actions are compact 36px targets. The harness class copies above were refreshed to the current dialog.tsx / button.tsx classes in the same change.
    const close = page.getByRole('button', { name: 'Close' });
    await expectMinTouchHeight(close, 36);
    const closeBox = await close.boundingBox();
    if (!closeBox) throw new Error('dialog case: close button has no bounding box');
    expect(closeBox.width, 'close target must be at least 36px wide').toBeGreaterThanOrEqual(36);

    // F04: after scrolling the panel, both footer actions are reachable
    // inside the panel and meet the touch minimum.
    await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    for (const name of ['Cancel', 'Delete workspace']) {
      const action = page.getByRole('button', { name });
      await expectMinTouchHeight(action, 36);
      const box = await action.boundingBox();
      if (!box) throw new Error(`dialog case: ${name} has no bounding box`);
      expect(box.y, `${name} must be reachable inside the panel`).toBeGreaterThanOrEqual(
        panelBox.y - 1
      );
      expect(
        box.y + box.height,
        `${name} must be reachable inside the panel`
      ).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
    }
    await expectNoDocumentOverflow(page);
  });
});
