import { type NextRequest, NextResponse } from 'next/server';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { redemptionFromRow } from '@/lib/billing/coupons';

/**
 * GET /api/tenant/[subdomain]/billing/admin/coupons/[couponId]/redemptions
 * Admin only, fail closed. The redemption history for one coupon:
 * who used it, when, how much, and whether the redemption is held,
 * applied, or released. Newest first, 100 per page — the table is
 * never returned whole (a percent-multi coupon accumulates rows
 * without bound). The coupon's own row is looked up first so an
 * unknown id is a 404, not an empty list.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; couponId: string }> }
): Promise<NextResponse> {
  const { subdomain, couponId } = await context.params;
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
    const { data: couponRow, error: couponError } = await client
      .from('coupons')
      .select('id,code')
      .eq('id', couponId)
      .maybeSingle();
    if (couponError) throw couponError;
    if (!couponRow) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'That coupon was not found.' }, { status: 404 });
    }
    const couponCode = (couponRow as { code?: unknown }).code;
    const { data, error } = await client
      .from('coupon_redemptions')
      .select('id,coupon_id,coupon_kind,user_id,payment_id,period_id,amount_pkr,status,balance_restored,created_at,updated_at')
      .eq('coupon_id', couponId)
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (error) throw error;
    const redemptions = (Array.isArray(data) ? data : [])
      .map((row) => redemptionFromRow(row as Record<string, unknown>))
      .filter((redemption) => redemption !== null);
    const userIds = Array.from(new Set(redemptions.map((redemption) => redemption.userId)));
    let emails = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: users } = await client.from('users').select('id,email').in('id', userIds);
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
      redemptions: redemptions.map((redemption) => ({
        id: redemption.id,
        couponId: redemption.couponId,
        couponCode: typeof couponCode === 'string' ? couponCode : '',
        userId: redemption.userId,
        userEmail: emails.get(redemption.userId) ?? null,
        paymentId: redemption.paymentId,
        periodId: redemption.periodId,
        amountPkr: redemption.amountPkr,
        status: redemption.status,
        createdAt: redemption.createdAt,
      })),
      page,
    });
  } catch (err) {
    logServerError('[billing] admin coupon redemptions failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Redemptions could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}
