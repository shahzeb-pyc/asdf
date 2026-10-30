import { type NextRequest, NextResponse } from 'next/server';
import {
  CreateCryptoCheckoutRequestSchema,
  nowPaymentsPayCurrency,
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
import {
  createNowPaymentsPayment,
  estimateUsdt,
  getNowPaymentsConfig,
  minimumUsdt,
  NowPaymentsError,
} from '@/lib/billing/nowpayments';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';

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

  try {
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

    const estimatedUsdt = await estimateUsdt(amountPkr, network, config.apiKey);
    const minimum = await minimumUsdt(network, config.apiKey);
    if (minimum !== null && estimatedUsdt < minimum) {
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
      })
      .select('id')
      .single();
    if (insertError || !inserted || typeof inserted.id !== 'string') {
      throw new Error('Crypto payment record could not be created');
    }
    const paymentId = inserted.id as string;

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
      await client
        .from('subscription_payments')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', paymentId);
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
      await client
        .from('subscription_payments')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', paymentId);
      return NextResponse.json(
        {
          error: 'CRYPTO_CHECKOUT_FAILED',
          message: 'Crypto checkout could not be started. Please try again, or pay by bank.',
        },
        { status: 502 }
      );
    }

    return NextResponse.json(
      {
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
      },
      { status: 201 }
    );
  } catch (err) {
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
