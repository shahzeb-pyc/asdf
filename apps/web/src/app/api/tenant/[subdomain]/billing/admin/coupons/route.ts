import { type NextRequest, NextResponse } from 'next/server';
import {
  CreateCouponRequestSchema,
  normalizeCouponCode,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { couponFromRow, couponToItem } from '@/lib/billing/coupons';

/**
 * GET /api/tenant/[subdomain]/billing/admin/coupons
 * Admin only, fail closed: non-admins get 403 and no data.
 * Newest first, 20 per page. Redemption counts are exact COUNT
 * queries (head-only, one per listed coupon, in parallel) — the
 * rows themselves are never fetched for a count, so a busy
 * percent-multi coupon cannot blow up the list response.
 *
 * POST /api/tenant/[subdomain]/billing/admin/coupons
 * Admin only. Creates a coupon with an admin-chosen code,
 * normalised (trimmed, upper-cased) and unique across ALL
 * statuses — a deleted code stays taken, so history can never
 * be confused with a reissued code.
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
  const PAGE_SIZE = 20;

  try {
    const { data, error } = await client
      .from('coupons')
      .select(
        'id,code,kind,percent,initial_balance_pkr,remaining_balance_pkr,consumed_at,status,created_by,created_at,updated_at'
      )
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (error) throw error;
    const coupons = (Array.isArray(data) ? data : [])
      .map((row) => couponFromRow(row as Record<string, unknown>))
      .filter((coupon) => coupon !== null);
    const counts = await Promise.all(
      coupons.map(async (coupon) => {
        const { count, error: countError } = await client
          .from('coupon_redemptions')
          .select('id', { count: 'exact', head: true })
          .eq('coupon_id', coupon.id);
        if (countError) throw countError;
        return count ?? 0;
      })
    );
    return NextResponse.json({
      coupons: coupons.map((coupon, index) => couponToItem(coupon, counts[index] ?? 0)),
      page,
    });
  } catch (err) {
    logServerError('[billing] admin coupons list failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Coupons could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}

export async function POST(
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

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The coupon request could not be read.' },
      { status: 400 }
    );
  }
  const parsed = CreateCouponRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Percent coupons need a percent (1–100); balance coupons need a PKR value, not a percent.',
      },
      { status: 400 }
    );
  }
  const { kind, percent, valuePkr } = parsed.data;
  const code = normalizeCouponCode(parsed.data.code);

  try {
    const { data: existing } = await client
      .from('coupons')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: 'DUPLICATE_CODE', message: 'A coupon with this code already exists.' },
        { status: 409 }
      );
    }
    const { data, error } = await client
      .from('coupons')
      .insert({
        code,
        kind,
        percent: kind === 'balance' ? null : percent ?? null,
        initial_balance_pkr: kind === 'balance' ? valuePkr ?? null : null,
        remaining_balance_pkr: kind === 'balance' ? valuePkr ?? null : null,
        status: 'active',
        created_by: auth.session.userId,
      })
      .select(
        'id,code,kind,percent,initial_balance_pkr,remaining_balance_pkr,consumed_at,status,created_by,created_at,updated_at'
      )
      .single();
    if (error) {
      // A concurrent create of the same code trips the unique
      // index; that is a duplicate, not a 500.
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'DUPLICATE_CODE', message: 'A coupon with this code already exists.' },
          { status: 409 }
        );
      }
      throw error;
    }
    const coupon = couponFromRow(data as Record<string, unknown>);
    if (!coupon) throw new Error('Coupon insert returned an unreadable row');
    return NextResponse.json(couponToItem(coupon, 0), { status: 201 });
  } catch (err) {
    logServerError('[billing] admin coupon create failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'The coupon could not be created. Please try again.' },
      { status: 500 }
    );
  }
}
