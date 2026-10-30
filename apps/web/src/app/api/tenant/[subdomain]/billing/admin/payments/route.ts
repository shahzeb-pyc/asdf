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
 * Pending payments first, then the most recent decided ones.
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

  try {
    const { data, error } = await client
      .from('subscription_payments')
      .select(
        'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,period_id,approved_at,created_at'
      )
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (error) throw error;
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
    const sorted = [...payments].sort((a, b) => {
      const rank = (status: string) => (status === 'pending' ? 0 : 1);
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
      return b.createdAt.localeCompare(a.createdAt);
    });
    return NextResponse.json({
      payments: sorted.map((payment) => ({
        ...mapPaymentToItem(payment),
        userId: payment.userId,
        userEmail: emails.get(payment.userId) ?? null,
      })),
      page,
    });
  } catch (err) {
    logServerError('[billing] admin payments failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Payments could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}
