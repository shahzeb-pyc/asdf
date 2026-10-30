import {
  NowPaymentsCreatePaymentResponseSchema,
  NowPaymentsEstimateResponseSchema,
  NowPaymentsMinAmountResponseSchema,
  nowPaymentsPayCurrency,
  type CryptoNetwork,
} from '@fbuploadpro/contracts';

/**
 * NOWPayments integration (official API, api.nowpayments.io/v1).
 *
 * Endpoints used, from NOWPayments' own API documentation:
 * - POST /v1/payment — creates a payment (x-api-key header;
 *   price_amount, price_currency, pay_currency, ipn_callback_url,
 *   order_id, order_description). Returns payment_id, pay_address.
 * - GET /v1/estimate — converts a fiat amount to a crypto amount
 *   (amount, currency_from, currency_to; x-api-key header).
 * - GET /v1/min-amount — minimum payment amount for a pair
 *   (currency_from, currency_to, fiat_equivalent).
 * - IPN — POST to ipn_callback_url, signature in the
 *   x-nowpayments-sig header, HMAC-SHA512 over the
 *   alphabetically-sorted JSON body (verified in contracts).
 *
 * USDT network tickers: usdttrc20 (TRC20), usdtbsc (BEP20).
 *
 * Secrets come from the environment only and are never logged.
 * The payout wallet is configured in the NOWPayments dashboard
 * (it is not a payment-creation parameter); the owner mirrors it
 * in Doppler for record-keeping. Nothing here hardcodes a wallet.
 */

export const NOWPAYMENTS_API_BASE = 'https://api.nowpayments.io/v1';
export const NOWPAYMENTS_FETCH_TIMEOUT_MS = 15_000;

export interface NowPaymentsConfig {
  apiKey: string | null;
  ipnSecret: string | null;
}

export function getNowPaymentsConfig(): NowPaymentsConfig {
  const apiKey = process.env.NOWPAYMENTS_API_KEY ?? null;
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET ?? null;
  return {
    apiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    ipnSecret: ipnSecret && ipnSecret.length > 0 ? ipnSecret : null,
  };
}

export class NowPaymentsError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function extractProviderMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.length > 0) return record.message;
    if (typeof record.error === 'string' && record.error.length > 0) return record.error;
  }
  return fallback;
}

async function nowPaymentsFetch(
  path: string,
  apiKey: string,
  init?: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${NOWPAYMENTS_API_BASE}${path}`, {
      ...init,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(NOWPAYMENTS_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new NowPaymentsError(
      'Crypto checkout could not be reached right now. Please try again, or pay by bank.'
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new NowPaymentsError(
      `Crypto checkout was refused: ${extractProviderMessage(body, `status ${response.status}`)}`,
      502
    );
  }
  return body;
}

/** USDT estimate for a PKR total. Fails loud if NOWPayments cannot price it — never a fixed rate. */
export async function estimateUsdt(
  amountPkr: number,
  network: CryptoNetwork,
  apiKey: string
): Promise<number> {
  const payCurrency = nowPaymentsPayCurrency(network);
  const query = new URLSearchParams({
    amount: String(amountPkr),
    currency_from: 'pkr',
    currency_to: payCurrency,
  });
  const body = await nowPaymentsFetch(`/estimate?${query.toString()}`, apiKey);
  const parsed = NowPaymentsEstimateResponseSchema.safeParse(body);
  if (!parsed.success || !(parsed.data.estimated_amount > 0)) {
    throw new NowPaymentsError(
      'Crypto checkout could not price your total in USDT right now. Please try again, or pay by bank.'
    );
  }
  return parsed.data.estimated_amount;
}

/**
 * Minimum USDT amount for the pair. Returns null when NOWPayments
 * cannot answer — the caller then lets payment creation enforce
 * the minimum (its refusal is surfaced plainly), rather than
 * silently skipping the check or inventing a minimum.
 */
export async function minimumUsdt(
  network: CryptoNetwork,
  apiKey: string
): Promise<number | null> {
  const payCurrency = nowPaymentsPayCurrency(network);
  const query = new URLSearchParams({
    currency_from: payCurrency,
    currency_to: payCurrency,
    fiat_equivalent: 'pkr',
  });
  try {
    const body = await nowPaymentsFetch(`/min-amount?${query.toString()}`, apiKey);
    const parsed = NowPaymentsMinAmountResponseSchema.safeParse(body);
    if (!parsed.success || !(parsed.data.min_amount > 0)) return null;
    return parsed.data.min_amount;
  } catch {
    return null;
  }
}

export interface CreatedNowPaymentsPayment {
  paymentId: string;
  payAddress: string;
  payAmount: number | null;
  payCurrency: string;
}

export async function createNowPaymentsPayment(
  args: {
    priceAmountPkr: number;
    network: CryptoNetwork;
    orderId: string;
    ipnCallbackUrl: string;
  },
  apiKey: string
): Promise<CreatedNowPaymentsPayment> {
  const payCurrency = nowPaymentsPayCurrency(args.network);
  const body = await nowPaymentsFetch(
    '/payment',
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        price_amount: args.priceAmountPkr,
        price_currency: 'pkr',
        pay_currency: payCurrency,
        ipn_callback_url: args.ipnCallbackUrl,
        order_id: args.orderId,
        order_description: 'FBUploadPro subscription',
      }),
    }
  );
  const parsed = NowPaymentsCreatePaymentResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new NowPaymentsError(
      'Crypto checkout did not return a usable payment. Please try again, or pay by bank.'
    );
  }
  return {
    paymentId: String(parsed.data.payment_id),
    payAddress: parsed.data.pay_address,
    payAmount: typeof parsed.data.pay_amount === 'number' ? parsed.data.pay_amount : null,
    payCurrency,
  };
}
