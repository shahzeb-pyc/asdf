import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { resolveReferralCode } from '@/lib/billing/sellers';
import { checkRateLimit, extractClientIp, RATE_LIMIT_WINDOW_MS } from '@/lib/rate-limiter';
import { logServerError } from '@/lib/server-analytics';

/**
 * GET /api/referral/validate?code=
 * Public by necessity: the signup page shows "Referred by {name}"
 * before any account exists. Only the seller's display name is
 * ever returned — never an email, id, or stats. IP rate-limited
 * so codes cannot be enumerated at will. A missing server
 * client (local dev without Supabase) is a 503, and the signup
 * page treats any non-200 as "check unavailable" and proceeds
 * without a referrer.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientIp = extractClientIp(request.headers);
  const limit = await checkRateLimit(`referral-validate:ip:${clientIp}`, 10, RATE_LIMIT_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many referral checks. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  const code = request.nextUrl.searchParams.get('code') ?? '';
  const parsed = z.string().trim().min(1).max(32).safeParse(code);
  if (!parsed.success) {
    return NextResponse.json({ valid: false, sellerName: null });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    const resolved = await resolveReferralCode(client, parsed.data);
    if (!resolved) {
      return NextResponse.json({ valid: false, sellerName: null });
    }
    return NextResponse.json({ valid: true, sellerName: resolved.sellerName });
  } catch (err) {
    logServerError('[sellers] referral validate failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'The referral code could not be checked right now.' }, { status: 500 });
  }
}
