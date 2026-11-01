/**
 * Flow 1 — Login (spec 137-A3, T34; updated by PR-A6, T54).
 *
 * - Success (admin): valid credentials → the admin lands on the admin
 *   panel (Billing → approvals view), never on Home — even when the
 *   login response carries a Home-bound redirectUrl, the middleware
 *   Home redirect sends the admin session to the panel. The fixture
 *   deliberately keeps a Home-bound redirectUrl so the test proves
 *   that leg; the server's own admin redirect is covered by the
 *   auth-redirect unit tests.
 * - Success (non-admin): valid credentials → the app navigates to the
 *   workspace home, which renders for real (middleware + tenant layout
 *   verify the session cookie the login response sets).
 * - Wrong password: the server error now renders once as a plain rose
 *   line (`role="alert"`) — PR #5 removed the FormErrorSummary box from
 *   auth pages, so there is no summary to focus — and the typed input
 *   is preserved.
 * - Client validation: a non-Gmail address errors inline only (the
 *   summary entry that used to link to the field is gone with the box),
 *   without any login request.
 * - Session-expired notice (§3.1 contract, landed by PR-A6): arriving
 *   with `?reason=session-expired` renders the plain-language notice —
 *   this replaces PR-A3's pinned count-0 assertion.
 */

import { test, expect } from '@playwright/test';
import { SESSION_COOKIE, TENANT, mintSessionToken } from './fixtures/tenant';
import { expectNoDocumentOverflow } from './fixtures/mobile';

test.describe('login', () => {
  test('success signs an admin in and lands on the admin panel, not home', async ({
    page,
    context,
  }) => {
    await page.route('**/api/auth/login', async (route) => {
      // The real login response sets the session cookie scoped to the root
      // domain (production: .fbuploadpro.com), so it is valid on the tenant
      // subdomain the app redirects to. Chrome treats localhost cookies as
      // host-only, so the fixture plants the same session cookie for both
      // hosts involved — the localhost equivalent of that one cookie.
      await context.addCookies([
        { ...SESSION_COOKIE, value: mintSessionToken('admin') },
        { ...SESSION_COOKIE, value: mintSessionToken('admin'), domain: `${TENANT.subdomain}.localhost` },
      ]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          redirectUrl: `/tenant/${TENANT.subdomain}`,
          user: {
            id: TENANT.userId,
            email: TENANT.email,
            name: TENANT.name,
            subdomain: TENANT.subdomain,
            role: 'admin',
            status: 'active',
          },
        }),
      });
    });

    // The approvals view loads its payments on mount; fixture it so
    // the panel assertion never depends on the dummy-env API.
    await page.route(`**/api/admin/payments`, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ payments: [] }),
      });
    });

    await page.goto('/login');
    await page.getByLabel('Email Address').fill(TENANT.email);
    await page.getByLabel('Password', { exact: true }).fill(TENANT.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Post-login the app navigates to the mocked tenant home URL,
    // but an admin session is redirected by middleware to the admin
    // section instead.
    await expect(page).toHaveURL(/\/admin\/subscriptions$/);
    await expect(
      page.getByRole('heading', { name: 'Subscriptions approval' })
    ).toBeVisible();
  });

  test('success signs a non-admin in and lands on the workspace home', async ({
    page,
    context,
  }) => {
    await page.route('**/api/auth/login', async (route) => {
      // Same cookie-planting as the admin test, but with a user-role
      // session: non-admin landing is unchanged (workspace home).
      await context.addCookies([
        { ...SESSION_COOKIE, value: mintSessionToken('user') },
        {
          ...SESSION_COOKIE,
          value: mintSessionToken('user'),
          domain: `${TENANT.subdomain}.localhost`,
        },
      ]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          redirectUrl: `/tenant/${TENANT.subdomain}`,
          user: {
            id: TENANT.userId,
            email: TENANT.email,
            name: TENANT.name,
            subdomain: TENANT.subdomain,
            role: 'user',
            status: 'active',
          },
        }),
      });
    });

    await page.goto('/login');
    await page.getByLabel('Email Address').fill(TENANT.email);
    await page.getByLabel('Password', { exact: true }).fill(TENANT.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Post-login the app navigates to the tenant subdomain home. The
    // login stub returns the prefixed home (/tenant/e2e), but URL
    // normalization redirects it to the clean home on the tenant's
    // own host (http://e2e.localhost:3100/) — the prefix must never
    // appear in the address bar there.
    await expect(page).toHaveURL(
      new RegExp(`${TENANT.subdomain}\\.localhost:3100/$`)
    );
    await expect(
      page.getByRole('heading', { name: /Welcome,/ })
    ).toBeVisible();
    await expect(page.getByText('Your workspace at a glance.')).toBeVisible();
  });

  test('wrong password shows the error as a plain rose line and keeps the input', async ({
    page,
  }) => {
    // The real route's wrong-credentials response (lib/auth-errors.ts):
    // 401 { error: 'Invalid email or password' }.
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid email or password' }),
      })
    );

    await page.goto('/login');
    await page.getByLabel('Email Address').fill(TENANT.email);
    await page.getByLabel('Password', { exact: true }).fill(TENANT.wrongPassword);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // PR #5 removed the FormErrorSummary box from auth pages: the server
    // error renders once as a plain rose line (role="alert", not focused),
    // and no summary box exists at all. Note the selector: the line is a
    // <p role="alert"> whose text is NOT its accessible name, so
    // getByRole('alert', { name }) does not match it — match the <p>
    // itself and filter by its text instead.
    await expect(page.locator('[data-slot="form-error-summary"]')).toHaveCount(0);
    await expect(
      page.locator('p[role="alert"]', { hasText: 'Invalid email or password' })
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    // A failed submit never clears what the user typed.
    await expect(page.getByLabel('Email Address')).toHaveValue(TENANT.email);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(TENANT.wrongPassword);
  });

  test('client-side validation marks a non-Gmail address inline only without a request', async ({
    page,
  }) => {
    let loginRequests = 0;
    await page.route('**/api/auth/login', (route) => {
      loginRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/login');
    await page.getByLabel('Email Address').fill('owner@example.com');
    await page.getByLabel('Password', { exact: true }).fill(TENANT.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Inline message under the field — and nowhere else. PR #5 removed
    // the summary box, so the identical wording must NOT appear as a
    // summary entry linking to the field.
    const inline = page.locator('#login-email-message');
    await expect(inline).toHaveText(
      'Only @gmail.com (or @googlemail.com) accounts are supported.'
    );
    await expect(page.locator('[data-slot="form-error-summary"]')).toHaveCount(0);
    await expect(page.getByLabel('Email Address')).toHaveAttribute('aria-invalid', 'true');
    expect(loginRequests).toBe(0);
  });

  test('session-expired return renders the session-expired notice (§3.1, PR-A6)', async ({
    page,
  }) => {
    await page.goto('/login?next=%2Ftenant%2Fe2e&reason=session-expired');
    await expect(
      page.getByText('Your session expired — sign in again to pick up where you left off')
    ).toBeVisible();
    await expect(page.getByLabel('Email Address')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });
});

test.describe('old-users migration notice at 360px', () => {
  test.use({ viewport: { width: 360, height: 720 } });

  test('login shows the migration notice above the form, no overflow', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('old-users-notice-banner')).toBeVisible();
    await expect(page.getByTestId('old-users-notice-banner')).toContainText(
      'Old fbuploadpro users'
    );
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
});
