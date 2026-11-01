import { type NextRequest, NextResponse } from 'next/server';
import {
  CreateCryptoCheckoutRequestSchema,
  nowPaymentsPayCurrency,
  totalPricePkr,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  getActivePeriod,
  hasPendingPayment,
  PENDING_PAYMENT_EXISTS_MESSAGE,
  pricePurchase,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import {
  createNowPaymentsPayment,
  estimateUsdt,
  getNowPaymentsConfig,
  minimumUsdt,
  NowPaymentsError,
} from '@/lib/billing/nowpayments';
import {
  getBillingAdminClient,
  lookupBillingIdempotency,
  storeBillingIdempotency,
} from '@/lib/billing/route-helpers';
import {
  CouponError,
  computeDiscount,
  holdCoupon,
  loadCouponByCode,
  releaseRedemption,
  type CouponRedemptionRow,
} from '@/lib/billing/coupons';

/**
 * POST /api/tenant/[subdomain]/billing/payments/crypto
 * NOWPayments checkout for USDT on TRC20 or BEP20.
 *
 * The PKR amount is always computed server-side (fresh purchase:
 * full total; active period: upgrade price after credit). The USDT
 * amount comes from NOWPayments' own estimate API at checkout —
 * there is no fixed rate anywhere in this code. If the estimate is
 * below NOWPayments' minimum for the pair, the checkout is refused
 * plainly and no payment row is left behind. If the crypto key is
 * missing, checkout fails loudly; it never pretends to succeed.
 * A successful checkout returns the deposit address and amount
 * from NOWPayments; the paid period starts only when the IPN
 * webhook reports the payment finished.
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

  // Billing idempotency (audit fix 2026-11-01): a retry with a known
  // key replays the stored checkout instead of creating a second
  // pending payment or a second gateway deposit.
  // The workspace is only the idempotency scope. If it cannot be
  // resolved, the lookup still runs (an invalid key is rejected
  // either way) but replay and storage are skipped with a loud log
  // rather than failing the submission — the one-pending guard
  // still protects against duplicates, and the payment row itself
  // carries no workspace (its workspace_id column is dead).
  let workspaceId: string | null = null;
  try {
    workspaceId = await resolveTenantWorkspaceId(client, subdomain, session.userId, session.role);
  } catch (error) {
    logServerError('[billing] idempotency workspace unresolvable, skipping', error, {
      source: 'billing',
    });
  }
  let idempotencyKey: string | null = null;
  try {
    const idempotency = await lookupBillingIdempotency(
      client,
      workspaceId,
      session.userId,
      'billing-crypto',
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

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The checkout request could not be read.' },
      { status: 400 }
    );
  }
  const parsed = CreateCryptoCheckoutRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success || totalPricePkr(parsed.data.counts) <= 0) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Choose at least one page or account and a crypto network.',
      },
      { status: 400 }
    );
  }
  const { counts, network } = parsed.data;
  const couponCode = parsed.data.couponCode?.trim()
    ? parsed.data.couponCode.trim()
    : undefined;

  const config = getNowPaymentsConfig();
  if (!config.apiKey) {
    return NextResponse.json(
      {
        error: 'CRYPTO_NOT_CONFIGURED',
        message:
          'Crypto checkout is not set up yet. Please pay by bank, or try crypto again later.',
      },
      { status: 503 }
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  let trimmedAppUrl = appUrl;
  while (trimmedAppUrl.endsWith('/')) {
    trimmedAppUrl = trimmedAppUrl.slice(0, -1);
  }
  if (!trimmedAppUrl) {
    return NextResponse.json(
      { error: 'Crypto checkout is not set up yet. Please pay by bank.' },
      { status: 503 }
    );
  }

  // A hold that never got linked (insert failed, link failed,
  // deposit failed) must not strand the coupon; the catch below
  // releases it. These live outside the try block for that reason.
  let heldRedemption: CouponRedemptionRow | null = null;
  let redemptionLinked = false;
  try {
    // One pending payment per user: checked before any estimate, any
    // row, and any NOWPayments deposit is created.
    if (await hasPendingPayment(client, session.userId)) {
      return NextResponse.json(
        { error: 'PENDING_PAYMENT_EXISTS', message: PENDING_PAYMENT_EXISTS_MESSAGE },
        { status: 409 }
      );
    }
    const activePeriod = await getActivePeriod(client, session.userId, new Date());
    let amountPkr: number;
    let isUpgrade: boolean;
    try {
      const priced = pricePurchase(counts, activePeriod);
      amountPkr = priced.amountPkr;
      isUpgrade = priced.isUpgrade;
    } catch (err) {
      if (err instanceof SubscriptionGateError) {
        return NextResponse.json({ error: 'INVALID_REQUEST', message: err.message }, { status: 400 });
      }
      throw err;
    }

    // Coupon hold (if any): the claim lands before the deposit is
    // created, and the deposit is created for the REDUCED amount.
    // A coupon covering the full amount belongs to the zero-due
    // path, not here — there is no deposit to create for 0.
    let discountPkr = 0;
    if (couponCode) {
      const coupon = await loadCouponByCode(client, couponCode);
      if (!coupon) {
        return NextResponse.json(
          { error: 'COUPON_NOT_FOUND', message: 'That coupon code was not found.' },
          { status: 404 }
        );
      }
      discountPkr = computeDiscount(coupon, amountPkr);
      if (discountPkr >= amountPkr) {
        return NextResponse.json(
          {
            error: 'INVALID_REQUEST',
            message: 'This coupon covers the full amount. Activate your plan with the coupon instead of paying crypto.',
          },
          { status: 400 }
        );
      }
      heldRedemption = await holdCoupon(client, {
        coupon,
        userId: session.userId,
        paymentId: null,
        discountPkr,
      });
      // Charge the SETTLED discount (audit fix 2026-11-01), same as
      // the bank route: a balance race can settle smaller than the
      // pre-hold figure.
      discountPkr = heldRedemption.amountPkr;
      amountPkr -= discountPkr;
    }

    const estimatedUsdt = await estimateUsdt(amountPkr, network, config.apiKey);
    const minimum = await minimumUsdt(network, config.apiKey);
    if (minimum !== null && estimatedUsdt < minimum) {
      // The held coupon is released FIRST (audit fix 2026-11-01):
      // this is a plain return past the catch below, so returning
      // without releasing used to strand the hold.
      if (heldRedemption) {
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after below-minimum failed', releaseError, {
            source: 'billing',
          });
        }
      }
      return NextResponse.json(
        {
          error: 'BELOW_MINIMUM',
          message: `Your total is about ${estimatedUsdt} USDT, below the gateway minimum of ${minimum} USDT for this network. Add more pages or accounts, or pay by bank.`,
        },
        { status: 422 }
      );
    }

    const { data: inserted, error: insertError } = await client
      .from('subscription_payments')
      .insert({
        user_id: session.userId,
        method: 'nowpayments',
        status: 'pending',
        facebook_count: counts.facebook,
        instagram_count: counts.instagram,
        threads_count: counts.threads,
        x_count: counts.x,
        tiktok_count: counts.tiktok,
        youtube_count: counts.youtube,
        amount_pkr: amountPkr,
        is_upgrade: isUpgrade,
        nowpayments_network: network,
        coupon_code: couponCode ? couponCode.trim().toUpperCase() : null,
        discount_pkr: discountPkr,
      })
      .select('id')
      .single();
    if (insertError?.code === '23505') {
      // Race backstop, same as the bank route: two submissions that
      // both passed the pending check collide on the
      // one-pending-per-user index, and the loser gets the plain 409
      // with no deposit created. The held coupon is released first
      // (audit fix 2026-11-01) — this return bypasses the catch.
      if (heldRedemption) {
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after pending race failed', releaseError, {
            source: 'billing',
          });
        }
      }
      return NextResponse.json(
        { error: 'PENDING_PAYMENT_EXISTS', message: PENDING_PAYMENT_EXISTS_MESSAGE },
        { status: 409 }
      );
    }
    if (insertError || !inserted || typeof inserted.id !== 'string') {
      // Same rule as the bank route: never discard the database
      // error — log its code and message server-side, then throw
      // the plain message the user sees.
      if (insertError) {
        logServerError('[billing] crypto payment insert failed', insertError, {
          source: 'billing',
          code: insertError.code,
        });
      } else {
        logServerError(
          '[billing] crypto payment insert failed',
          new Error('Crypto payment insert returned no usable row'),
          { source: 'billing' }
        );
      }
      throw new Error('Crypto payment record could not be created');
    }
    const paymentId = inserted.id as string;

    if (heldRedemption) {
      // Link the held redemption to this payment. If the link
      // fails, the payment is removed again (created milliseconds
      // ago by this request, never seen) and the coupon released.
      const { error: linkError } = await client
        .from('coupon_redemptions')
        .update({ payment_id: paymentId })
        .eq('id', heldRedemption.id)
        .eq('status', 'held');
      if (linkError) {
        await client.from('subscription_payments').delete().eq('id', paymentId);
        throw new Error('Coupon redemption link failed');
      }
      redemptionLinked = true;
    }

    let created;
    try {
      created = await createNowPaymentsPayment(
        {
          priceAmountPkr: amountPkr,
          network,
          orderId: paymentId,
          ipnCallbackUrl: `${trimmedAppUrl}/api/billing/nowpayments/webhook`,
        },
        config.apiKey
      );
    } catch (err) {
      // Best-effort compensation: the checkout already failed, so
      // the user sees the 502 either way — but a failed mark-failed
      // update must still be logged, never silently dropped. The
      // coupon is released FIRST so a failed deposit never strands
      // a held discount on a payment that will never be paid.
      // (The link always succeeded by this point, so the release
      // also restores the balance through the same guarded path.)
      if (heldRedemption) {
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after crypto failure failed', releaseError, {
            source: 'billing',
          });
        }
      }
      const { error: markFailedError } = await client
        .from('subscription_payments')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', paymentId);
      if (markFailedError) {
        logServerError('[billing] crypto mark failed update failed', markFailedError, {
          source: 'billing',
          code: markFailedError.code,
        });
      }
      if (err instanceof NowPaymentsError) {
        return NextResponse.json({ error: 'CRYPTO_CHECKOUT_FAILED', message: err.message }, { status: 502 });
      }
      throw err;
    }

    // If this update fails, the deposit address must NOT be shown:
    // a payment the IPN cannot match (no gateway id stored) could
    // never activate, even if the user paid it. Mark the row failed
    // so the user retries with a fresh checkout instead.
    const { error: addressUpdateError } = await client
      .from('subscription_payments')
      .update({
        nowpayments_payment_id: created.paymentId,
        nowpayments_pay_address: created.payAddress,
        nowpayments_pay_amount: created.payAmount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', paymentId);
    if (addressUpdateError) {
      logServerError('[billing] crypto address save failed', addressUpdateError, {
        source: 'billing',
        code: addressUpdateError.code,
      });
      // The deposit exists at the gateway but cannot be matched to
      // this payment, so the payment fails — and the held coupon
      // goes back, for the same reason as above.
      if (heldRedemption) {
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after crypto failure failed', releaseError, {
            source: 'billing',
          });
        }
      }
      const { error: markFailedError } = await client
        .from('subscription_payments')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', paymentId);
      if (markFailedError) {
        logServerError('[billing] crypto mark failed update failed', markFailedError, {
          source: 'billing',
          code: markFailedError.code,
        });
      }
      return NextResponse.json(
        {
          error: 'CRYPTO_CHECKOUT_FAILED',
          message: 'Crypto checkout could not be started. Please try again, or pay by bank.',
        },
        { status: 502 }
      );
    }

    const checkoutBody = {
      paymentId,
      nowpaymentsPaymentId: created.paymentId,
      payAddress: created.payAddress,
      payAmount: created.payAmount,
      payCurrency: nowPaymentsPayCurrency(network),
      network,
      amountPkr,
      estimatedUsdt,
      minimumUsdt: minimum,
      belowMinimum: false,
    };
    await storeBillingIdempotency(client, workspaceId, session.userId, 'billing-crypto', idempotencyKey, {
      status: 201,
      body: checkoutBody,
    });
    return NextResponse.json(checkoutBody, { status: 201 });
  } catch (err) {
    if (err instanceof CouponError) {
      const status = err.code === 'COUPON_NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    // A hold that never got linked (insert failed, link failed)
    // must not strand the coupon. Linked holds are NOT released
    // here: the payment exists and its outcome (webhook) decides.
    if (heldRedemption && !redemptionLinked) {
      try {
        await releaseRedemption(client, heldRedemption);
      } catch (releaseError) {
        logServerError('[billing] coupon release after crypto failure failed', releaseError, {
          source: 'billing',
        });
      }
    }
    logServerError('[billing] crypto checkout failed', err, { source: 'billing' });
    if (err instanceof NowPaymentsError) {
      return NextResponse.json({ error: 'CRYPTO_CHECKOUT_FAILED', message: err.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: 'Crypto checkout could not be started. Please try again, or pay by bank.' },
      { status: 500 }
    );
  }
}
