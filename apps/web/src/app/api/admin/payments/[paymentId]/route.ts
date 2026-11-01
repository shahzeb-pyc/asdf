import { type NextRequest, NextResponse } from 'next/server';
import { AdminDecisionRequestSchema } from '@fbuploadpro/contracts';
import { authenticateAdminRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import {
  activateCryptoPayment,
  approvePayment,
  paymentFromRow,
  rejectPayment,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import { releaseHeldRedemptionsForPayment } from '@/lib/billing/coupons';
import { recordCommissionForPayment } from '@/lib/billing/sellers';
import {
  getBillingAdminClient,
  mapPaymentToItem,
} from '@/lib/billing/route-helpers';

/**
 * POST /api/admin/payments/[paymentId]
 * Admin only, fail closed. Approving starts a paid period of
 * exactly 30 days from approval and is idempotent — approving
 * twice returns the same period and does not extend it again.
 * Only bank payments can be approved here: crypto payments
 * activate automatically when NOWPayments reports them finished,
 * so an admin approval must never start a period for unpaid crypto
 * — except the rescue decisions below.
 *
 * Rescue (audit fix 2026-11-01): a crypto payment whose IPN never
 * arrived leaves the user wedged under one-pending with no admin
 * recourse. approve-crypto starts the period for a crypto payment
 * in pending/failed/expired with no period (the admin has checked
 * the payment outside the app); expire-crypto closes it and
 * releases its coupon. Both refuse bank payments and crypto
 * payments that already have a period.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> }
): Promise<NextResponse> {
  const { paymentId } = await context.params;
  const auth = await authenticateAdminRoute(request);
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
      { error: 'INVALID_REQUEST', message: 'The decision could not be read.' },
      { status: 400 }
    );
  }
  const parsed = AdminDecisionRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Choose approve, reject, or a crypto rescue action.' },
      { status: 400 }
    );
  }

  try {
    if (parsed.data.decision === 'reject') {
      const payment = await rejectPayment(client, paymentId);
      return NextResponse.json({ payment: mapPaymentToItem(payment), period: null });
    }

    if (parsed.data.decision === 'approve-crypto' || parsed.data.decision === 'expire-crypto') {
      // Awaited, not merely returned: a bare return would let a
      // rescue throw bypass this try/catch's error mapping below
      // and surface as an unhandled Next.js error instead of the
      // JSON 500 (audit fix 2026-11-01: fail loud, mapped).
      return await handleCryptoRescue(client, paymentId, parsed.data.decision);
    }

    // Bank-only approval gate: load the payment first so a crypto
    // payment can never be approved into a paid period. A missing
    // row is a 404, not the crypto 400 below (audit fix 2026-11-01:
    // approving a nonexistent payment used to report "crypto
    // payments activate automatically", which is wrong twice over).
    const { data } = await client
      .from('subscription_payments')
      .select('method')
      .eq('id', paymentId)
      .maybeSingle();
    if (!data) {
      return NextResponse.json(
        { error: 'PAYMENT_NOT_FOUND', message: 'That payment could not be found.' },
        { status: 404 }
      );
    }
    const method =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['method']
        : null;
    if (method !== 'bank') {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Crypto payments activate automatically when they are paid. They do not need approval.',
        },
        { status: 400 }
      );
    }

    const { payment, period } = await approvePayment(client, paymentId, auth.session.userId);
    return NextResponse.json({
      payment: mapPaymentToItem(payment),
      period: {
        id: period.id,
        startsAt: period.startsAt.toISOString(),
        endsAt: period.endsAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof SubscriptionGateError) {
      const status =
        err.code === 'PAYMENT_NOT_FOUND'
          ? 404
          : err.code === 'PAYMENT_ALREADY_DECIDED'
            ? 409
            : 500;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    logServerError('[billing] admin decision failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'That decision could not be saved. Please try again.' },
      { status: 500 }
    );
  }
}

async function handleCryptoRescue(
  client: NonNullable<ReturnType<typeof getBillingAdminClient>>,
  paymentId: string,
  decision: 'approve-crypto' | 'expire-crypto'
): Promise<NextResponse> {
  const { data, error } = await client
    .from('subscription_payments')
    .select(
      'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at'
    )
    .eq('id', paymentId)
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json(
      { error: 'PAYMENT_NOT_FOUND', message: 'That payment could not be found.' },
      { status: 404 }
    );
  }
  const payment = paymentFromRow(data as Record<string, unknown>);
  if (!payment) {
    return NextResponse.json(
      { error: 'PAYMENT_NOT_FOUND', message: 'That payment could not be found.' },
      { status: 404 }
    );
  }
  if (payment.method !== 'nowpayments') {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Rescue actions are for crypto payments only.' },
      { status: 400 }
    );
  }
  if (payment.periodId) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'This payment already has a period, so it needs no rescue.' },
      { status: 400 }
    );
  }
  if (payment.status !== 'pending' && payment.status !== 'failed' && payment.status !== 'expired') {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Only a pending, failed, or expired crypto payment can be rescued.' },
      { status: 400 }
    );
  }

  if (decision === 'approve-crypto') {
    const result = await activateCryptoPayment(client, payment);
    // A rescued payment is an approved/finished payment, so the
    // referral commission is due exactly as on a webhook finish.
    // This THROWS on failure (fail loud, mapped to a JSON 500 by
    // the POST catch): the period is already live, and a rescue
    // retry is refused for period-having payments, so the only
    // automatic recovery is a later webhook notification for this
    // payment, which records through its alreadyActivated path.
    await recordCommissionForPayment(client, result.payment, result.period);
    return NextResponse.json({
      payment: mapPaymentToItem(result.payment),
      period: {
        id: result.period.id,
        startsAt: result.period.startsAt.toISOString(),
        endsAt: result.period.endsAt.toISOString(),
      },
    });
  }

  // Expire: close the payment and give the coupon back, by the same
  // guarded release the reject path uses. The conditional update
  // means a concurrent webhook finish wins cleanly instead: if the
  // row is no longer pending/failed/expired, the rescue refuses.
  const { data: expired, error: expireError } = await client
    .from('subscription_payments')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', payment.id)
    .in('status', ['pending', 'failed', 'expired'])
    .is('period_id', null)
    .select('id');
  if (expireError) throw expireError;
  if (!Array.isArray(expired) || expired.length === 0) {
    return NextResponse.json(
      { error: 'PAYMENT_ALREADY_DECIDED', message: 'That payment has already been decided.' },
      { status: 409 }
    );
  }
  try {
    await releaseHeldRedemptionsForPayment(client, payment.id);
  } catch (releaseError) {
    logServerError('[billing] coupon release after crypto rescue expire failed', releaseError, {
      source: 'billing',
    });
  }
  return NextResponse.json({
    payment: mapPaymentToItem({ ...payment, status: 'expired' }),
    period: null,
  });
}
