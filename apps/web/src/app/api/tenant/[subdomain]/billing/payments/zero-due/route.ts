import { type NextRequest, NextResponse } from 'next/server';
import {
  totalPricePkr,
  ZeroDueCheckoutRequestSchema,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  createPeriodForPurchase,
  getActivePeriod,
  hasPendingPayment,
  PENDING_PAYMENT_EXISTS_MESSAGE,
  pricePurchase,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  lookupBillingIdempotency,
  storeBillingIdempotency,
} from '@/lib/billing/route-helpers';
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

  // Admins never buy plans (audit fix 2026-11-01).
  if (session.role === 'admin') {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'Admin accounts do not buy plans.' },
      { status: 403 }
    );
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

  // Billing idempotency (audit fix 2026-11-01): a retry with a known
  // key replays the stored activation instead of creating a second
  // period.
  // The workspace is only the idempotency scope. If it cannot be
  // resolved, idempotency is skipped with a loud log rather than
  // failing the submission — the one-pending guard still protects
  // against duplicates, and the payment row itself carries no
  // workspace (its workspace_id column is dead).
  let workspaceId: string | null = null;
  try {
    workspaceId = await resolveTenantWorkspaceId(client, subdomain, session.userId, session.role);
  } catch (error) {
    logServerError('[billing] idempotency workspace unresolvable, skipping', error, {
      source: 'billing',
    });
  }
  let idempotencyKey: string | null = null;
  if (workspaceId) {
  try {
    const idempotency = await lookupBillingIdempotency(
      client,
      workspaceId,
      session.userId,
      'billing-zero-due',
      request.headers
    );
    if ('invalid' in idempotency) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Idempotency-Key must be a UUID' },
        { status: 400 }
      );
    }
    idempotencyKey = idempotency.key;
    if (idempotency.replay) {
      return NextResponse.json(idempotency.replay.body, {
        status: idempotency.replay.status,
        headers: { 'Idempotency-Replayed': 'true' },
      });
    }
  } catch {
    return NextResponse.json(
      { error: 'IDEMPOTENCY_STORE_UNAVAILABLE', message: 'Idempotency store unavailable' },
      { status: 500 }
    );
  }
  }

  try {
    // One pending payment per user — the zero-due route bypassed
    // this entirely (audit fix 2026-11-01): a coupon activation
    // while a bank/crypto payment waited would be silently
    // overwritten by the later approval's fresh 30 days.
    if (await hasPendingPayment(client, session.userId)) {
      return NextResponse.json(
        { error: 'PENDING_PAYMENT_EXISTS', message: PENDING_PAYMENT_EXISTS_MESSAGE },
        { status: 409 }
      );
    }
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
    // Settled discount (audit fix 2026-11-01): a balance race can
    // settle smaller than the pre-hold figure. A settled discount
    // that no longer covers the amount REFUSES the activation —
    // the hold is released and the user reviews the new amount and
    // resubmits — instead of granting a full period the settled
    // discount did not cover.
    if (redemption.amountPkr < amountDuePkr) {
      try {
        await releaseRedemption(client, redemption);
      } catch (releaseError) {
        logServerError('[billing] zero-due coupon release after settle failed', releaseError, {
          source: 'billing',
        });
      }
      return NextResponse.json(
        {
          error: 'COUPON_SETTLED_LESS',
          message: `This coupon now covers ${redemption.amountPkr} PKR, but ${amountDuePkr} PKR is due. Review the new amount and submit again.`,
          amountDuePkr,
          settledDiscountPkr: redemption.amountPkr,
        },
        { status: 400 }
      );
    }
    let period: { id: string } | null = null;
    try {
      const created = await createPeriodForPurchase(
        client,
        { userId: session.userId, counts, paymentId: null, isUpgrade },
        new Date()
      );
      period = created;
      await applyRedemption(client, redemption.id, created.id);
      const activationBody = {
        period: {
          id: created.id,
          startsAt: created.startsAt.toISOString(),
          endsAt: created.endsAt.toISOString(),
        },
        couponCode: coupon.code,
        discountPkr: redemption.amountPkr,
        counts,
        isUpgrade,
      };
      await storeBillingIdempotency(client, workspaceId, session.userId, 'billing-zero-due', idempotencyKey, {
        status: 201,
        body: activationBody,
      });
      return NextResponse.json(activationBody, { status: 201 });
    } catch (err) {
      // No live period before activation lands (audit fix 2026-11-01,
      // fix 10): if the period was created but the redemption (or
      // the idempotency store) failed, supersede the just-created
      // period before giving the coupon back — otherwise the user
      // keeps a live plan from a failed checkout AND the coupon.
      // A supersede failure is logged loudly; the retry supersedes
      // it anyway via createPeriodForPurchase's supersede-all.
      if (period) {
        try {
          await client
            .from('subscription_periods')
            .update({ superseded_at: new Date().toISOString() })
            .eq('id', period.id)
            .is('superseded_at', null);
        } catch (supersedeError) {
          logServerError('[billing] zero-due orphan period supersede failed', supersedeError, {
            source: 'billing',
            periodId: period.id,
          });
        }
      }
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
