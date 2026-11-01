import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SignupRequestSchema, isSignupEnabled, normalizeReferralCode } from '@fbuploadpro/contracts';
import { signUpTenantUser } from '@/lib/auth/signup';
import { formatAuthErrorResponse } from '@/lib/auth-errors';
import { checkRateLimit, extractClientIp, RATE_LIMIT_WINDOW_MS } from '@/lib/rate-limiter';
import { bodyTooLargeResponse, readJsonBody } from '@/lib/request-body';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { resolveReferralCode } from '@/lib/billing/sellers';

export async function POST(request: NextRequest) {
  try {
    // 0. Server-side registration pause guard
    if (!isSignupEnabled()) {
      return NextResponse.json(
        {
          error: 'Account registration is temporarily paused. Please check back shortly or sign in to your existing account.',
        },
        { status: 403 }
      );
    }

    const clientIp = extractClientIp(request.headers);

    // 1. IP rate limiting (max 5 signup OTP requests per 60 seconds)
    const ipLimit = await checkRateLimit(`signup:ip:${clientIp}`, 5, RATE_LIMIT_WINDOW_MS);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many registration attempts. Please wait ${ipLimit.retryAfterSeconds} seconds before trying again.`,
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
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }
    const body: unknown = bodyResult.value;
    const parseResult = SignupRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const canonicalEmail = parseResult.data.email;

    // 2. Email identifier rate limiting (max 3 requests per 60 seconds per email)
    const emailLimit = await checkRateLimit(`signup:email:${canonicalEmail}`, 3, RATE_LIMIT_WINDOW_MS);
    if (!emailLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many verification requests for this email address. Please wait ${emailLimit.retryAfterSeconds} seconds.`,
          retryAfterSeconds: emailLimit.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    // 3. Resolve the referral code server-side (the page pre-check
    // is UX only). An invalid or paused seller's code is a 400 —
    // never a silent unattributed signup for a code the user
    // actually submitted. Without a server client (local dev)
    // the code cannot be resolved and is dropped, matching the
    // page's behaviour on a 503 from the validate endpoint.
    let referral: { sellerId: string; code: string } | undefined;
    if (parseResult.data.referralCode) {
      const client = getBillingAdminClient();
      if (client) {
        const resolved = await resolveReferralCode(client, parseResult.data.referralCode);
        if (!resolved) {
          return NextResponse.json(
            { error: 'This referral code is no longer valid. You can still create your account without it.' },
            { status: 400 }
          );
        }
        referral = {
          sellerId: resolved.sellerId,
          code: normalizeReferralCode(parseResult.data.referralCode),
        };
      }
    }

    // 4. Initiate or resume registration and dispatch OTP via Supabase Auth
    const { referralCode: _submittedCode, ...signupParams } = parseResult.data;
    void _submittedCode;
    const signupResult = await signUpTenantUser({ ...signupParams, referral });

    return NextResponse.json(
      {
        success: true,
        requiresOtp: signupResult.requiresOtp,
        cooldownSecondsRemaining: signupResult.cooldownSecondsRemaining,
        email: canonicalEmail,
        message: 'A 6-digit verification code has been sent to your Gmail address.',
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    return formatAuthErrorResponse(error, {
      fallbackMessage: 'Unable to initiate account registration. Please try again shortly.',
      defaultStatus: 500,
    });
  }
}
