import { z } from 'zod';
import { DomainError, DomainErrorCode } from '../errors/domain-error.js';

/**
 * Subscription domain (owner-decided, 2026-10-30).
 *
 * - Only two plans: Free and Paid. Free covers the Prompt Library only.
 * - Paid is priced per managed page/account, per month, at the same
 *   price on every platform. Facebook counts PAGES; every other
 *   platform counts ACCOUNTS.
 * - The cap is across a platform's features, not per feature: the
 *   usage registry counts DISTINCT destinations a user has used in a
 *   feature, per platform. Connecting an account/page never counts;
 *   using it inside a feature (schedule, publish-now, and future
 *   features calling the same registry) does.
 * - A paid period is 30 days from approval. The credit divisor is
 *   also 30, so the upgrade math and the period length agree.
 */

export const SUBSCRIPTION_PRICE_PKR_PER_UNIT = 70;
export const SUBSCRIPTION_PERIOD_DAYS = 30;
export const SUBSCRIPTION_UPGRADE_CREDIT_DIVISOR_DAYS = 30;

export const SubscriptionPlatformSchema = z.enum([
  'facebook',
  'instagram',
  'threads',
  'x',
  'tiktok',
  'youtube',
]);
export type SubscriptionPlatform = z.infer<typeof SubscriptionPlatformSchema>;

export const SUBSCRIPTION_PLATFORMS: SubscriptionPlatform[] = [
  'facebook',
  'instagram',
  'threads',
  'x',
  'tiktok',
  'youtube',
];

/** Facebook counts pages; every other platform counts accounts. */
export function subscriptionUnitLabel(platform: SubscriptionPlatform): 'pages' | 'accounts' {
  return platform === 'facebook' ? 'pages' : 'accounts';
}

const countField = z.number().int().min(0).max(100000);

export const PlatformCountsSchema = z.object({
  facebook: countField,
  instagram: countField,
  threads: countField,
  x: countField,
  tiktok: countField,
  youtube: countField,
});
export type PlatformCounts = z.infer<typeof PlatformCountsSchema>;

export const ZERO_PLATFORM_COUNTS: PlatformCounts = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

export function totalUnits(counts: PlatformCounts): number {
  return SUBSCRIPTION_PLATFORMS.reduce((sum, platform) => sum + counts[platform], 0);
}

export function totalPricePkr(counts: PlatformCounts): number {
  return totalUnits(counts) * SUBSCRIPTION_PRICE_PKR_PER_UNIT;
}

/**
 * Whole days remaining in a period, rounded UP: a period ending in
 * any part of a day still has that day left. Never negative.
 */
