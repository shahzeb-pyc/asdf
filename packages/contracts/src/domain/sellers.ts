import { z } from 'zod';

/**
 * Sellers (reseller) system (owner-approved 2026-11-01).
 *
 * Referral-only. There are NO seller coupons: the coupon system
 * stays admin-only and is untouched by this module.
 *
 * - Sellers are `users` rows with role 'seller', created by an
 *   admin with a password the admin sets (email auto-confirmed,
 *   no OTP). A seller account is never also a user account: it
 *   has no workspace and sees only the seller view.
 * - Per seller, the admin picks at creation (both, every time,
 *   no defaults): a commission rate (whole percent, 1–100) and
 *   a scope ('one-time' | 'every'). Later changes apply only
 *   to future purchases: every commission row snapshots the
 *   rate and scope in force at purchase time.
 * - Attribution is referral-only: the link active at signup wins
 *   and is stored on the account immutably, forever. Codes are
 *   seller-chosen, stored uppercase, globally unique across
 *   every code ever used, changeable, with all past codes
 *   staying valid forever.
 * - Commission is earned on approved/finished payments by
 *   referred users: rate × amount actually paid after any
 *   discount, in PKR always. One-time means strictly the first
 *   purchase ever (even refunded, even zero-due, the bounty is
 *   spent). Every means all purchases including renewals and
 *   upgrades (on what was paid after upgrade credit).
 * - Lifecycle: pending → payable once BOTH 10 days have passed
 *   from plan start AND no unresolved refund request exists on
 *   that payment. A refund approved while pending cancels the
 *   commission (full refund) or reduces it to rate × kept
 *   amount (partial refund). A rejected refund unblocks it.
 * - Payout: the seller requests ALL currently payable
 *   commissions at once; below 1000 PKR total the request is
 *   refused with the shortfall. The admin pays outside the app
 *   and marks the batch sent; rejecting a request returns its
 *   commissions to payable. New payables wait for the next
 *   request (a request snapshots its commissions).
 * - Pause freezes new signups AND new commissions; existing
 *   balances stay payable. Deletion is blocked until every
 *   commission (pending, payable, requested) is paid out.
 */

/** Minimum payout request total, PKR. */
export const SELLER_PAYOUT_MINIMUM_PKR = 1000;

/** Days from plan start before a commission can become payable. */
export const SELLER_COMMISSION_PAYABLE_AFTER_DAYS = 10;

export const SellerScopeSchema = z.enum(['one-time', 'every']);
export type SellerScope = z.infer<typeof SellerScopeSchema>;

export const SellerStatusSchema = z.enum(['active', 'paused', 'deleted']);
export type SellerStatus = z.infer<typeof SellerStatusSchema>;

export const CommissionStatusSchema = z.enum([
  'pending',
  'payable',
  'requested',
  'paid',
  'cancelled',
]);
export type CommissionStatus = z.infer<typeof CommissionStatusSchema>;

export const PayoutRequestStatusSchema = z.enum(['pending', 'paid', 'rejected']);
export type PayoutRequestStatus = z.infer<typeof PayoutRequestStatusSchema>;

export const SellerPayoutMethodSchema = z.enum(['easypaisa', 'nayapay', 'ubl', 'binance']);
export type SellerPayoutMethod = z.infer<typeof SellerPayoutMethodSchema>;

/** Codes are stored and looked up normalized: trimmed, uppercased. */
export function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase();
}

const referralCodeField = z
  .string()
  .min(4, 'Referral codes are at least 4 characters.')
  .max(32, 'Referral codes are at most 32 characters.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'Referral codes use letters, numbers, dashes, and underscores.'
  );

export const ReferralCodeSchema = referralCodeField.transform(normalizeReferralCode);
export type ReferralCode = z.infer<typeof ReferralCodeSchema>;

export const SellerRateSchema = z
  .number()
  .int('Commission rate is a whole percent.')
  .min(1, 'Commission rate is at least 1 percent.')
  .max(100, 'Commission rate is at most 100 percent.');

