import { type NextRequest, NextResponse } from 'next/server';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { listReferredUsers, refreshSellerCommissions, SellerError } from '@/lib/billing/sellers';
import { authenticateSellerRoute, sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';
import { parsePaginationParams } from '@/lib/server/pagination';

/** GET /api/seller/referrals — own referred signups, newest first. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateSellerRoute(request);
  if (auth.errorResponse) return auth.errorResponse;
  const { page, limit } = parsePaginationParams(request.nextUrl.searchParams);
  const offset = (page - 1) * limit;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    await refreshSellerCommissions(client, auth.session.userId);
    const { users, total } = await listReferredUsers(client, auth.session.userId, limit, offset);
    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        referralCode: u.referralCode,
        purchased: u.purchased,
        signedUpAt: u.signedUpAt,
      })),
      total,
    });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] referrals list failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'Referrals could not be loaded right now.' }, { status: 500 });
  }
}