export function daysRemainingBetween(now: Date, endsAt: Date): number {
  const ms = endsAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

/**
 * Upgrade credit, rounded to the nearest whole PKR (owner example:
 * 700 / 30 x 10 = 233.33 -> 233).
 */
export function upgradeCreditPkr(oldMonthlyTotalPkr: number, daysRemaining: number): number {
  if (oldMonthlyTotalPkr <= 0 || daysRemaining <= 0) return 0;
  return Math.round(
    (oldMonthlyTotalPkr / SUBSCRIPTION_UPGRADE_CREDIT_DIVISOR_DAYS) * daysRemaining
  );
}

export interface UpgradeQuote {
  oldMonthlyTotalPkr: number;
  newMonthlyTotalPkr: number;
  daysRemaining: number;
  creditPkr: number;
  amountToPayPkr: number;
}

/**
 * Upgrades only, mid-cycle: the new plan must cost more in total
 * AND must not reduce any single platform's count (otherwise a
 * "upgrade" could smuggle in a downgrade on one platform).
 * Returns the amount to pay after credit. Throws DomainError on
 * any downgrade, same-total change, or empty plan.
 */
export function quoteUpgrade(
  oldCounts: PlatformCounts,
  newCounts: PlatformCounts,
  daysRemaining: number
): UpgradeQuote {
  const oldTotal = totalPricePkr(oldCounts);
  const newTotal = totalPricePkr(newCounts);
  if (totalUnits(newCounts) === 0) {
    throw new DomainError(
      DomainErrorCode.VALIDATION_FAILED,
      'An upgrade needs at least one page or account.'
    );
  }
  for (const platform of SUBSCRIPTION_PLATFORMS) {
    if (newCounts[platform] < oldCounts[platform]) {
      throw new DomainError(
        DomainErrorCode.VALIDATION_FAILED,
        'Counts can only be increased mid-cycle. To reduce a count, wait until the current period ends.'
      );
    }
  }
  if (newTotal <= oldTotal) {
    throw new DomainError(
      DomainErrorCode.VALIDATION_FAILED,
      'An upgrade must cost more than the current plan.'
    );
  }
  const credit = upgradeCreditPkr(oldTotal, daysRemaining);
  return {
    oldMonthlyTotalPkr: oldTotal,
    newMonthlyTotalPkr: newTotal,
    daysRemaining,
    creditPkr: credit,
    amountToPayPkr: Math.max(0, newTotal - credit),
  };
}

/** A period is active only while now is inside [startsAt, endsAt). */
export function isPeriodActive(
  period: { startsAt: Date; endsAt: Date; supersededAt: Date | null },
  now: Date
): boolean {
  if (period.supersededAt !== null) return false;
  return now >= period.startsAt && now < period.endsAt;
}

/**
 * Cap check against the usage registry. A destination already
 * registered counts once and is always allowed; a new destination
 * is allowed only while distinct usage is below the cap.
 */
export function canUseDestination(
  usedDestinationKeys: string[],
  destinationKey: string,
  allowedCount: number
): boolean {
  if (usedDestinationKeys.includes(destinationKey)) return true;
  return usedDestinationKeys.length < allowedCount;
}

export const SubscriptionPlanSchema = z.enum(['free', 'paid']);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlanSchema>;

export const BankMethodSchema = z.enum(['easypaisa', 'nayapay', 'ubl']);
export type BankMethod = z.infer<typeof BankMethodSchema>;

export const PaymentMethodSchema = z.enum(['bank', 'nowpayments']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PaymentStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'paid',
  'failed',
  'expired',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const CryptoNetworkSchema = z.enum(['trc20', 'bep20']);
export type CryptoNetwork = z.infer<typeof CryptoNetworkSchema>;

/**
 * NOWPayments pay_currency tickers, as used in NOWPayments' own
 * API examples: USDT on Tron is `usdttrc20`; USDT on BNB Chain is
 * `usdtbsc`. If NOWPayments rejects a ticker, the checkout surfaces
 * its error plainly instead of falling back to another network.
 */
export function nowPaymentsPayCurrency(network: CryptoNetwork): string {
  return network === 'trc20' ? 'usdttrc20' : 'usdtbsc';
}

export const CreateBankPaymentRequestSchema = z.object({
  counts: PlatformCountsSchema,
  bankMethod: BankMethodSchema,
  isUpgrade: z.boolean(),
});
export type CreateBankPaymentRequest = z.infer<typeof CreateBankPaymentRequestSchema>;

export const CreateCryptoCheckoutRequestSchema = z.object({
  counts: PlatformCountsSchema,
  network: CryptoNetworkSchema,
  isUpgrade: z.boolean(),
});
export type CreateCryptoCheckoutRequest = z.infer<typeof CreateCryptoCheckoutRequestSchema>;

export const AdminDecisionRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});
export type AdminDecisionRequest = z.infer<typeof AdminDecisionRequestSchema>;

export const UsageRegisterRequestSchema = z.object({
  platform: SubscriptionPlatformSchema,
  destinationKey: z.string().min(1).max(512),
  feature: z.string().min(1).max(64),
  destinationId: z.string().uuid().nullable().optional(),
});
export type UsageRegisterRequest = z.infer<typeof UsageRegisterRequestSchema>;

export const EntitlementResponseSchema = z.object({
  plan: SubscriptionPlanSchema,
  active: z.boolean(),
  counts: PlatformCountsSchema,
  usage: PlatformCountsSchema,
  periodEndsAt: z.string().nullable(),
  periodStartsAt: z.string().nullable(),
  canPost: z.boolean(),
  readOnly: z.boolean(),
  reason: z.string().nullable(),
  /**
   * True when the user has ever held a paid period (active or lapsed).
   * Lets the sidebar tell "never paid" (Free) apart from "lapsed"
   * (Expired): the active-period fields alone cannot, since both
   * cases report null period bounds.
   */
  hasPriorPeriod: z.boolean(),
});
export type EntitlementResponse = z.infer<typeof EntitlementResponseSchema>;

export const BillingPaymentItemSchema = z.object({
  id: z.string().uuid(),
  method: PaymentMethodSchema,
  bankMethod: BankMethodSchema.nullable(),
  status: PaymentStatusSchema,
  counts: PlatformCountsSchema,
  amountPkr: z.number().int().min(0),
  isUpgrade: z.boolean(),
  screenshotStorageKey: z.string().nullable(),
  nowpaymentsPaymentId: z.string().nullable(),
  nowpaymentsPayAddress: z.string().nullable(),
  nowpaymentsPayAmount: z.number().nullable(),
  nowpaymentsNetwork: CryptoNetworkSchema.nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
});
export type BillingPaymentItem = z.infer<typeof BillingPaymentItemSchema>;

