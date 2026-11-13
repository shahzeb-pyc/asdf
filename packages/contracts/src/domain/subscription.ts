import { z } from 'zod';
import { DomainError, DomainErrorCode } from '../errors/domain-error.js';
import { type Section } from './database.js';

/**
 * Subscription domain (owner-decided, 2026-10-30).
 *
 * - Only two plans: Free and Paid. Free covers the Prompt Library only.
 * - Paid is priced per managed page/account, per month, at the same
 *   price on every platform. Facebook counts PAGES; every other
 *   platform counts ACCOUNTS.
 * - The cap is across a platform's features, not per feature: the
 *   usage registry counts DISTINCT destinations a user has used in a
 *   feature, per platform, per section (spec 174 PR 2B): a page used
 *   in Schedule and in Auto Download registers two rows and counts
 *   twice. Connecting an account/page never counts; using it inside
 *   a feature (schedule, publish-now, and future features calling
 *   the same registry) does.
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

/** Owner decision 2026-11-02: no coupon may discount more than 70%. */
export const MAX_COUPON_PERCENT = 70;

/** Preset rejection reasons, shown to the user (owner decision 2026-11-02). */
export const PAYMENT_REJECTION_REASONS = [
  'Wrong amount',
  'Unreadable screenshot',
  'Wrong account',
  'Duplicate',
  'Other',
] as const;
export type PaymentRejectionReason = (typeof PAYMENT_REJECTION_REASONS)[number];

export interface DowngradeQuote {
  oldMonthlyTotalPkr: number;
  newMonthlyTotalPkr: number;
  /** Amount to pay now: the new monthly total, prepaid for next month. No credit. */
  amountToPayPkr: number;
}

/**
 * Downgrade, period-end only (owner decision 2026-11-02): the new
 * plan must cost less in total AND must not raise any single
 * platform's count (that would be an upgrade). No credit is given
 * for remaining days; the user pays the new monthly total now for
 * the month that starts after the current plan ends.
 * Throws DomainError on any increase, same-total change, or empty plan.
 */
