import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { canonicalizeGmailAddress } from '@fbuploadpro/contracts';
import { formatAuthErrorResponse } from '@/lib/auth-errors-server';
import { checkRateLimit, extractClientIp, RATE_LIMIT_WINDOW_MS } from '@/lib/rate-limiter';
import { bodyTooLargeResponse, readJsonBody } from '@/lib/request-body';
import { resendPasswordResetOtpViaSupabase } from '@/lib/auth/password-reset';

export async function POST(request: NextRequest) {
  try {
    const clientIp = extractClientIp(request.headers);

    // 1. IP rate limiting (max 5 resend requests per 60 seconds)
    const ipLimit = await checkRateLimit(`forgot_resend:ip:${clientIp}`, 5, RATE_LIMIT_WINDOW_MS);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many requests. Please wait ${ipLimit.retryAfterSeconds} seconds before requesting a new code.`,
          retryAfterSeconds: ipLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(ipLimit.retryAfterSeconds) },
        }
      );
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }
    const body = bodyResult.value as { email?: unknown } | null;
    const email = body?.email;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'A valid email address is required.' },
        { status: 400 }
      );
    }

    let canonicalEmail: string;
    try {
      canonicalEmail = canonicalizeGmailAddress(email);
    } catch {
      return NextResponse.json(
        { error: 'Only @gmail.com (or @googlemail.com) email addresses are permitted.' },
        { status: 400 }
      );
    }

    // 2. Identifier rate limiting (max 3 resend requests per 60 seconds per email)
    const emailLimit = await checkRateLimit(`forgot_resend:email:${canonicalEmail}`, 3, RATE_LIMIT_WINDOW_MS);
    if (!emailLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many requests for this email address. Please wait ${emailLimit.retryAfterSeconds} seconds.`,
          retryAfterSeconds: emailLimit.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    // 3. Resend OTP via Supabase Auth (or test fallback) subject to cooldown and lockout
    const resendResult = await resendPasswordResetOtpViaSupabase(canonicalEmail);
    if (!resendResult.success) {
      return NextResponse.json(
        {
          error: resendResult.error || 'Unable to resend verification code.',
          cooldownSecondsRemaining: resendResult.cooldownSecondsRemaining,
        },
        { status: 429 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `A new 6-digit verification code has been sent to ${canonicalEmail}.`,
    });
  } catch (error: unknown) {
    return formatAuthErrorResponse(error, {
      fallbackMessage: 'Unable to process your request at this moment. Please try again shortly.',
      defaultStatus: 500,
    });
  }
}
