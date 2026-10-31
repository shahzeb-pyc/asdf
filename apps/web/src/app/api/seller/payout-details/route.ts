import { type NextRequest, NextResponse } from 'next/server';
import { SellerPayoutDetailsSchema } from '@fbuploadpro/contracts';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { saveSellerPayoutDetails, SellerError } from '@/lib/billing/sellers';
import { authenticateSellerRoute, sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';

/** PUT /api/seller/payout-details — save the seller's payout method. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateSellerRoute(request);
  if (auth.errorResponse) return auth.errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const parsed = SellerPayoutDetailsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payout details.' }, { status: 400 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    await saveSellerPayoutDetails(client, auth.session.userId, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] payout details save failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'Payout details could not be saved right now.' }, { status: 500 });
  }
}