export function quoteDowngrade(
  oldCounts: PlatformCounts,
  newCounts: PlatformCounts
): DowngradeQuote {
  const oldTotal = totalPricePkr(oldCounts);
  const newTotal = totalPricePkr(newCounts);
  if (totalUnits(newCounts) === 0) {
    throw new DomainError(
      DomainErrorCode.VALIDATION_FAILED,
      'A downgrade needs at least one page or account.'
    );
  }
  for (const platform of SUBSCRIPTION_PLATFORMS) {
    if (newCounts[platform] > oldCounts[platform]) {
      throw new DomainError(
        DomainErrorCode.VALIDATION_FAILED,
        'A downgrade cannot raise any page or account count. Raise a count as an upgrade instead.'
      );
    }
  }
  if (newTotal >= oldTotal) {
    throw new DomainError(
      DomainErrorCode.VALIDATION_FAILED,
      'A downgrade must cost less per month than your current plan.'
    );
  }
  return { oldMonthlyTotalPkr: oldTotal, newMonthlyTotalPkr: newTotal, amountToPayPkr: newTotal };
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

/**
 * The plan as the client sees it. 'expired' is an explicit state,
 * not a derivation: a user with no active period but a prior paid
 * period is expired, never free — the sidebar word, the gate, and
 * Home all read this one value instead of re-deriving it from
 * `active` + `hasPriorPeriod` in three different places.
 */
export const SubscriptionPlanSchema = z.enum(['free', 'paid', 'expired']);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlanSchema>;

export const BankMethodSchema = z.enum(['easypaisa', 'nayapay', 'ubl', 'binance']);
export type BankMethod = z.infer<typeof BankMethodSchema>;

export const PaymentMethodSchema = z.enum(['bank']);
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

export const CreateBankPaymentRequestSchema = z.object({
  counts: PlatformCountsSchema,
  bankMethod: BankMethodSchema,
  isUpgrade: z.boolean(),
});
export type CreateBankPaymentRequest = z.infer<typeof CreateBankPaymentRequestSchema>;

export const AdminDecisionRequestSchema = z.object({
  // approve / reject: bank payments only.
  decision: z.enum(['approve', 'reject']),
  // Required for reject (owner decision 2026-11-02); optional free
  // text alongside any preset. Required for approve without a
  // screenshot (override reason), otherwise optional.
  rejectionReason: z.string().min(1).max(200).optional(),
  rejectionDetail: z.string().max(500).optional(),
  overrideReason: z.string().min(1).max(500).optional(),
});
export type AdminDecisionRequest = z.infer<typeof AdminDecisionRequestSchema>;

export const UsageRegisterRequestSchema = z.object({
  platform: SubscriptionPlatformSchema,
  destinationKey: z.string().min(1).max(512),
  feature: z.string().min(1).max(64),
  destinationId: z.string().uuid().nullable().optional(),
});
export type UsageRegisterRequest = z.infer<typeof UsageRegisterRequestSchema>;

/**
 * Spec 174 PR 2B — the section a usage feature counts in.
 *
 * One row per destination per section: the same page used in
 * Schedule and in Auto Download registers two rows and counts
 * twice; Publish Now is uncapped and registers nothing. The
 * feature string already identifies the section 1:1, so the
 * register/release paths derive the section from it here — one
 * mapping, not one per call site. The legacy publish-now
 * features map to 'publish_now' for the migration backfill
 * (their rows are history, excluded from every count); the
 * register path refuses them before it ever derives a section.
 * An unknown feature has no section: callers fail loud instead
 * of inventing one.
 */
export const USAGE_FEATURE_SECTIONS = {
  'destination-queue': 'schedule',
  'auto-download-upload': 'adu',
  'tiktok-mirror': 'mirror',
  'auto-repost': 'mirror',
  'publish-now': 'publish_now',
  'instagram-publish-now': 'publish_now',
  'threads-publish-now': 'publish_now',
} as const satisfies Record<string, Section>;

export function sectionForUsageFeature(feature: string): Section | null {
  const section = (USAGE_FEATURE_SECTIONS as Record<string, Section | undefined>)[feature];
  return section ?? null;
}

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

/**
 * Plan-check C2 / spec 152 O1 — the single-query entitlement RPC
 * (`public.get_entitlement`, migration 20261109150000). Contracts
 * first: the RPC's JSON shape is typed here, and the web mapper
 * (`getEntitlementViaRpc`) validates the answer against this schema
 * instead of hand-checking fields — a malformed answer fails closed
 * (ENTITLEMENT_UNAVAILABLE, never an invented Free).
 *
 * Shape mirrors the SQL exactly: `period` is the active
 * `subscription_periods` row as `row_to_json` returns it (snake_case
 * count columns, ISO timestamps, `superseded_at` null when live);
 * `usage` is the six per-platform counts with the legacy
 * publish-now exclusion and the disconnected-destination exclusion
 * already applied in SQL; `has_prior_period` is the ever-paid flag.
 * Ids are plain non-empty strings on purpose — the parity-test
 * fixtures (and the mapper's `periodFromRow`) accept any string id,
 * not only UUIDs, so a `.uuid()` here would reject answers the
 * mapper already accepts. Counts use `.catch(0)`, matching
 * `numberField`'s tolerance for a missing/mistyped count column.
 */
const rpcCountField = z.number().int().min(0).catch(0);

export const EntitlementRpcPeriodRowSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  facebook_count: rpcCountField,
  instagram_count: rpcCountField,
  threads_count: rpcCountField,
  x_count: rpcCountField,
  tiktok_count: rpcCountField,
  youtube_count: rpcCountField,
  starts_at: z.string().min(1),
  ends_at: z.string().min(1),
  superseded_at: z.string().nullable(),
});
export type EntitlementRpcPeriodRow = z.infer<typeof EntitlementRpcPeriodRowSchema>;

export const EntitlementRpcResultSchema = z.object({
  period: EntitlementRpcPeriodRowSchema.nullable(),
  usage: PlatformCountsSchema,
  has_prior_period: z.boolean(),
});
export type EntitlementRpcResult = z.infer<typeof EntitlementRpcResultSchema>;

