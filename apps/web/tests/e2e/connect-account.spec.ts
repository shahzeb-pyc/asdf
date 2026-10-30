/**
 * Flow 2 — Connect account (spec 137-A3, T34).
 *
 * Drives the real connect journey in the browser: Accounts page → connect
 * modal → "This Browser" → the app's own `/api/auth/facebook` entry route
 * → Facebook's OAuth dialog → the app's own callback route
 * `/api/auth/facebook/callback` → back on Accounts with the success
 * notice and the connected account rendered.
 *
 * Interception boundaries (no real third-party traffic, ever):
 * - The OAuth entry + dialog + callback *navigations* carry fixture
 *   payloads, fulfilled via `page.route`. Each hop answers with a
 *   meta-refresh page pointing at the next hop's URL (the same Locations
 *   the real 302s would carry): Playwright does not re-route redirects
 *   issued by fulfilled responses cross-origin, while a meta-refresh
 *   navigation is routed normally — the chain the browser walks is
 *   identical.
 * - The callback route's server-side Graph exchange and database writes
 *   cannot be intercepted from the browser; the fixture fulfils the
 *   redirect the route issues on success (`?connected=1`), which is the
 *   contract the Accounts page consumes. Server-side coverage of the
 *   callback handler itself lives in the node suites
 *   (tests/api/connect-framework.test.ts, tests/api/auth-facebook.test.ts).
 * - The Accounts page's own API reads are fixture-served
 *   (fixtures/api.ts); after "connection", the accounts fixture returns
 *   the connected account.
 */

import { test, expect, type Route } from '@playwright/test';
import {
  CONNECTED_ACCOUNT,
  createFixtureState,
  installApiFixtures,
} from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

/** Answers a navigation with a page that immediately refreshes to `location`. */
function redirectViaRefresh(route: Route, location: string) {
  const escaped = location.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><meta http-equiv="refresh" content="0; url=${escaped}"><a href="${escaped}">Continue</a>`,
  });
}

test.describe('connect account', () => {
  test('connects a Facebook account through the app callback routes', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    const state = createFixtureState();
    await installApiFixtures(page, state);

    await page.goto(`/tenant/${TENANT.subdomain}/accounts`);
    await expect(page.getByRole('button', { name: 'Connect Facebook Account' })).toBeVisible();

    // 1. Open the connect modal and choose the direct (this-browser) path.
    await page.getByRole('button', { name: 'Connect Facebook Account' }).click();
    await expect(page.getByTestId('connect-account-modal')).toBeVisible();

    // 2. The direct path navigates to the app's OAuth entry route; answer
    //    with the redirect it issues to Facebook's dialog (fixture state).
    await page.route('**/api/auth/facebook**', (route) =>
      redirectViaRefresh(
        route,
        'https://www.facebook.com/v26.0/dialog/oauth?client_id=123456789012345' +
          `&redirect_uri=${encodeURIComponent(
            'http://localhost:3100/api/auth/facebook/callback'
          )}&state=e2e-fixture-state&scope=pages_manage_posts`
      )
    );
    // 3. Facebook's dialog is intercepted and returns to the app's own
    //    callback route with a fixture authorization code.
    await page.route('https://www.facebook.com/**', (route) =>
      redirectViaRefresh(
        route,
        'http://localhost:3100/api/auth/facebook/callback' +
          '?code=e2e-fixture-code&state=e2e-fixture-state'
      )
    );
    // 4. The callback route, on success, redirects back to Accounts with
    //    the connected notice params (see header note).
    await page.route('**/api/auth/facebook/callback**', (route) =>
      redirectViaRefresh(
        route,
        `/tenant/${TENANT.subdomain}/accounts?connected=1&accountName=${encodeURIComponent(
          CONNECTED_ACCOUNT.displayName
        )}`
      )
    );

    // From this point the account exists in the fixture state.
    state.accounts = [CONNECTED_ACCOUNT];

    await page.getByTestId('connect-option-direct').click();

    // 5. Back on Accounts: top-right toast naming the account + the
    // connected account card (Option B dialogue — no generic banner).
    // (.first(): the accounts page renders the account in both the
    // legacy card and the unified social list the fixtures now serve —
    // either rendering proves the account is on the page.)
    await expect(page).toHaveURL(new RegExp(`/tenant/${TENANT.subdomain}/accounts`));
    // The OAuth chain ends in a full page load, and the success toast
    // only fires once the fixture-served accounts query settles (the
    // shell's OAuth-notice effect waits out its loading state). On CI
    // runners that load alone exceeds the 5s default — the first load
    // in this same test took ~5.4s — so wait for the grid (the same
    // settled-data signal the toast waits on) with a longer window
    // before asserting the toast, which is then up for its 4s life.
    await expect(page.getByTestId('accounts-grid')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(`${CONNECTED_ACCOUNT.displayName} connected`)).toBeVisible();
    await expect(page.getByText(CONNECTED_ACCOUNT.displayName).first()).toBeVisible();
  });
});