export const SellerCreateSchema = z.object({
  name: z.string().trim().min(1, 'Full name is required').max(100),
  email: z.string().trim().toLowerCase().email('A valid email is required').max(255),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128),
  rate: SellerRateSchema,
  scope: SellerScopeSchema,
  /** Optional initial code: when omitted the seller starts with
   * no code and sets one from their own dashboard. The format
   * rule matches the seller self-change path (referralCodeField:
   * 4–32 letters, numbers, dashes, underscores); normalization
   * to uppercase happens in changeReferralCode, so this field
   * deliberately carries no transform — a transform would make
   * the schema's input type unknown and break the create form's
   * resolver typing under exactOptionalPropertyTypes. */
  referralCode: referralCodeField.optional(),
});
export type SellerCreate = z.infer<typeof SellerCreateSchema>;
export type SellerCreateInput = z.infer<typeof SellerCreateSchema>;

export const SellerPatchSchema = z
  .object({
    rate: SellerRateSchema.optional(),
    scope: SellerScopeSchema.optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((v) => v.rate !== undefined || v.scope !== undefined || v.status !== undefined, {
    message: 'Nothing to update.',
  });
export type SellerPatch = z.infer<typeof SellerPatchSchema>;

export const SellerPayoutDetailsSchema = z.object({
  method: SellerPayoutMethodSchema,
  accountLabel: z.string().trim().min(1, 'Payout account is required').max(255),
});
export type SellerPayoutDetails = z.infer<typeof SellerPayoutDetailsSchema>;

export const ReferralCodeChangeSchema = z.object({
  code: ReferralCodeSchema,
});
export type ReferralCodeChange = z.infer<typeof ReferralCodeChangeSchema>;

export const PayoutDecisionSchema = z.object({
  action: z.enum(['mark-sent', 'reject']),
});
export type PayoutDecision = z.infer<typeof PayoutDecisionSchema>;

export const SellerRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
  currentCode: z.string().nullable(),
  rate: z.number().int(),
  scope: SellerScopeSchema,
  status: SellerStatusSchema,
  signups: z.number().int().min(0),
  purchasers: z.number().int().min(0),
  pendingPkr: z.number().int().min(0),
  payablePkr: z.number().int().min(0),
  requestedPkr: z.number().int().min(0),
  paidPkr: z.number().int().min(0),
  createdAt: z.string(),
});
export type SellerRow = z.infer<typeof SellerRowSchema>;

export const SellerCommissionRowSchema = z.object({
  id: z.string().uuid(),
  buyerName: z.string().nullable(),
  buyerEmail: z.string(),
  paymentId: z.string().uuid(),
  periodStartsAt: z.string(),
  rate: z.number().int(),
  scope: SellerScopeSchema,
  amountPkr: z.number().int().min(0),
  status: CommissionStatusSchema,
  createdAt: z.string(),
});
export type SellerCommissionRow = z.infer<typeof SellerCommissionRowSchema>;

export const SellerPayoutRequestRowSchema = z.object({
  id: z.string().uuid(),
  sellerId: z.string().uuid(),
  sellerName: z.string().nullable(),
  sellerEmail: z.string(),
  totalPkr: z.number().int().min(0),
  commissionCount: z.number().int().min(0),
  status: PayoutRequestStatusSchema,
  payoutMethod: SellerPayoutMethodSchema.nullable(),
  payoutAccount: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type SellerPayoutRequestRow = z.infer<typeof SellerPayoutRequestRowSchema>;

export const ReferredUserRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
  referralCode: z.string().nullable(),
  purchased: z.boolean(),
  signedUpAt: z.string(),
});
export type ReferredUserRow = z.infer<typeof ReferredUserRowSchema>;

/** Commission math: PKR nearest rupee, exactly like refund math. */
export function commissionAmountPkr(rate: number, amountPkr: number): number {
  return Math.round((rate * amountPkr) / 100);
}
