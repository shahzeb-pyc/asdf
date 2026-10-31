import { type NextRequest, NextResponse } from 'next/server';
import {
  NowPaymentsIpnPayloadSchema,
  verifyNowPaymentsIpnSignature,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import {
  createPeriodForPayment,
  paymentFromRow,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import {
  applyHeldRedemptionsForPayment,
  releaseHeldRedemptionsForPayment,
} from '@/lib/billing/coupons';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { getNowPaymentsConfig } from '@/lib/billing/nowpayments';

/**
 * POST /api/billing/nowpayments/webhook
 * NOWPayments IPN endpoint. It is public by necessity (NOWPayments
 * calls it without a user session), so its only authentication is
 * the IPN signature: HMAC-SHA512 over the alphabetically-sorted
 * JSON body, checked against the x-nowpayments-sig header. An
 * invalid signature gets 401 and activates nothing.
 *
 * Deduplication is by provider + payment + status: the same
 * finished notification twice activates once. Only 'finished'
 * starts a paid period; waiting/confirming/confirmed leave the
 * payment pending, and failed/expired mark it so. A payment
 * that already has a period is never activated again.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  const payloadRecord = body as Record<string, unknown>;

  const config = getNowPaymentsConfig();
  const signature = request.headers.get('x-nowpayments-sig');
  const valid = await verifyNowPaymentsIpnSignature(payloadRecord, signature, config.ipnSecret);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const parsed = NowPaymentsIpnPayloadSchema.safeParse(payloadRecord);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  const payload = parsed.data;
  const providerPaymentId = String(payload.payment_id);
  const status = payload.payment_status;
  const eventKey = `nowpayments:${providerPaymentId}:${status}`;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    const { error: eventError } = await client.from('subscription_webhook_events').insert({
      provider: 'nowpayments',
      event_key: eventKey,
      payment_id: providerPaymentId,
      status,
    });
    if (eventError) {
      if (eventError.code === '23505') {
        return NextResponse.json({ received: true, duplicate: true });
      }
      throw eventError;
    }

    // Find our payment: order_id is our payment UUID (most reliable),
    // falling back to the NOWPayments payment id.
    let paymentRow: Record<string, unknown> | null = null;
    if (typeof payload.order_id === 'string' && payload.order_id.length > 0) {
      const { data, error: lookupError } = await client
        .from('subscription_payments')
        .select(
          'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at'
        )
        .eq('id', payload.order_id)
        .maybeSingle();
      // A lookup failure is not an unknown payment: throwing here
      // releases the dedupe row (see catch) so the retry reprocesses
      // instead of being swallowed as a duplicate forever.
      if (lookupError) throw lookupError;
      if (data) paymentRow = data as Record<string, unknown>;
    }
    if (!paymentRow) {
      const { data, error: lookupError } = await client
        .from('subscription_payments')
        .select(
          'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at'
        )
        .eq('nowpayments_payment_id', providerPaymentId)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (data) paymentRow = data as Record<string, unknown>;
    }
    if (!paymentRow) {
      logServerError('[billing] webhook for unknown payment', null, {
        source: 'billing',
        providerPaymentId,
      });
      return NextResponse.json({ received: true, unknownPayment: true });
    }

    const payment = paymentFromRow(paymentRow);
    if (!payment) {
      return NextResponse.json({ received: true, unknownPayment: true });
    }
    if (payment.periodId) {
      return NextResponse.json({ received: true, alreadyActivated: true });
    }
    // A payment an admin rejected must never activate, even if the
    // user pays it afterwards. Rejection is terminal: the dedupe
    // row stays, so a retry of the same notification is still a
    // duplicate and still rejected.
    if (status === 'finished' && payment.status === 'rejected') {
      return NextResponse.json({ received: true, rejected: true });
    }

    if (status === 'finished') {
      const period = await createPeriodForPayment(client, payment);
      // Never report activated when the persist failed: throwing
      // releases the dedupe row so the provider retry reprocesses
      // (createPeriodForPayment supersedes the first period, so
      // the retry cannot double-activate).
      const { error: markPaidError } = await client
        .from('subscription_payments')
        .update({
          status: 'paid',
          period_id: period.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id);
      if (markPaidError) throw markPaidError;
      // Coupon held at checkout becomes applied now that the
      // deposit finished. This is logged loudly, not thrown: a
      // retry of this notification would hit the alreadyActivated
      // check above and return without re-running this step, so
      // failing the webhook here could not recover it — and the
      // money outcome is already correct (the balance was
      // deducted at hold time).
      try {
        await applyHeldRedemptionsForPayment(client, payment.id);
      } catch (err) {
        logServerError('[billing] coupon apply after webhook finished failed', err, {
          source: 'billing',
          paymentId: payment.id,
        });
      }
      return NextResponse.json({ received: true, activated: true });
    }

    if (status === 'failed' || status === 'expired') {
      if (payment.status === 'pending') {
        const { error: markStatusError } = await client
          .from('subscription_payments')
          .update({ status, updated_at: new Date().toISOString() })
          .eq('id', payment.id);
        if (markStatusError) throw markStatusError;
      }
      // A deposit that will never finish gives the coupon back,
      // by the same guarded release the bank reject path uses.
      // Logged loudly, not thrown, for the same retry reason as
      // the finished path above.
      try {
        await releaseHeldRedemptionsForPayment(client, payment.id);
      } catch (err) {
        logServerError('[billing] coupon release after webhook failure failed', err, {
          source: 'billing',
          paymentId: payment.id,
        });
      }
      return NextResponse.json({ received: true, updated: true });
    }

    return NextResponse.json({ received: true, ignored: true });
  } catch (err) {
    // The dedupe row was written before activation, so a failed
    // activation must release it — otherwise NOWPayments' retry
    // would be swallowed as a duplicate and the payment could
    // never activate. Successful activations keep their row.
    // (Double activation is still guarded by the periodId check
    // above, so releasing on failure cannot double-activate.)
    await client
      .from('subscription_webhook_events')
      .delete()
      .eq('provider', 'nowpayments')
      .eq('event_key', eventKey);
    if (err instanceof SubscriptionGateError) {
      logServerError('[billing] webhook activation failed', err, { source: 'billing' });
      return NextResponse.json({ error: 'Activation failed' }, { status: 500 });
    }
    logServerError('[billing] webhook failed', err, { source: 'billing' });
    return NextResponse.json({ error: 'Webhook failed' }, { status: 500 });
  }
}
