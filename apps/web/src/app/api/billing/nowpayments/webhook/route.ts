import { type NextRequest, NextResponse } from 'next/server';
import {
  NowPaymentsIpnPayloadSchema,
  verifyNowPaymentsIpnSignature,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import {
  activateCryptoPayment,
  markCryptoFailed,
  paymentFromRow,
  savePaymentActuals,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import { verifyIpnAgainstPayment, verifyIpnMethodOnly } from '@/lib/billing/webhook-verify';
import {
  releaseHeldRedemptionsForPayment,
} from '@/lib/billing/coupons';
import { recordCommissionForPayment } from '@/lib/billing/sellers';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { getNowPaymentsConfig } from '@/lib/billing/nowpayments';
import { recordWebhookIssue } from '@/lib/billing/webhook-issues';

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
 * payment pending, and failed/expired mark it so — but ONLY when
 * the payment is still pending (a late failure never overwrites a
 * paid payment, and never releases a coupon an activation already
 * applied). failed/expired is NOT terminal: a later finished
 * event still activates. A payment that already has a period is
 * never activated again, and a rejected payment never activates.
 *
 * Verification (audit fix 2026-11-01): before ANY state change, a
 * finished/failed/expired notification must match the payment —
 * method (nowpayments, never a bank row found by order_id),
 * currency (the network's USDT ticker), and amount (what actually
 * arrived, >= the checkout pay amount). A mismatch changes nothing:
 * the issue is recorded for the admin, the webhook answers 200,
 * and the dedupe row is released so a corrected re-send can still
 * process. Underpayment (including partially_paid) is held for an
 * admin decision via the rescue buttons, never auto-activated.
 * A refunded notification revokes the period when one was
 * activated, and always alerts the admin.
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

  const releaseDedupe = async (): Promise<void> => {
    await client
      .from('subscription_webhook_events')
      .delete()
      .eq('provider', 'nowpayments')
      .eq('event_key', eventKey);
  };

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
      // Do NOT keep the dedupe row for an unknown payment: the
      // payment row may simply not exist yet, and a kept row would
      // swallow the later real notification for the same key.
      await releaseDedupe();
      await recordWebhookIssue(client, {
        providerPaymentId,
        paymentId: null,
        reason: 'unknown_payment',
        detail: `No subscription payment matched order ${payload.order_id ?? '—'} or gateway id ${providerPaymentId}.`,
      });
      return NextResponse.json({ received: true, unknownPayment: true });
    }

    const payment = paymentFromRow(paymentRow);
    if (!payment) {
      await releaseDedupe();
      return NextResponse.json({ received: true, unknownPayment: true });
    }
    if (payment.periodId) {
      // Already activated: a redelivery still owes the seller
      // commission if the first attempt recorded the period but
      // failed before the commission (the dedupe release on
      // failure routes the retry here). Recording is idempotent
      // per payment, so this is a no-op when already recorded.
      const { data: periodRow } = await client
        .from('subscription_periods')
        .select('starts_at')
        .eq('id', payment.periodId)
        .maybeSingle();
      const periodData =
        periodRow !== null && typeof periodRow === 'object'
          ? (periodRow as Record<string, unknown>)
          : null;
      const startsAt =
        periodData && typeof periodData['starts_at'] === 'string'
          ? new Date(periodData['starts_at'])
          : null;
      if (startsAt) {
        await recordCommissionForPayment(client, payment, {
          id: payment.periodId,
          startsAt,
        });
      }
      return NextResponse.json({ received: true, alreadyActivated: true });
    }
    // A payment an admin rejected must never activate, even if the
    // user pays it afterwards. Rejection is terminal: the dedupe
    // row stays, so a retry of the same notification is still a
    // duplicate and still rejected.
    if (status === 'finished' && payment.status === 'rejected') {
      return NextResponse.json({ received: true, rejected: true });
    }

    // Verification for money-moving statuses. Method is verified
    // for every money status (an order_id matching a bank row must
    // never be moved by a crypto notification). Currency and amount
    // gate ACTIVATION (finished / partially_paid): a failed event
    // legitimately arrives with nothing paid, so amount checks
    // would wrongly hold every genuine failure. A mismatch records
    // an admin issue and changes nothing; the dedupe row is
    // released so a corrected re-send reprocesses.
    if (status === 'finished' || status === 'failed' || status === 'expired' || status === 'partially_paid') {
      const verification =
        status === 'finished' || status === 'partially_paid'
          ? verifyIpnAgainstPayment(payment, payload)
          : verifyIpnMethodOnly(payment);
      if (!verification.ok) {
        logServerError('[billing] webhook verification failed', null, {
          source: 'billing',
          providerPaymentId,
          paymentId: payment.id,
          reason: verification.reason,
        });
        await releaseDedupe();
        await recordWebhookIssue(client, {
          providerPaymentId,
          paymentId: payment.id,
          reason: verification.reason,
          detail: verification.detail,
        });
        return NextResponse.json({ received: true, verificationFailed: true, reason: verification.reason });
      }
    }

    if (status === 'partially_paid') {
      // Held for an admin decision (audit fix 2026-11-01): a partial
      // deposit is neither activated nor failed. The admin approves
      // (rescue) or expires it from the payments view.
      await recordWebhookIssue(client, {
        providerPaymentId,
        paymentId: payment.id,
        reason: 'underpaid',
        detail: 'Partial payment received. Waiting for an admin decision: approve it or expire it.',
      });
      return NextResponse.json({ received: true, heldForAdmin: true });
    }

    if (status === 'refunded') {
      // The gateway refunded the deposit: revoke the period when
      // one was activated, and always alert the admin. The payment
      // row keeps its status — the refund itself is outside the app.
      if (payment.periodId) {
        await client
          .from('subscription_periods')
          .update({ superseded_at: new Date().toISOString() })
          .eq('id', payment.periodId)
          .is('superseded_at', null);
      }
      logServerError('[billing] webhook refunded payment', null, {
        source: 'billing',
        providerPaymentId,
        paymentId: payment.id,
      });
      await recordWebhookIssue(client, {
        providerPaymentId,
        paymentId: payment.id,
        reason: 'refunded',
        detail: payment.periodId
          ? 'The gateway refunded this deposit, so the paid period was revoked. Check the payment before acting further.'
          : 'The gateway refunded this deposit. No period had been activated.',
      });
      return NextResponse.json({ received: true, refunded: true });
    }

    if (status === 'finished') {
      const actualPaid = typeof payload.actually_paid === 'number' ? payload.actually_paid : null;
      const payAmount = typeof payload.pay_amount === 'number' ? payload.pay_amount : null;
      const arrived = actualPaid ?? payAmount;
      const result = await activateCryptoPayment(client, payment);
      // Persist what actually arrived, in a SEPARATE update: until
      // the migration adding the columns is applied this fails,
      // and that must never break activation.
      if (arrived !== null) {
        await savePaymentActuals(
          client,
          payment.id,
          arrived,
          typeof payload.pay_currency === 'string' ? payload.pay_currency : null
        );
      }
      if (result.couponReleasedBeforeFinish) {
        logServerError('[billing] coupon released before webhook finish', null, {
          source: 'billing',
          paymentId: payment.id,
        });
        await recordWebhookIssue(client, {
          providerPaymentId,
          paymentId: payment.id,
          reason: 'coupon_released_before_finish',
          detail: 'A failed/expired notification released this payment’s coupon before the finished notification arrived. The period was still activated because the user paid — check whether the coupon should be re-applied manually.',
        });
      }
      // Seller commission, by contrast, THROWS on failure: the
      // outer catch releases the dedupe row, so the provider
      // retry reprocesses through the alreadyActivated branch
      // above, which records the commission. A swallowed failure
      // here would lose the seller money with no recovery.
      await recordCommissionForPayment(client, payment, result.period);
      return NextResponse.json({
        received: true,
        activated: !result.alreadyActivated,
        alreadyActivated: result.alreadyActivated,
      });
    }

    if (status === 'failed' || status === 'expired') {
      // Conditional: only a still-pending payment moves to
      // failed/expired, and only then is the coupon released. A
      // late failure arriving after a finish changes nothing and
      // releases nothing — releasing an applied coupon would be
      // wrong, and overwriting a paid payment would be worse.
      const moved = await markCryptoFailed(client, payment.id, status);
      if (!moved) {
        return NextResponse.json({ received: true, alreadyDecided: true });
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
    await releaseDedupe();
    if (err instanceof SubscriptionGateError) {
      logServerError('[billing] webhook activation failed', err, { source: 'billing' });
      return NextResponse.json({ error: 'Activation failed' }, { status: 500 });
    }
    logServerError('[billing] webhook failed', err, { source: 'billing' });
    return NextResponse.json({ error: 'Webhook failed' }, { status: 500 });
  }
}

export { verifyIpnAgainstPayment, verifyIpnMethodOnly } from '@/lib/billing/webhook-verify';
