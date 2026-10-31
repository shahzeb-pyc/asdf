import { type NextRequest, NextResponse } from 'next/server';
import { ReferralCodeChangeSchema } from '@fbuploadpro/contracts';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { changeReferralCode, SellerError } from '@/lib/billing/sellers';
import { authenticateSellerRoute, sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';

/** POST /api/seller/referral-code { code } — change the current code. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateSellerRoute(request);
  if (auth.errorResponse) return auth.errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const parsed = ReferralCodeChangeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid referral code.' }, { status: 400 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    const code = await changeReferralCode(client, auth.session.userId, parsed.data.code);
    return NextResponse.json({ code: code.code });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] referral code change failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'The referral code could not be changed right now.' }, { status: 500 });
  }
}
