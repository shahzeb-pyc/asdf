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
      const { data } = await client
        .from('subscription_payments')
        .select(
          'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,period_id,approved_at,created_at'
        )
        .eq('id', payload.order_id)
        .maybeSingle();
      if (data) paymentRow = data as Record<string, unknown>;
    }
    if (!paymentRow) {
      const { data } = await client
        .from('subscription_payments')
        .select(
          'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,period_id,approved_at,created_at'
        )
        .eq('nowpayments_payment_id', providerPaymentId)
        .maybeSingle();
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

    if (status === 'finished') {
      const period = await createPeriodForPayment(client, payment);
      await client
        .from('subscription_payments')
        .update({
          status: 'paid',
          period_id: period.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id);
      return NextResponse.json({ received: true, activated: true });
    }

    if (status === 'failed' || status === 'expired') {
      if (payment.status === 'pending') {
        await client
          .from('subscription_payments')
          .update({ status, updated_at: new Date().toISOString() })
          .eq('id', payment.id);
      }
      return NextResponse.json({ received: true, updated: true });
    }

    return NextResponse.json({ received: true, ignored: true });
  } catch (err) {
    if (err instanceof SubscriptionGateError) {
      logServerError('[billing] webhook activation failed', err, { source: 'billing' });
      return NextResponse.json({ error: 'Activation failed' }, { status: 500 });
    }
    logServerError('[billing] webhook failed', err, { source: 'billing' });
    return NextResponse.json({ error: 'Webhook failed' }, { status: 500 });
  }
}
