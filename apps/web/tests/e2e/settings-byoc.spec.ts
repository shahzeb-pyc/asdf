/**
 * Flow — Settings BYOC save/test (spec 135 §9, PR-135-4; spec 137
 * §4.6's named e2e candidate for this surface).
 *
 * Drives the rebuilt Facebook tab end to end in the browser:
 * `settings?tab=facebook` → not-connected form with the guide →
 * empty submit (summary + inline, focus to the summary) → fill +
 * Connect (save + auto-test is the submit) → connected state (App
 * ID shown, secret masked, "Connected on" line, "One more step"
 * card hidden) → Edit details (card reappears) → Disconnect via
 * the alert-dialog → not-connected form returns. A second case
 * forces the save route to fail at the network layer and asserts
 * the exact fixed-sentence toast "Could not connect Facebook. Check
 * your connection and try again." (§5.2). A third case, added when the YouTube/X/TikTok
 * explanation tabs were removed from Settings on 2026-10-25,
 * asserts those deep links now land on General at mobile widths,
 * with the General panel (including its Created row) fitting the
 * viewport with no document overflow.
 *
 * Fixture discipline (A3): the BYOC route is intercepted at the
 * browser boundary with a stateful handler registered after the
 * generic fixtures (so it wins for its path) whose payloads satisfy
 * the shipped zod schemas; PUT/DELETE flip the state the next GET
 * serves, exactly like the real route. No real Facebook traffic, no
 * real credentials, no production data.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { expectNoDocumentOverflow } from './fixtures/mobile';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const CONNECTED_AT = '2026-10-16T12:00:00.000Z';

interface ByocFixture {
  fbAppId: string;
  fbAppSecretHint: string | null;
  fbAppName: string | null;
  hasSecret: boolean;
  status: 'unverified' | 'valid' | 'invalid';
  connectedAt: string | null;
}

const NOT_CONNECTED: ByocFixture = {
  fbAppId: '',
  fbAppSecretHint: null,
  fbAppName: null,
  hasSecret: false,
  status: 'unverified',
  connectedAt: null,
};

function byocPayload(state: ByocFixture) {
  return {
    workspaceId: TENANT.userId,
    subdomain: TENANT.subdomain,
    fbAppId: state.fbAppId,
    fbAppSecretHint: state.fbAppSecretHint,
    fbAppName: state.fbAppName,
    hasSecret: state.hasSecret,
    status: state.status,
    lastTestedAt: state.connectedAt,
    connectedAt: state.connectedAt,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Installs the generic fixtures, then the stateful BYOC handler and
 * a schema-valid workspace list on top of them. When
 * `failSaveWithNetworkError` is set, PUTs are aborted at the
 * network layer instead of answered.
 */
async function installSettingsFixtures(
  page: Page,
  options: { failSaveWithNetworkError?: boolean } = {}
): Promise<void> {
  const state = createFixtureState();
  await installApiFixtures(page, state);

  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, {
      workspaces: [
        {
          id: TENANT.userId,
          ownerId: TENANT.userId,
          name: 'E2E Workspace',
          subdomain: TENANT.subdomain,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
  });

  let byoc: ByocFixture = { ...NOT_CONNECTED };
  await page.route(`**/api/tenant/${TENANT.subdomain}/settings/byoc`, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return json(route, byocPayload(byoc));
    }
    if (method === 'PUT') {
      if (options.failSaveWithNetworkError) {
        return route.abort('failed');
      }
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      byoc = {
        fbAppId: typeof body.fbAppId === 'string' ? body.fbAppId : '',
        fbAppSecretHint:
          typeof body.fbAppSecret === 'string'
            ? `••••${body.fbAppSecret.slice(-4)}`
            : byoc.fbAppSecretHint,
        fbAppName: 'E2E Facebook App',
        hasSecret: true,
        status: 'valid',
        connectedAt: CONNECTED_AT,
      };
      return json(route, {
        success: true,
        hasSecret: true,
        status: 'valid',
        connectedAt: CONNECTED_AT,
      });
    }
    if (method === 'DELETE') {
      byoc = { ...NOT_CONNECTED };
      return json(route, { success: true, disconnected: true });
    }
    return route.fallback();
  });
}

