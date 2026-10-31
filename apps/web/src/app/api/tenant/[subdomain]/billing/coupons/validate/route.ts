import { type NextRequest, NextResponse } from 'next/server';
import {
  CouponValidateRequestSchema,
  totalPricePkr,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import {
  getActivePeriod,
  pricePurchase,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { CouponError, previewCoupon } from '@/lib/billing/coupons';

/**
 * POST /api/tenant/[subdomain]/billing/coupons/validate
 * Server-validated coupon preview for checkout: code validity, the
 * discount, and the new amount due. This route NEVER holds or
 * decrements anything — the hold happens at submission, where the
 * conditional claim is the guard. A preview that goes stale (the
 * coupon is consumed between preview and submit) fails plainly at
 * submit time instead of charging the wrong amount.
 */
export async function POST(
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

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The coupon request could not be read.' },
      { status: 400 }
    );
  }
  const parsed = CouponValidateRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success || totalPricePkr(parsed.data.counts) <= 0) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Choose at least one page or account first.' },
      { status: 400 }
    );
  }
  const { code, counts } = parsed.data;

  try {
    const activePeriod = await getActivePeriod(client, session.userId, new Date());
    let amountDuePkr: number;
    try {
      amountDuePkr = pricePurchase(counts, activePeriod).amountPkr;
    } catch (err) {
      if (err instanceof SubscriptionGateError) {
        return NextResponse.json({ error: 'INVALID_REQUEST', message: err.message }, { status: 400 });
      }
      throw err;
    }
    const { coupon, discountPkr } = await previewCoupon(client, code, amountDuePkr);
    return NextResponse.json({
      code: coupon.code,
      kind: coupon.kind,
      percent: coupon.percent,
      discountPkr,
      amountDuePkr,
      amountAfterDiscountPkr: amountDuePkr - discountPkr,
      fullyCovered: discountPkr >= amountDuePkr,
    });
  } catch (err) {
    if (err instanceof CouponError) {
      const status = err.code === 'COUPON_NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    logServerError('[billing] coupon validate failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'The coupon could not be checked. Please try again.' },
      { status: 500 }
    );
  }
}
