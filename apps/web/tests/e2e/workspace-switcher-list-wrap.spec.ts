/**
 * Workspace list wraps properly (spec 199) — real-browser check.
 *
 * With 20 workspaces the switcher popover used to grow to ~1,000px
 * tall, taller than a phone viewport, because the workspace list had
 * no container of its own. The fix wraps only the rows in a ~6-row
 * (264px) scroll region; everything else stays pinned outside it.
 *
 * Measured, not asserted from markup: the region's rendered height,
 * its scrollability, the popover fitting the viewport, the active row
 * being inside the region on open, and the header/actions boxes not
 * moving when the region is scrolled to the bottom — at desktop
 * (1280x720) and phone (390x844) widths. Switching and single-click
 * navigation are exercised for real against the intercepted switch
 * route and the sidebar nav.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the layout and the workspaces routes below; nothing leaves
 * the test machine. The production build itself (routing, middleware
 * session verification, tenant layout, components) runs for real.
 */

import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';

const SUB = TENANT.subdomain;

const USER_SESSION_COOKIE = {
  ...SESSION_COOKIE,
  value: mintSessionToken('user', ['beta']),
};

// Twenty workspaces; the active one sits deep in the list (index 14),
// so "open scrolled to the current workspace" is observable — it
// must be inside the region on open, not scrolled out of sight.
const WORKSPACES = Array.from({ length: 20 }, (_, i) => {
  if (i === 14) {
    return {
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: TENANT.userId,
      name: 'E2E Workspace',
      subdomain: SUB,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
  }
  return {
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    ownerId: TENANT.userId,
    name: `Workspace ${i + 1}`,
    subdomain: `ws${i + 1}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
});

async function installSwitcherFixtures(page: Page): Promise<void> {
  const state = createFixtureState();
  await installApiFixtures(page, state);
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: WORKSPACES }),
    });
  });
  await page.route('**/api/workspaces/switch', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as { subdomain: string };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        targetSubdomain: body.subdomain,
        redirectUrl: `/tenant/${SUB}`,
      }),
    });
  });
}

async function signInToTenantHome(page: Page): Promise<void> {
  await page.context().addCookies([USER_SESSION_COOKIE]);
  await installSwitcherFixtures(page);
  await page.goto(`/tenant/${SUB}`);
  await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
}

async function openSwitcher(page: Page): Promise<void> {
  await page.getByTestId('workspace-switcher-trigger').click();
  await expect(page.getByTestId('workspace-list-scroll-region')).toBeVisible();
  await expect(page.getByTestId('workspace-option-ws1')).toBeVisible();
}

test.describe('workspace list wrap at desktop width (spec 199)', () => {
  test('list scrolls inside a 264px region; header and actions never move', async ({
    page,
  }) => {
    await signInToTenantHome(page);
    await openSwitcher(page);

    const region = page.getByTestId('workspace-list-scroll-region');
    const regionBox = await region.boundingBox();
    expect(regionBox).not.toBeNull();
    // ~6 rows: 6 x 44px rows capped at max-h-66 (264px).
    expect(regionBox?.height).toBeGreaterThanOrEqual(263);
    expect(regionBox?.height).toBeLessThanOrEqual(265);
    // The 20 rows overflow the region: it really scrolls.
    expect(
      await region.evaluate((el) => el.scrollHeight > el.clientHeight)
    ).toBe(true);

    // The whole popover fits the 720px viewport.
    const popover = page.getByTestId('workspace-switcher-dropdown');
    const popoverBox = await popover.boundingBox();
    expect(popoverBox).not.toBeNull();
    expect(popoverBox?.y).toBeGreaterThanOrEqual(0);
    expect((popoverBox?.y ?? 0) + (popoverBox?.height ?? 0)).toBeLessThanOrEqual(720);

    // The active row (deep in the list) is inside the region on open.
    const activeRow = page.getByTestId(`workspace-option-${SUB}`);
    const activeBox = await activeRow.boundingBox();
    expect(activeBox).not.toBeNull();
    expect(activeBox?.y).toBeGreaterThanOrEqual(regionBox?.y ?? 0);
    expect((activeBox?.y ?? 0) + (activeBox?.height ?? 0)).toBeLessThanOrEqual(
      (regionBox?.y ?? 0) + (regionBox?.height ?? 0)
    );

    // Pinned chrome: record the boxes, scroll the region to the
    // bottom, and confirm nothing outside it moved.
    const pinned = popover.getByText('Workspaces', { exact: true });
    const create = page.getByTestId('create-workspace-button');
    const settings = page.getByTestId('workspace-settings-button');
    const signOut = page.getByTestId('logout-button');
    const before = {
      label: await pinned.boundingBox(),
      create: await create.boundingBox(),
      settings: await settings.boundingBox(),
      signOut: await signOut.boundingBox(),
    };
    await region.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await pinned.boundingBox()).toEqual(before.label);
    expect(await create.boundingBox()).toEqual(before.create);
    expect(await settings.boundingBox()).toEqual(before.settings);
    expect(await signOut.boundingBox()).toEqual(before.signOut);

    // The last workspace is reachable by scrolling inside the region.
    const lastRow = page.getByTestId('workspace-option-ws20');
    const lastBox = await lastRow.boundingBox();
    const regionBoxAfter = await region.boundingBox();
    expect(lastBox).not.toBeNull();
    expect(lastBox?.y).toBeGreaterThanOrEqual(regionBoxAfter?.y ?? 0);
    expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual(
      (regionBoxAfter?.y ?? 0) + (regionBoxAfter?.height ?? 0)
    );
  });

  test('switching still works from inside the scroll region', async ({ page }) => {
    await signInToTenantHome(page);
    await openSwitcher(page);

    const switchRequest = page.waitForRequest(
      (request) =>
        request.url().includes('/api/workspaces/switch') && request.method() === 'POST'
    );
    await page.getByTestId('workspace-option-ws5').click();
    const request = await switchRequest;
    expect((request.postDataJSON() as { subdomain: string }).subdomain).toBe('ws5');

    // The switch redirects (here back to the same home) and the page
    // loads again.
    await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/?$`));
  });

  test('single-click navigation is intact', async ({ page }) => {
    await signInToTenantHome(page);

    await page.getByRole('link', { name: /^Media Library/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${SUB}/media$`));
  });
});

test.describe('workspace list wrap at phone width (spec 199)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('popover fits the phone viewport; list scrolls inside, actions stay put', async ({
    page,
  }) => {
    await signInToTenantHome(page);

    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().tap();
    await page.getByTestId('workspace-switcher-trigger').tap();
    await expect(page.getByTestId('workspace-list-scroll-region')).toBeVisible();
    await expect(page.getByTestId('workspace-option-ws1')).toBeVisible();

    const region = page.getByTestId('workspace-list-scroll-region');
    const regionBox = await region.boundingBox();
    expect(regionBox).not.toBeNull();
    expect(regionBox?.height).toBeGreaterThanOrEqual(263);
    expect(regionBox?.height).toBeLessThanOrEqual(265);
    expect(
      await region.evaluate((el) => el.scrollHeight > el.clientHeight)
    ).toBe(true);

    const popover = page.getByTestId('workspace-switcher-dropdown');
    const popoverBox = await popover.boundingBox();
    expect(popoverBox).not.toBeNull();
    expect(popoverBox?.y).toBeGreaterThanOrEqual(0);
    expect((popoverBox?.y ?? 0) + (popoverBox?.height ?? 0)).toBeLessThanOrEqual(844);

    // Create / Settings / Sign Out are visible without scrolling the page.
    await expect(page.getByTestId('create-workspace-button')).toBeVisible();
    await expect(page.getByTestId('workspace-settings-button')).toBeVisible();
    await expect(page.getByTestId('logout-button')).toBeVisible();

    // Scroll the region to the bottom: the pinned rows do not move.
    const create = page.getByTestId('create-workspace-button');
    const signOut = page.getByTestId('logout-button');
    const beforeCreate = await create.boundingBox();
    const beforeSignOut = await signOut.boundingBox();
    await region.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await create.boundingBox()).toEqual(beforeCreate);
    expect(await signOut.boundingBox()).toEqual(beforeSignOut);

    // The last workspace is reachable inside the region.
    const lastRow = page.getByTestId('workspace-option-ws20');
    const lastBox = await lastRow.boundingBox();
    const regionBoxAfter = await region.boundingBox();
    expect(lastBox).not.toBeNull();
    expect(lastBox?.y).toBeGreaterThanOrEqual(regionBoxAfter?.y ?? 0);
    expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual(
      (regionBoxAfter?.y ?? 0) + (regionBoxAfter?.height ?? 0)
    );
  });
});
