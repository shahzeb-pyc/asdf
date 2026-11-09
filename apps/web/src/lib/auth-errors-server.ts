import { NextResponse } from 'next/server';

import {
  EMAIL_RATE_LIMIT_MESSAGE,
  isEmailRateLimitError,
  sanitizeAuthErrorMessage,
} from './auth-errors';

export interface AuthErrorResponseOptions {
  fallbackMessage?: string;
  defaultStatus?: number;
}

/**
 * Server-side error handler for authentication endpoints.
 * Logs full diagnostic traces internally for server logs while ensuring that
 * client response bodies NEVER contain infrastructure or database details.
 */
export function formatAuthErrorResponse(
  error: unknown,
  options: AuthErrorResponseOptions = {}
): NextResponse<{ error: string; redirectUrl?: string | undefined; requiresOtp?: boolean | undefined; email?: string | undefined; emailRateLimited?: boolean | undefined }> {
  const fallbackMessage =
    options.fallbackMessage || 'Unable to complete your request at this moment. Please try again shortly.';
  const defaultStatus = options.defaultStatus || 500;

  // Log internal diagnostic error to server logs for operator visibility
  console.error('[Auth Error]', error);

  let rawMessage = '';
  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof error === 'string') {
    rawMessage = error;
  }
  const errorObj = error as { code?: string; requiresOtp?: boolean; email?: string; retryAfterSeconds?: number };
  const code = errorObj?.code || '';

  // 1. Requires OTP Handler (403)
  if (code === 'REQUIRES_OTP' || errorObj?.requiresOtp) {
    return NextResponse.json(
      {
        error: rawMessage || 'Please verify your email address to complete registration.',
        requiresOtp: true,
        ...(errorObj?.email ? { email: errorObj.email } : {}),
      },
      { status: 403 }
    );
  }


  // 2. Account Suspended Check (403)
  if (code === 'ACCOUNT_SUSPENDED' || rawMessage.toLowerCase().includes('suspended')) {
    return NextResponse.json(
      {
        error: 'Account is suspended',
        redirectUrl: '/account-suspended',
      },
      { status: 403 }
    );
  }

  // 3. Email Already Registered Check (409)
  if (
    rawMessage.toLowerCase().includes('already registered') ||
    rawMessage.toLowerCase().includes('already exists') ||
    rawMessage.toLowerCase().includes('user already registered')
  ) {
    return NextResponse.json(
      { error: 'Email is already registered' },
      { status: 409 }
    );
  }

  // 3.5. Supabase Auth hourly email budget (429, evaluated before the
  // generic rate-limit branch). No retry timing exists for this error,
  // so the response carries no retryAfterSeconds and no Retry-After
  // header — the UI must not show a countdown for it.
  if (isEmailRateLimitError(error)) {
    return NextResponse.json(
      {
        error: EMAIL_RATE_LIMIT_MESSAGE,
        emailRateLimited: true,
      },
      { status: 429 }
    );
  }

  // 4. Rate Limit / Cooldown / Lockout Check (429 - evaluated before general 400 validation)
  const isRateLimited =
    code === 'RATE_LIMITED' ||
    rawMessage.toLowerCase().includes('for security purposes') ||
    rawMessage.toLowerCase().includes('too many') ||
    rawMessage.toLowerCase().includes('temporarily locked') ||
    /after\s+(\d+)\s+seconds/i.test(rawMessage);

  if (isRateLimited) {
    const match = /after\s+(\d+)\s+seconds/i.exec(rawMessage);
    const retryAfter = match
      ? Number.parseInt(match[1], 10)
      : errorObj?.retryAfterSeconds || 60;
    const sanitizedMsg = rawMessage.toLowerCase().includes('temporarily locked')
      ? rawMessage
      : `For security purposes, please wait ${retryAfter} second${
          retryAfter === 1 ? '' : 's'
        } before requesting another verification code.`;

    return NextResponse.json(
      {
        error: sanitizedMsg,
        retryAfterSeconds: retryAfter,
        cooldownSecondsRemaining: retryAfter,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      }
    );
  }

  // 5. Invalid Credentials Check (401)
  if (
    rawMessage.toLowerCase().includes('invalid email or password') ||
    rawMessage.toLowerCase().includes('invalid login credentials') ||
    rawMessage.toLowerCase().includes('invalid_grant')
  ) {
    return NextResponse.json(
      { error: 'Invalid email or password' },
      { status: 401 }
    );
  }

  // 6. Safe Client Validation Messages (400)
  if (
    rawMessage.includes('Password must be at least') ||
    rawMessage.includes('Password cannot exceed') ||
    rawMessage.includes('valid email address is required') ||
    rawMessage.includes('Only @gmail.com') ||
    rawMessage.includes('Passwords do not match') ||
    rawMessage.includes('Invalid or expired') ||
    rawMessage.includes('Invalid verification code') ||
    rawMessage.includes('Verification code has expired') ||
    rawMessage.includes('No pending registration found') ||
    rawMessage.includes('reset link has expired') ||
    rawMessage.includes('token is required')
  ) {
    return NextResponse.json({ error: rawMessage }, { status: 400 });
  }

  // 7. Default/Unexpected Failure (Never leak technical details!)
  return NextResponse.json(
    { error: sanitizeAuthErrorMessage(rawMessage, fallbackMessage) },
    { status: defaultStatus }
  );
}
