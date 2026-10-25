/**
 * Flow — Signup → OTP (spec 136 PR-136B, T15; spec 137 §4.6 e2e growth).
 *
 * Both API calls are intercepted at the browser boundary (the suite's
 * standing pattern): the details submit returns the OTP-required body
 * the real route sends, and verify-otp returns the activation body
 * whose redirect the page hands to `completeAuthRedirect` — here aimed
 * at `/login` so the flow's end is observable without a tenant session.
 *
 * Rule 28 evidence: the code is entered by PASTING it whole (real
 * clipboard + Ctrl+V), never typed digit by digit; the field carries
 * `autocomplete="one-time-code"`.
 *
 * Mobile gate (spec 136): the same flow is exercised at 320 / 390 / 768
 * CSS px with no document overflow, controls inside the viewport, and
 * primary targets at the compact 40px (lg) control height.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  expectMinTouchHeight,
  expectNoDocumentOverflow,
  expectWithinViewport,
} from './fixtures/mobile';

const SIGNUP_USER = {
  name: 'Jane Doe',
  phone: '+1 202 555 0199',
  email: 'jane.doe@gmail.com',
  password: 'correct-password',
};

async function interceptSignupApis(page: Page) {
  await page.route('**/api/auth/signup', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        requiresOtp: true,
        cooldownSecondsRemaining: 60,
        email: SIGNUP_USER.email,
        message: 'A 6-digit verification code has been sent to your Gmail address.',
      }),
    })
  );
  await page.route('**/api/auth/signup/verify-otp', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: SIGNUP_USER.email,
          name: SIGNUP_USER.name,
          subdomain: 'janedoe',
          role: 'admin',
          status: 'active',
        },
        redirectUrl: '/login',
      }),
    })
  );
}

async function fillDetailsForm(page: Page) {
  await page.getByLabel('Full Name').fill(SIGNUP_USER.name);
  await page.getByLabel('Phone Number').fill(SIGNUP_USER.phone);
  await page.getByLabel('Email Address').fill(SIGNUP_USER.email);
  await page.getByLabel('Password', { exact: true }).fill(SIGNUP_USER.password);
  await page.getByLabel('Confirm Password').fill(SIGNUP_USER.password);
}

test.describe('signup → OTP', () => {
  test('details submit lands on the OTP step; the pasted code verifies and hands off', async ({
    page,
    context,
  }) => {
    await interceptSignupApis(page);
    await page.goto('/signup');
    await fillDetailsForm(page);
    await page.getByRole('button', { name: 'Create Account' }).click();

    await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();
    await expect(page.getByText(SIGNUP_USER.email, { exact: true })).toBeVisible();
    const otp = page.getByLabel('6-Digit Verification Code');
    await expect(otp).toBeVisible();
    await expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
    // Resend starts disabled with the countdown as its visible reason.
    const resend = page.getByRole('button', { name: 'Resend code in 60s' });
    await expect(resend).toBeDisabled();

    // Paste the code whole from the real clipboard (Rule 28).
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate((code) => navigator.clipboard.writeText(code), '123456');
    await otp.click();
    await page.keyboard.press('Control+V');
    await expect(otp).toHaveValue('123456');

    await page.getByRole('button', { name: 'Verify & Activate Account' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  });

  test('empty submit shows every field error inline and makes no signup request', async ({
    page,
  }) => {
    let signupRequests = 0;
    await page.route('**/api/auth/signup', (route) => {
      signupRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/signup');
    await page.getByRole('button', { name: 'Create Account' }).click();

    // PR #5 removed the FormErrorSummary box from auth pages: every field
    // error renders inline under its own field, and no summary box exists
    // at all. The messages are the schema messages, now asserted at their
    // inline locations instead of in the box.
    await expect(page.locator('[data-slot="form-error-summary"]')).toHaveCount(0);
    await expect(page.locator('#signup-name-message')).toHaveText('Full name is required.');
    await expect(page.locator('#signup-password-message')).toHaveText('Password is required.');
    await expect(page.locator('#signup-email-message')).toHaveText(
      'A valid email address is required.'
    );
    expect(signupRequests).toBe(0);
  });

  test('incomplete code errors inline without a verify request', async ({ page }) => {
    let verifyRequests = 0;
    await interceptSignupApis(page);
    await page.route('**/api/auth/signup/verify-otp', (route) => {
      verifyRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/signup');
    await fillDetailsForm(page);
    await page.getByRole('button', { name: 'Create Account' }).click();

    const otp = page.getByLabel('6-Digit Verification Code');
    await otp.fill('123');
    await page.getByRole('button', { name: 'Verify & Activate Account' }).click();
    await expect(page.locator('#signup-otp-code-message')).toHaveText(
      'Please enter the complete 6-digit verification code.'
    );
    expect(verifyRequests).toBe(0);
  });

  for (const width of [320, 390, 768]) {
    test(`signup + OTP fit a ${width}px viewport with compact 40px primary targets`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await interceptSignupApis(page);
      await page.goto('/signup');

      const createButton = page.getByRole('button', { name: 'Create Account' });
      await expect(createButton).toBeVisible();
      await expectMinTouchHeight(createButton, 40);
      await expectNoDocumentOverflow(page);
      await fillDetailsForm(page);
      await expectWithinViewport(createButton, page);
      await createButton.click();

      const otp = page.getByLabel('6-Digit Verification Code');
      await expect(otp).toBeVisible();
      await expectWithinViewport(otp, page);
      const verifyButton = page.getByRole('button', { name: 'Verify & Activate Account' });
      await expectMinTouchHeight(verifyButton, 40);
      await expectWithinViewport(verifyButton, page);
      await expectNoDocumentOverflow(page);

      await otp.fill('123456');
      await verifyButton.click();
      await expect(page).toHaveURL(/\/login$/);
    });
  }
});
