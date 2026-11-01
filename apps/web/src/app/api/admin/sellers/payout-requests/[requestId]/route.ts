import { type NextRequest, NextResponse } from 'next/server';
import { PayoutDecisionSchema } from '@fbuploadpro/contracts';
import { authenticateAdminRoute } from '@/lib/route-auth';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { decidePayoutRequest, SellerError } from '@/lib/billing/sellers';
import { sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';

/**
 * POST /api/admin/sellers/payout-requests/[requestId]
 * { action: 'mark-sent' | 'reject' } — admin only. Mark-sent pays
 * the whole batch outside the app; reject returns the commissions
 * to payable. Terminal decisions conflict (409).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> }
): Promise<NextResponse> {
  const { requestId } = await context.params;
  const auth = await authenticateAdminRoute(request);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const parsed = PayoutDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payout decision.' }, { status: 400 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }

  try {
    await decidePayoutRequest(client, requestId, auth.session.userId, parsed.data.action);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] payout decision failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'The payout decision could not be saved right now.' }, { status: 500 });
  }
}
