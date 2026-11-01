/**
 * Flow 5 — Shell navigation + workspace switch (spec 130 §5.9,
 * PR-130-2b).
 *
 * The spec-110 regression net at e2e level: sign in (fixture session),
 * click each primary leaf nav item ONCE and assert navigation landed,
 * collapse/expand the sidebar, open the switcher, switch workspace,
 * assert arrival. A second describe runs the same shell at a 390px
 * touch viewport: the drawer opens from the header trigger, every
 * leaf is tappable (no hover-only action), and the document never
 * overflows horizontally (spec 142 mobile gate evidence for the
 * shell at phone width; the 320px case is asserted inside the flow
 * by resizing before opening the switcher).
 *
 * API traffic is fixture-served at the browser boundary
 * (fixtures/api.ts conventions): the workspace list + switch
 * responses are registered after the generic fixtures so they take
 * precedence for `/api/workspaces*`.
 */

import { test, expect, type Page } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { mintSessionToken, SESSION_COOKIE, TENANT } from './fixtures/tenant';

/**
 * Shell navigation is a regular-user behaviour. The shared fixture
 * session is role 'admin', and since the subscription feature an
 * admin sees only the Subscriptions approval sidebar — no user
 * leaves at all — so these tests sign in as a regular user instead.
 */
const USER_SESSION_COOKIE = {
  ...SESSION_COOKIE,
  // A plain user token can only open its own subdomain; the switch
  // step below navigates to beta, so the token names beta as an
  // allowed subdomain (the admin bypass must not be relied on here,
  // since admins see the approvals-only sidebar).
  value: mintSessionToken('user', ['beta']),
};

const WORKSPACES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: TENANT.userId,
    name: 'E2E Workspace',
    subdomain: TENANT.subdomain,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666',
    ownerId: TENANT.userId,
    name: 'Beta Workspace',
    subdomain: 'beta',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

async function installShellFixtures(page: Page): Promise<void> {
  const state = createFixtureState();
  await installApiFixtures(page, state);
  // Registered after the generic fixtures → these win for their paths.
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: WORKSPACES }),
    });
  });
  await page.route('**/api/workspaces/switch', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        targetSubdomain: 'beta',
        redirectUrl: '/tenant/beta',
      }),
    })
  );
}

async function signInToTenantHome(page: Page): Promise<void> {
  await page.context().addCookies([USER_SESSION_COOKIE]);
  await installShellFixtures(page);
  await page.goto(`/tenant/${TENANT.subdomain}`);
  await expect(
    page.getByRole('heading', { name: /Welcome,/ })
  ).toBeVisible();
}

test.describe('shell navigation + workspace switch (spec 130 §5.9)', () => {
  test('single-click leaf navigation, collapse/expand, and workspace switch', async ({
    page,
  }) => {
    await signInToTenantHome(page);

    // Each primary leaf: ONE click navigates (spec 110).
    await page.getByRole('link', { name: /^Media Library/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/media$`));
    await expect(page.getByTestId('workspace-breadcrumb')).toContainText('Media Library');

    // The old Downloader leaf is gone (spec 149: downloads live in the
    // Media Library now); Fdola Studio is the next primary leaf.
    await page.getByRole('link', { name: /^Fdola Studio/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/fdola-studio$`));
    await expect(page.getByTestId('workspace-breadcrumb')).toContainText('Fdola Studio');

    await page.getByRole('link', { name: /^Accounts/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/accounts$`));
    await expect(page.getByTestId('workspace-breadcrumb')).toContainText('Accounts');

    await page.getByRole('link', { name: /^Pages/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/pages$`));
    await expect(page.getByTestId('workspace-breadcrumb')).toContainText('Pages');

    await page.getByRole('link', { name: /^Home/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/?$`));
    await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();

    // Collapse to the icon rail, then expand again — the header
    // trigger and the sidebar are one state (single provider).
    const sidebarRoot = page.locator('[data-slot="sidebar"]');
    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click();
    await expect(sidebarRoot).toHaveAttribute('data-state', 'collapsed');
    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click();
    await expect(sidebarRoot).toHaveAttribute('data-state', 'expanded');

    // Workspace switch: open the footer popover, pick Beta, arrive.
    await page.getByTestId('workspace-switcher-trigger').click();
    await expect(page.getByTestId('workspace-switcher-dropdown')).toBeVisible();
    await page.getByTestId('workspace-option-beta').click();
    await expect(page).toHaveURL(/\/tenant\/beta\/?$/);
    await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
  });
});

async function expectSwitcherPanelHitTestable(page: Page): Promise<void> {
  const dropdown = page.getByTestId('workspace-switcher-dropdown');
  await expect(dropdown).toBeVisible();

  // Visibility alone missed the production bug: the panel rendered
  // underneath the mobile drawer's dim overlay. Its centre must be
  // the topmost hit target, inside the panel itself.
  const centreHitInsidePanel = await dropdown.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    return hit !== null && (hit === element || element.contains(hit));
  });
  expect(centreHitInsidePanel).toBe(true);
}

async function exerciseMobileWorkspaceSwitch(page: Page): Promise<void> {
  await signInToTenantHome(page);
  await page.getByRole('button', { name: 'Toggle Sidebar' }).first().tap();
  await page.getByTestId('workspace-switcher-trigger').tap();
  await expectSwitcherPanelHitTestable(page);

  // A row tap must complete the switch; if the drawer dismisses on
  // pointer-down first, the click never reaches the row.
  await page.getByTestId('workspace-option-beta').tap();
  await expect(page).toHaveURL(/\/tenant\/beta\/?$/);
  await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
}

test.describe('shell navigation at phone width (spec 142 mobile gate)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('drawer navigation is fully tappable and nothing overflows at 390px', async ({
    page,
  }) => {
    await signInToTenantHome(page);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(390);

    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().tap();
    await page.getByRole('link', { name: /^Media Library/ }).tap();
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/media$`));
  });

  test('footer switcher is hit-testable and switches workspace at 390px', async ({
    page,
  }) => {
    await exerciseMobileWorkspaceSwitch(page);
  });

  test('footer switcher is hit-testable and switches workspace at 320px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await exerciseMobileWorkspaceSwitch(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(320);
  });
});
