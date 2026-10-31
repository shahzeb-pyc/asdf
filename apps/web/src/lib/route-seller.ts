import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getSessionSecret,
  verifySessionToken,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { SellerError } from '@/lib/billing/sellers';

/**
 * Session auth for top-level seller routes (/api/seller/*).
 * Sellers have no workspace, so the tenant authenticator does
 * not apply: the only checks are a valid, active session whose
 * role is exactly 'seller'. Anything else is 401/403 — a user
 * or admin session must never reach seller data.
 */
export async function authenticateSellerRoute(request: NextRequest): Promise<
  | { session: SessionPayload; errorResponse?: never }
  | { session?: never; errorResponse: NextResponse }
> {
  const sessionSecret = getSessionSecret();
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  let session: SessionPayload;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const { validateSessionActive } = await import('@/lib/auth/session');
  const isActive = await validateSessionActive(session);
  if (!isActive) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  if (session.role !== 'seller') {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { session };
}

/** Map a SellerError code to its HTTP status (fail loud, never 200). */
export function sellerErrorResponse(err: SellerError): NextResponse {
  const status =
    err.code === 'SELLER_NOT_FOUND' || err.code === 'PAYOUT_REQUEST_NOT_FOUND'
      ? 404
      : err.code === 'SELLER_EMAIL_EXISTS' ||
          err.code === 'REFERRAL_CODE_TAKEN' ||
          err.code === 'PAYOUT_REQUEST_ALREADY_DECIDED' ||
          err.code === 'SELLER_HAS_UNPAID_COMMISSIONS'
        ? 409
        : err.code === 'PAYOUT_BELOW_MINIMUM' || err.code === 'PAYOUT_DETAILS_MISSING'
          ? 400
          : 500;
  return NextResponse.json({ error: err.code, message: err.message }, { status });
}
