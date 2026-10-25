/**
 * Flow — Forgot → Reset (spec 136 PR-136C, T23; spec 137 §4.6 e2e
 * growth).
 *
 * All three recovery API calls are intercepted at the browser boundary
 * (the suite's standing pattern): the email step returns the code-sent
 * body the real route sends, and the reset submit returns the success
 * body — the flow then closes the loop on `/login?reset=success` with
 * the §3.2 reset-success banner visible (the page's own 2,000 ms timed
 * redirect is what lands it there; the login route's API calls are
 * never made because the test ends on the banner).
 *
 * Rule 28 evidence: the code is entered by PASTING it whole (real
 * clipboard + Ctrl+V), never typed digit by digit; the field carries
 * `autocomplete="one-time-code"` and both password fields carry
 * `autocomplete="new-password"` with show/hide toggles.
 *
 * Mobile gate (spec 136): the same flow is exercised at 320 / 390 /
 * 768 CSS px with no document overflow, controls inside the viewport,
 * and primary targets at the compact 40px (lg) control height.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  expectMinTouchHeight,
  expectNoDocumentOverflow,
  expectWithinViewport,
} from './fixtures/mobile';

const EMAIL = 'jane.doe@gmail.com';
const NEW_PASSWORD = 'correct-new-password';

async function interceptRecoveryApis(page: Page) {
  await page.route('**/api/auth/forgot-password', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        requiresOtp: true,
        email: EMAIL,
        message: `A 6-digit verification code has been sent to ${EMAIL}.`,
      }),
    })
  );
  await page.route('**/api/auth/reset-password', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: 'Your password has been successfully updated.',
      }),
    })
  );
}

async function gotoStep2(page: Page) {
  await page.goto('/forgot-password');
  await page.getByLabel('Email Address').fill(EMAIL);
  await page.getByRole('button', { name: 'Send Verification Code' }).click();
  await expect(page.getByRole('heading', { name: 'Set New Password' })).toBeVisible();
  await expect(
    page.getByText(`Enter the 6-digit verification code sent to ${EMAIL} and your new password.`)
  ).toBeVisible();
}

test.describe('forgot → reset', () => {
  test('email step, pasted code + new password, success state, timed redirect to the login banner', async ({
    page,
    context,
  }) => {
    await interceptRecoveryApis(page);
    await gotoStep2(page);

    const code = page.getByLabel('Verification Code');
    await expect(code).toBeVisible();
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    // Resend starts disabled with the countdown as its label (§4.3.2).
    await expect(page.getByRole('button', { name: 'Resend code (60s)' })).toBeDisabled();

    const password = page.getByLabel('New Password', { exact: true });
    await expect(password).toHaveAttribute('autocomplete', 'new-password');
    await expect(page.getByRole('button', { name: 'Show password' }).first()).toBeVisible();

    // Paste the code whole from the real clipboard (Rule 28).
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate((value) => navigator.clipboard.writeText(value), '123456');
    await code.click();
    await page.keyboard.press('Control+V');
    await expect(code).toHaveValue('123456');

    await password.fill(NEW_PASSWORD);
    await page.getByLabel('Confirm New Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Update Password' }).click();

    // Success state first (§4.3.3), then the 2,000 ms timed redirect
    // closes the loop on the login page's reset-success banner.
    await expect(page.getByText('Password Updated')).toBeVisible();
    await expect(
      page.getByText('Your password has been successfully reset. Redirecting you to sign in...')
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login\?reset=success$/, { timeout: 10_000 });
    await expect(page.getByText('Password Updated')).toBeVisible();
    await expect(
      page.getByText(
        'Your password has been successfully reset. Please sign in with your new credentials.'
      )
    ).toBeVisible();
  });

  test('empty step-1 submit shows the Gmail error inline and makes no request', async ({
    page,
  }) => {
    let requests = 0;
    await page.route('**/api/auth/forgot-password', (route) => {
      requests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/forgot-password');
    await page.getByRole('button', { name: 'Send Verification Code' }).click();

    // PR #5 removed the FormErrorSummary box from auth pages: the error
    // renders inline only, and no summary box exists at all.
    await expect(page.locator('[data-slot="form-error-summary"]')).toHaveCount(0);
    await expect(page.locator('#forgot-email-message')).toHaveText(
      'Please enter a valid Gmail address.'
    );
    expect(requests).toBe(0);
  });

  test('incomplete code errors inline without a reset request', async ({ page }) => {
    let resetRequests = 0;
    await interceptRecoveryApis(page);
    await page.route('**/api/auth/reset-password', (route) => {
      resetRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await gotoStep2(page);
    await page.getByLabel('Verification Code').fill('123');
    await page.getByLabel('New Password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm New Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Update Password' }).click();

    await expect(page.locator('#forgot-otp-message')).toHaveText(
      'Verification code must be exactly 6 digits.'
    );
    expect(resetRequests).toBe(0);
  });

  test('reset stub explains, then redirects to /forgot-password with a manual action', async ({
    page,
  }) => {
    await page.goto('/reset-password');
    await expect(page.getByRole('heading', { name: 'Password Recovery' })).toBeVisible();
    await expect(page.getByText('Redirecting to Password Recovery')).toBeVisible();
    await expect(
      page.getByText(
        'Password recovery is now handled directly using a 6-digit code. Redirecting you to the recovery page...'
      )
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Go to Password Recovery' })
    ).toHaveAttribute('href', '/forgot-password');
    // The 1,500 ms timed redirect (OD-136-5) lands on the recovery page.
    await expect(page).toHaveURL(/\/forgot-password$/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Reset Password' })).toBeVisible();
  });

  for (const width of [320, 390, 768]) {
    test(`recovery forms fit a ${width}px viewport with compact 40px primary targets`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await interceptRecoveryApis(page);
      await page.goto('/forgot-password');

      const sendButton = page.getByRole('button', { name: 'Send Verification Code' });
      await expect(sendButton).toBeVisible();
      await expectMinTouchHeight(sendButton, 40);
      await expectNoDocumentOverflow(page);
      await page.getByLabel('Email Address').fill(EMAIL);
      await expectWithinViewport(sendButton, page);
      await sendButton.click();

      const code = page.getByLabel('Verification Code');
      await expect(code).toBeVisible();
      await expectWithinViewport(code, page);
      const updateButton = page.getByRole('button', { name: 'Update Password' });
      await expectMinTouchHeight(updateButton, 40);
      await expectWithinViewport(updateButton, page);
      await expectNoDocumentOverflow(page);

      await code.fill('123456');
      await page.getByLabel('New Password', { exact: true }).fill(NEW_PASSWORD);
      await page.getByLabel('Confirm New Password').fill(NEW_PASSWORD);
      await updateButton.click();
      await expect(page).toHaveURL(/\/login\?reset=success$/, { timeout: 10_000 });
    });
  }
});