export const BillingStatusResponseSchema = z.object({
  entitlement: EntitlementResponseSchema,
  payments: z.array(BillingPaymentItemSchema),
});
export type BillingStatusResponse = z.infer<typeof BillingStatusResponseSchema>;

export const AdminPaymentItemSchema = BillingPaymentItemSchema.extend({
  userId: z.string().uuid(),
  userEmail: z.string().nullable(),
});
export type AdminPaymentItem = z.infer<typeof AdminPaymentItemSchema>;

export const AdminPaymentsResponseSchema = z.object({
  payments: z.array(AdminPaymentItemSchema),
});
export type AdminPaymentsResponse = z.infer<typeof AdminPaymentsResponseSchema>;

export const CryptoCheckoutResponseSchema = z.object({
  paymentId: z.string().uuid(),
  nowpaymentsPaymentId: z.string(),
  payAddress: z.string(),
  payAmount: z.number().nullable(),
  payCurrency: z.string(),
  network: CryptoNetworkSchema,
  amountPkr: z.number().int().min(0),
  estimatedUsdt: z.number().nullable(),
  minimumUsdt: z.number().nullable(),
  belowMinimum: z.boolean(),
});
export type CryptoCheckoutResponse = z.infer<typeof CryptoCheckoutResponseSchema>;

/** NOWPayments POST /v1/payment response (fields we rely on). */
export const NowPaymentsCreatePaymentResponseSchema = z
  .object({
    payment_id: z.union([z.string(), z.number()]),
    pay_address: z.string().min(1),
    pay_amount: z.number().optional(),
    pay_currency: z.string().optional(),
  })
  .passthrough();
export type NowPaymentsCreatePaymentResponse = z.infer<
  typeof NowPaymentsCreatePaymentResponseSchema
>;

/** NOWPayments GET /v1/estimate response. */
export const NowPaymentsEstimateResponseSchema = z
  .object({
    estimated_amount: z.number(),
    currency_from: z.string().optional(),
    currency_to: z.string().optional(),
  })
  .passthrough();
export type NowPaymentsEstimateResponse = z.infer<typeof NowPaymentsEstimateResponseSchema>;

/** NOWPayments GET /v1/min-amount response. */
export const NowPaymentsMinAmountResponseSchema = z
  .object({
    min_amount: z.number(),
    fiat_equivalent: z.number().optional(),
  })
  .passthrough();
export type NowPaymentsMinAmountResponse = z.infer<typeof NowPaymentsMinAmountResponseSchema>;

/**
 * NOWPayments IPN (Instant Payment Notification) payload. Extra
 * provider fields pass through; the fields we act on are validated.
 * Statuses come from NOWPayments' own list: waiting, confirming,
 * confirmed, finished, failed, expired, partially_paid, refunded.
 */
export const NowPaymentsIpnPayloadSchema = z
  .object({
    payment_id: z.union([z.string(), z.number()]),
    payment_status: z.string().min(1),
    pay_amount: z.number().optional(),
    price_amount: z.number().optional(),
    price_currency: z.string().optional(),
    pay_currency: z.string().optional(),
    order_id: z.string().optional(),
    actually_paid: z.number().optional(),
  })
  .passthrough();
export type NowPaymentsIpnPayload = z.infer<typeof NowPaymentsIpnPayloadSchema>;

/** Recursively sort an object's keys alphabetically, as NOWPayments' IPN signing requires. */
export function sortObjectForNowPaymentsSignature(
  value: unknown
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectForNowPaymentsSignature(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    // Byte order, NOT locale order: NOWPayments computes its IPN
    // signature over keys sorted by code unit (its ksort / default
    // sort), so localeCompare would canonicalise differently and
    // break verification. NOSONAR (typescript:S2871) — this sort is
    // signing input, not display text.
    for (const key of Object.keys(record).sort()) { // NOSONAR
      sorted[key] = sortObjectForNowPaymentsSignature(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Verify a NOWPayments IPN signature: HMAC-SHA512 over the
 * alphabetically-sorted JSON body, with the IPN secret as key,
 * compared against the `x-nowpayments-sig` header. Uses WebCrypto
 * so it runs in Node and edge runtimes alike. A missing secret or
 * signature is a verification failure, never a pass.
 */
export async function verifyNowPaymentsIpnSignature(
  payload: Record<string, unknown>,
  signature: string | null,
  ipnSecret: string | null
): Promise<boolean> {
  if (!signature || !ipnSecret) return false;
  const sortedJson = JSON.stringify(sortObjectForNowPaymentsSignature(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(ipnSecret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sortedJson));
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i += 1) {
    diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