export const BillingPaymentItemSchema = z.object({
  id: z.string().uuid(),
  method: PaymentMethodSchema,
  bankMethod: BankMethodSchema.nullable(),
  status: PaymentStatusSchema,
  counts: PlatformCountsSchema,
  amountPkr: z.number().int().min(0),
  isUpgrade: z.boolean(),
  isDowngrade: z.boolean().default(false),
  scheduledStartsAt: z.string().nullable().default(null),
  rejectionReason: z.string().nullable().default(null),
  rejectionDetail: z.string().nullable().default(null),
  overrideReason: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
  screenshotStorageKey: z.string().nullable(),
  couponCode: z.string().nullable().default(null),
  discountPkr: z.number().int().min(0).default(0),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
});
export type BillingPaymentItem = z.infer<typeof BillingPaymentItemSchema>;

export const BillingStatusResponseSchema = z.object({
  entitlement: EntitlementResponseSchema,
  payments: z.array(BillingPaymentItemSchema),
});
export type BillingStatusResponse = z.infer<typeof BillingStatusResponseSchema>;

/**
 * Manual payment screenshot upload, split out of the payment POST
 * (submit rewrite 2026-11-01): the browser uploads the screenshot
 * straight to R2 through a presigned URL, so a multi-MB image never
 * rides a serverless function body and checkout can show the upload's
 * own loading state and block submit until it finishes. The payment
 * POST then references the stored key instead of a file. Screenshots
 * never counted against the media library quota, so minting applies
 * no quota gate.
 */
export const SCREENSHOT_UPLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export const BillingScreenshotUploadUrlRequestSchema = z.object({
  mimeType: z.enum(SCREENSHOT_UPLOAD_MIME_TYPES),
  fileSize: z.number().int().min(1).max(MAX_SCREENSHOT_BYTES),
});
export type BillingScreenshotUploadUrlRequest = z.infer<
  typeof BillingScreenshotUploadUrlRequestSchema
>;

export const BillingScreenshotUploadUrlResponseSchema = z.object({
  storageKey: z.string().min(1),
  uploadUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
export type BillingScreenshotUploadUrlResponse = z.infer<
  typeof BillingScreenshotUploadUrlResponseSchema
>;

/**
 * Manual bank payment submission (JSON now, not multipart): the
 * screenshot is already in R2 under the given key, minted by the
 * upload route for this user. The route verifies the key belongs to
 * the caller — a key minted for another user, or a made-up path, is
 * refused before any row is created.
 */
export const BillingBankPaymentSubmitSchema = z.object({
  counts: PlatformCountsSchema,
  bankMethod: BankMethodSchema,
  screenshotStorageKey: z.string().min(1).max(512),
  couponCode: z.string().trim().min(1).max(64).optional(),
});
export type BillingBankPaymentSubmit = z.infer<typeof BillingBankPaymentSubmitSchema>;

/**
 * Media Library storage state, computed server-side from the same
 * quota/usage source as upload enforcement (5 GB per paid unit in the
 * active period; live media_items.file_size sum). `state` is null when
 * there is no active period — the Free-plan dialog already blocks the
 * library then, so the meter renders nothing instead of inventing a
 * limit. `hasActivePeriod` is quotaBytes > 0, stated explicitly so
 * clients never re-derive it from the byte counts.
 */
export const MediaStorageResponseSchema = z.object({
  quotaBytes: z.number().int().min(0),
  usedBytes: z.number().int().min(0),
  remainingBytes: z.number().int().min(0),
  overBytes: z.number().int().min(0),
  state: z.enum(['normal', 'near', 'full', 'over']).nullable(),
  hasActivePeriod: z.boolean(),
});
export type MediaStorageResponse = z.infer<typeof MediaStorageResponseSchema>;

export const AdminPaymentItemSchema = BillingPaymentItemSchema.extend({
  userId: z.string().uuid(),
  userEmail: z.string().nullable(),
});
export type AdminPaymentItem = z.infer<typeof AdminPaymentItemSchema>;

export const AdminPaymentsResponseSchema = z.object({
  payments: z.array(AdminPaymentItemSchema),
  page: z.number().int().default(1),
  pendingTotal: z.number().int().default(0),
});
export type AdminPaymentsResponse = z.infer<typeof AdminPaymentsResponseSchema>;

