import { type NextRequest, NextResponse } from 'next/server';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { paymentFromRow } from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  mapPaymentToItem,
} from '@/lib/billing/route-helpers';

/**
 * GET /api/tenant/[subdomain]/billing/admin/payments
 * Admin only, fail closed: non-admins get 403 and no data.
 * Pending payments first, then the most recent decided ones —
 * across the FULL list, not per page (audit fix 2026-11-01): the
 * old code fetched one created_at page and sorted pending-first
 * inside it, so a pending payment on page 2 never surfaced above
 * decided rows on page 1. The list is (all pending, newest first)
 * followed by (all decided, newest first), paged by 100: the page
 * slice is computed from the pending count, so no pending row is
 * ever buried behind a decided one.
 * Bounded: 100 rows per page, `?page=` (default 1) pages through
 * them — the full table is never returned in one response.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  const pageParam = Number(request.nextUrl.searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const PAGE_SIZE = 100;
  const offset = (page - 1) * PAGE_SIZE;

  const PAYMENT_COLUMNS =
    'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at';

  try {
    const { count: pendingTotal, error: countError } = await client
      .from('subscription_payments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (countError) throw countError;
    const pendingCount = typeof pendingTotal === 'number' ? pendingTotal : 0;

    const rows: unknown[] = [];
    // Pending slice for this page, if the page overlaps the pending
    // run at all; then decided rows fill whatever space is left.
    if (offset < pendingCount) {
      const pendingEnd = Math.min(offset + PAGE_SIZE, pendingCount);
      const { data: pendingRows, error: pendingError } = await client
        .from('subscription_payments')
        .select(PAYMENT_COLUMNS)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .range(offset, pendingEnd - 1);
      if (pendingError) throw pendingError;
      rows.push(...(Array.isArray(pendingRows) ? pendingRows : []));
    }
    if (rows.length < PAGE_SIZE) {
      const decidedOffset = Math.max(0, offset - pendingCount);
      const decidedTake = PAGE_SIZE - rows.length;
      const { data: decidedRows, error: decidedError } = await client
        .from('subscription_payments')
        .select(PAYMENT_COLUMNS)
        .neq('status', 'pending')
        .order('created_at', { ascending: false })
        .range(decidedOffset, decidedOffset + decidedTake - 1);
      if (decidedError) throw decidedError;
      rows.push(...(Array.isArray(decidedRows) ? decidedRows : []));
    }
    const data = rows;
    const payments = (Array.isArray(data) ? data : [])
      .map((row) => paymentFromRow(row as Record<string, unknown>))
      .filter((payment) => payment !== null);
    const userIds = Array.from(new Set(payments.map((payment) => payment.userId)));
    let emails = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: users } = await client
        .from('users')
        .select('id,email')
        .in('id', userIds);
      if (Array.isArray(users)) {
        emails = new Map(
          users
            .filter(
              (user): user is { id: string; email: string } =>
                user !== null &&
                typeof user === 'object' &&
                typeof (user as { id: unknown }).id === 'string' &&
                typeof (user as { email: unknown }).email === 'string'
            )
            .map((user) => [user.id, user.email])
        );
      }
    }
    return NextResponse.json({
      payments: payments.map((payment) => ({
        ...mapPaymentToItem(payment),
        userId: payment.userId,
        userEmail: emails.get(payment.userId) ?? null,
      })),
      page,
      pendingTotal: pendingCount,
    });
  } catch (err) {
    logServerError('[billing] admin payments failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Payments could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}
