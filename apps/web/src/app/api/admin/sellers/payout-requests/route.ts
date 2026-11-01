import { type NextRequest, NextResponse } from 'next/server';
import { authenticateAdminRoute } from '@/lib/route-auth';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { listAdminPayoutRequests, SellerError } from '@/lib/billing/sellers';
import { sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';

/** GET /api/admin/sellers/payout-requests — admin queue. */
export async function GET(
  request: NextRequest
): Promise<NextResponse> {
  const auth = await authenticateAdminRoute(request);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }

  const pageParam = Number(request.nextUrl.searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const PAGE_SIZE = 20;

  try {
    const { requests, total } = await listAdminPayoutRequests(
      client,
      PAGE_SIZE,
      (page - 1) * PAGE_SIZE
    );
    return NextResponse.json({
      requests: requests.map((r) => ({
        id: r.id,
        sellerId: r.sellerId,
        sellerName: r.sellerNameSnapshot,
        sellerEmail: r.sellerEmailSnapshot,
        totalPkr: r.totalPkr,
        commissionCount: r.commissionCount,
        status: r.status,
        payoutMethod: r.payoutMethodSnapshot,
        payoutAccount: r.payoutAccountSnapshot,
        requestedAt: r.requestedAt,
        decidedAt: r.decidedAt,
      })),
      total,
    });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] admin payout queue failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'Payout requests could not be loaded right now.' }, { status: 500 });
  }
}
