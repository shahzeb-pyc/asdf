import { type NextRequest, NextResponse } from 'next/server';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { getEntitlement, paymentFromRow } from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  mapEntitlementToResponse,
  mapPaymentToItem,
} from '@/lib/billing/route-helpers';

/**
 * GET /api/tenant/[subdomain]/billing
 * The signed-in user's entitlement plus their own payment history.
 * Admins use the admin payments route instead; this route never
 * returns another user's payments.
 * Bounded: 50 rows per page, `?page=` (default 1) pages through
 * them — the full table is never returned in one response.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const { session } = auth;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  const pageParam = Number(request.nextUrl.searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const PAGE_SIZE = 50;

  try {
    const entitlement = await getEntitlement(client, session.userId);
    const { data, error } = await client
      .from('subscription_payments')
      .select(
        'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at'
      )
      .eq('user_id', session.userId)
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (error) throw error;
    const payments = (Array.isArray(data) ? data : [])
      .map((row) => paymentFromRow(row as Record<string, unknown>))
      .filter((payment) => payment !== null)
      .map((payment) => mapPaymentToItem(payment));
    return NextResponse.json({
      entitlement: mapEntitlementToResponse(entitlement),
      payments,
      page,
    });
  } catch (err) {
    logServerError('[billing] status failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your billing details could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}
