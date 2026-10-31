import { type NextRequest, NextResponse } from 'next/server';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  getCurrentReferralCode,
  getSellerBalances,
  getSellerPayoutDetails,
  getSellerPurchaserCount,
  getSellerSettings,
  getSellerSignupCount,
  listReferralCodes,
  refreshSellerCommissions,
  SellerError,
} from '@/lib/billing/sellers';
import { authenticateSellerRoute, sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';

/** GET /api/seller/dashboard — the seller's own overview. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateSellerRoute(request);
  if (auth.errorResponse) return auth.errorResponse;
  const sellerId = auth.session.userId;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    await refreshSellerCommissions(client, sellerId);
    const settings = await getSellerSettings(client, sellerId);
    if (!settings) {
      return NextResponse.json(
        { error: 'Seller profile could not be found.' },
        { status: 500 }
      );
    }
    const userRow = await client.from('users').select('name,email').eq('id', sellerId).maybeSingle();
    const userData =
      userRow.data !== null && typeof userRow.data === 'object'
        ? (userRow.data as Record<string, unknown>)
        : null;
    const name = typeof userData?.['name'] === 'string' ? userData['name'] : null;
    const email = typeof userData?.['email'] === 'string' ? userData['email'] : '';
    const codes = await listReferralCodes(client, sellerId);
    const current = await getCurrentReferralCode(client, sellerId);
    const host = request.headers.get('host') ?? '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
    const referralLink = current ? `${protocol}://${host}/signup?ref=${current}` : null;
    const [signups, purchasers, balances, payoutDetails] = await Promise.all([
      getSellerSignupCount(client, sellerId),
      getSellerPurchaserCount(client, sellerId),
      getSellerBalances(client, sellerId),
      getSellerPayoutDetails(client, sellerId),
    ]);
    return NextResponse.json({
      sellerId,
      name,
      email,
      rate: settings.rate,
      scope: settings.scope,
      status: settings.status,
      currentCode: current ?? null,
      codes: codes.map((c) => ({ code: c.code, current: c.current, createdAt: c.createdAt })),
      referralLink,
      signups,
      purchasers,
      balances,
      payoutDetails: payoutDetails
        ? { method: payoutDetails.method, accountLabel: payoutDetails.accountLabel }
        : null,
    });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] dashboard failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'Seller dashboard could not be loaded right now.' }, { status: 500 });
  }
}
