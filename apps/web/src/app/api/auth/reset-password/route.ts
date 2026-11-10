import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  resetUserPassword,
  resetUserPasswordWithOtp,
} from '@/lib/auth/password-reset';
import { formatAuthErrorResponse } from '@/lib/auth-errors-server';
import { checkRateLimit, extractClientIp, RATE_LIMIT_WINDOW_MS } from '@/lib/rate-limiter';
import { bodyTooLargeResponse, readJsonBody } from '@/lib/request-body';

function extractRecoveryToken(token: unknown, code: unknown): string | undefined {
  if (typeof token === 'string' && token.trim()) {
    return token.trim();
  }
  if (typeof code === 'string' && code.trim()) {
    return code.trim();
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  try {
    const clientIp = extractClientIp(request.headers);

    // 1. IP rate limiting (max 5 password reset attempts per 60 seconds)
    const ipLimit = await checkRateLimit(`reset_pwd:ip:${clientIp}`, 5, RATE_LIMIT_WINDOW_MS);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many password reset attempts. Please wait ${ipLimit.retryAfterSeconds} seconds before trying again.`,
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
    const body = bodyResult.value as Record<string, unknown> | null;
    const { password, email, otp, token, token_hash, code } = body || {};

    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long.' },
        { status: 400 }
      );
    }

    if (password.length > 128) {
      return NextResponse.json(
        { error: 'Password cannot exceed 128 characters.' },
        { status: 400 }
      );
    }

    const cleanOtp = typeof otp === 'string' ? otp.replace(/\D/g, '').trim() : undefined;
    const rawToken = token || token_hash;
    const recoveryToken = extractRecoveryToken(rawToken, code);

    if (!cleanOtp && !recoveryToken) {
      return NextResponse.json(
        { error: 'A valid 6-digit verification code or recovery token is required.' },
        { status: 400 }
      );
    }

    if (cleanOtp) {
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return NextResponse.json(
          { error: 'Email address is required for verification.' },
          { status: 400 }
        );
      }

      if (cleanOtp.length !== 6) {
        return NextResponse.json(
          { error: 'Verification code must be exactly 6 digits.' },
          { status: 400 }
        );
      }

      const result = await resetUserPasswordWithOtp({
        email,
        otp: cleanOtp,
        password,
      });

      return NextResponse.json({
        success: true,
        message: result.message,
      });
    }

    const isCode = typeof code === 'string' && Boolean(code.trim());
    const isToken = typeof rawToken === 'string' && Boolean(rawToken.trim());

    const result = await resetUserPassword({
      password,
      email: typeof email === 'string' ? email.trim() : undefined,
      token: isToken ? String(rawToken).trim() : (!isCode ? recoveryToken : undefined),
      code: isCode ? String(code).trim() : undefined,
    });

    return NextResponse.json({
      success: true,
      message: result.message,
    });
  } catch (error: unknown) {
    return formatAuthErrorResponse(error, {
      fallbackMessage: 'Unable to reset your password. Your link may have expired or is invalid.',
      defaultStatus: 500,
    });
  }
}
