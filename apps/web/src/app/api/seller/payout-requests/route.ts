import { type NextRequest, NextResponse } from 'next/server';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  listSellerPayoutRequests,
  requestPayout,
  SellerError,
} from '@/lib/billing/sellers';
import { authenticateSellerRoute, sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';
import { parsePaginationParams } from '@/lib/server/pagination';

/** GET /api/seller/payout-requests — own requests, newest first. */
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
    const { requests, total } = await listSellerPayoutRequests(
      client,
      auth.session.userId,
      limit,
      offset
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
    logServerError('[sellers] payout request list failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'Payout requests could not be loaded right now.' }, { status: 500 });
  }
}

/** POST /api/seller/payout-requests — request payout of all payables. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateSellerRoute(request);
  if (auth.errorResponse) return auth.errorResponse;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    const result = await requestPayout(client, auth.session.userId);
    return NextResponse.json({
      request: {
        id: result.request.id,
        sellerId: result.request.sellerId,
        sellerName: result.request.sellerNameSnapshot,
        sellerEmail: result.request.sellerEmailSnapshot,
        totalPkr: result.request.totalPkr,
        commissionCount: result.count,
        status: result.request.status,
        payoutMethod: result.request.payoutMethodSnapshot,
        payoutAccount: result.request.payoutAccountSnapshot,
        requestedAt: result.request.requestedAt,
        decidedAt: null,
      },
      count: result.count,
    });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] payout request failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'The payout request could not be created right now.' }, { status: 500 });
  }
}