test.describe('settings — BYOC save/test flow (spec 135 §9)', () => {
  test('connect → connected state → edit → disconnect, with the form pattern on empty submit', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installSettingsFixtures(page);

    await page.goto(`/tenant/${TENANT.subdomain}/settings?tab=facebook`);

    // Not-connected form with the guide and the "One more step" card.
    await expect(page.getByTestId('fb-connect-btn')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Facebook App' })
    ).toBeVisible();
    await expect(page.getByTestId('fb-one-more-step-card')).toBeVisible();

    // Empty submit: summary + inline, focus moves to the summary,
    // and no save is attempted.
    await page.getByTestId('fb-connect-btn').click();
    const summary = page.locator('[data-slot="form-error-summary"]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Please enter your App ID.');
    await expect(summary).toContainText('Please enter your App Secret.');
    await expect(page.getByTestId('fb-app-id-error')).toHaveText(
      'Please enter your App ID.'
    );
    await expect(summary).toBeFocused();

    // Fill + Connect: save + auto-test is the submit itself.
    await page.getByTestId('fb-app-id-input').fill('123456789012345');
    await page.getByTestId('fb-app-secret-input').fill('e2e-secret-value');
    await page.getByTestId('fb-connect-btn').click();

    // Connected state: App ID shown, secret masked, "Connected on"
    // line, success toast, and the card hidden.
    await expect(page.getByText('Your Facebook app is connected.')).toBeVisible();
    await expect(page.getByTestId('fb-saved-app-name')).toHaveText('E2E Facebook App');
    await expect(page.getByTestId('fb-saved-app-id')).toHaveText('123456789012345');
    await expect(page.getByTestId('fb-saved-app-secret')).toHaveText('•'.repeat(24));
    await expect(page.getByTestId('fb-connected-date')).toHaveText(
      'Connected on Oct 16, 2026.'
    );
    await expect(page.getByTestId('fb-one-more-step-card')).toHaveCount(0);

    // Edit details: the form returns with the App ID pre-filled and
    // the "One more step" card comes back.
    await page.getByTestId('fb-edit-details-btn').click();
    await expect(page.getByTestId('fb-one-more-step-card')).toBeVisible();
    await expect(page.getByTestId('fb-app-id-input')).toHaveValue('123456789012345');
    await page.getByTestId('fb-cancel-edit-btn').click();
    await expect(page.getByTestId('fb-saved-app-id')).toBeVisible();

    // Disconnect via the alert-dialog: verb-named confirm, success
    // toast, and the tab returns to the not-connected form.
    await page.getByTestId('fb-disconnect-btn').click();
    await expect(page.getByTestId('fb-disconnect-modal')).toBeVisible();
    await expect(page.getByTestId('fb-disconnect-title')).toHaveText(
      'Disconnect Facebook?'
    );
    await page.getByTestId('fb-disconnect-confirm-btn').click();

    await expect(
      page.getByText('Your Facebook app has been disconnected.')
    ).toBeVisible();
    await expect(page.getByTestId('fb-connect-btn')).toBeVisible();
    await expect(page.getByTestId('fb-one-more-step-card')).toBeVisible();
  });

  test('network failure on save toasts the fixed sentence, exactly (§5.2)', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installSettingsFixtures(page, { failSaveWithNetworkError: true });

    await page.goto(`/tenant/${TENANT.subdomain}/settings?tab=facebook`);
    await expect(page.getByTestId('fb-connect-btn')).toBeVisible();

    await page.getByTestId('fb-app-id-input').fill('123456789012345');
    await page.getByTestId('fb-app-secret-input').fill('e2e-secret-value');
    await page.getByTestId('fb-connect-btn').click();

    await expect(
      page.getByText('Could not connect Facebook. Check your connection and try again.', { exact: true })
    ).toBeVisible();
    // The tab stays on the form with the input preserved.
    await expect(page.getByTestId('fb-app-id-input')).toHaveValue('123456789012345');
    await expect(page.getByTestId('fb-saved-app-id')).toHaveCount(0);
  });
});

test.describe('settings — removed tabs resolve to General at mobile widths', () => {
  for (const width of [320, 390, 768]) {
    test(`?tab=youtube/x/tiktok lands on General at ${width}px, Created row visible, no overflow`, async ({
      page,
      context,
    }) => {
      await context.addCookies([SESSION_COOKIE]);
      await installSettingsFixtures(page);
      await page.setViewportSize({ width, height: 844 });

      for (const removed of ['youtube', 'x', 'tiktok']) {
        await page.goto(
          `/tenant/${TENANT.subdomain}/settings?tab=${removed}`
        );
        // General is the active tab; the removed tab does not exist.
        await expect(
          page.getByTestId('settings-tab-general')
        ).toHaveAttribute('aria-selected', 'true');
        await expect(
          page.getByTestId(`settings-tab-${removed}`)
        ).toHaveCount(0);
        // General panel: workspace name and the Created row from
        // the fixture workspace (createdAt 2026-10-01).
        await expect(page.getByTestId('workspace-name-display')).toHaveText(
          'E2E Workspace'
        );
        await expect(page.getByTestId('workspace-created-row')).toContainText(
          '1 October 2026'
        );
        await expectNoDocumentOverflow(page);
      }
    });
  }
});
