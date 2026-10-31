import { type NextRequest, NextResponse } from 'next/server';
import {
  totalPricePkr,
  ZeroDueCheckoutRequestSchema,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import {
  createPeriodForPurchase,
  getActivePeriod,
  pricePurchase,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  applyRedemption,
  CouponError,
  holdCoupon,
  loadCouponByCode,
  computeDiscount,
  releaseRedemption,
} from '@/lib/billing/coupons';

/**
 * POST /api/tenant/[subdomain]/billing/payments/zero-due
 * Coupon-only checkout: when a coupon covers the FULL amount due,
 * there is nothing to pay and nothing to approve, so the period
 * starts right away. No payment row is created (there is no
 * payment); the applied redemption, linked to the period, is the
 * audit trail. A coupon that does not cover the full amount is
 * refused here — the remainder goes through bank or crypto.
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
      { error: 'INVALID_REQUEST', message: 'The checkout request could not be read.' },
      { status: 400 }
    );
  }
  const parsed = ZeroDueCheckoutRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success || totalPricePkr(parsed.data.counts) <= 0) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Choose at least one page or account first.',
      },
      { status: 400 }
    );
  }
  const { counts, couponCode } = parsed.data;

  try {
    const activePeriod = await getActivePeriod(client, session.userId, new Date());
    let amountDuePkr: number;
    let isUpgrade: boolean;
    try {
      const priced = pricePurchase(counts, activePeriod);
      amountDuePkr = priced.amountPkr;
      isUpgrade = priced.isUpgrade;
    } catch (err) {
      if (err instanceof SubscriptionGateError) {
        return NextResponse.json({ error: 'INVALID_REQUEST', message: err.message }, { status: 400 });
      }
      throw err;
    }
    if (amountDuePkr <= 0) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'This purchase has nothing left to pay, so a coupon cannot be applied.',
        },
        { status: 400 }
      );
    }
    const coupon = await loadCouponByCode(client, couponCode);
    if (!coupon) {
      return NextResponse.json(
        { error: 'COUPON_NOT_FOUND', message: 'That coupon code was not found.' },
        { status: 404 }
      );
    }
    const discountPkr = computeDiscount(coupon, amountDuePkr);
    if (discountPkr < amountDuePkr) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'This coupon does not cover the full amount. Pay the remainder by bank or crypto.',
        },
        { status: 400 }
      );
    }
    const redemption = await holdCoupon(client, {
      coupon,
      userId: session.userId,
      paymentId: null,
      discountPkr,
    });
    try {
      const period = await createPeriodForPurchase(
        client,
        { userId: session.userId, counts, paymentId: null },
        new Date()
      );
      await applyRedemption(client, redemption.id, period.id);
      return NextResponse.json(
        {
          period: {
            id: period.id,
            startsAt: period.startsAt.toISOString(),
            endsAt: period.endsAt.toISOString(),
          },
          couponCode: coupon.code,
          discountPkr,
          counts,
          isUpgrade,
        },
        { status: 201 }
      );
    } catch (err) {
      // The hold landed but the period did not: give the coupon
      // back instead of stranding the user's balance/consumption.
      try {
        await releaseRedemption(client, redemption);
      } catch (releaseError) {
        logServerError('[billing] zero-due coupon release failed', releaseError, {
          source: 'billing',
          couponId: coupon.id,
        });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof CouponError) {
      const status = err.code === 'COUPON_NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    logServerError('[billing] zero-due checkout failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your plan could not be activated. Please try again.' },
      { status: 500 }
    );
  }
}
