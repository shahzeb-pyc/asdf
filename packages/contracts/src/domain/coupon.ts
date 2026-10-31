import { z } from 'zod';
import { PlatformCountsSchema } from './subscription.js';

/**
 * Coupons (owner-decided 2026-10-31).
 *
 * Three kinds:
 * - percent_once: percent off, redeemable ONCE globally. The first
 *   user to apply it consumes it; afterwards it is dead.
 * - percent_multi: percent off, usable by anyone any number of
 *   times until the admin pauses or deletes it. No usage cap, no
 *   balance — pause/delete is its only lifetime.
 * - balance: a fixed PKR value, a shared pool. Any user draws from
 *   the same remaining balance; each use deducts min(balance,
 *   amount due); the remainder stays usable until the balance is 0.
 *
 * Codes are not tied to a user. One coupon per purchase, enforced
 * server-side. Discount math is server-side only; amounts are
 * integer PKR and percent discounts round to the nearest PKR.
 */

export const CouponKindSchema = z.enum(['percent_once', 'percent_multi', 'balance']);
export type CouponKind = z.infer<typeof CouponKindSchema>;

export const CouponStatusSchema = z.enum(['active', 'paused', 'deleted']);
export type CouponStatus = z.infer<typeof CouponStatusSchema>;

export const CouponRedemptionStatusSchema = z.enum(['held', 'applied', 'released']);
export type CouponRedemptionStatus = z.infer<typeof CouponRedemptionStatusSchema>;

/** Codes are stored and looked up normalized: trimmed, uppercased. */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

const couponCodeField = z
  .string()
  .min(4, 'Coupon codes are at least 4 characters.')
  .max(32, 'Coupon codes are at most 32 characters.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'Coupon codes use letters, numbers, dashes, and underscores.'
  );

export const CouponSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1),
  kind: CouponKindSchema,
  percent: z.number().int().min(1).max(100).nullable(),
  initialBalancePkr: z.number().int().min(0).nullable(),
  remainingBalancePkr: z.number().int().min(0).nullable(),
  consumedAt: z.string().nullable(),
  status: CouponStatusSchema,
  redemptionsCount: z.number().int().min(0),
  createdAt: z.string(),
});
export type Coupon = z.infer<typeof CouponSchema>;

export const CouponRedemptionSchema = z.object({
  id: z.string().uuid(),
  couponId: z.string().uuid(),
  couponCode: z.string().min(1),
  userId: z.string().uuid(),
  userEmail: z.string().nullable(),
  paymentId: z.string().uuid().nullable(),
  periodId: z.string().uuid().nullable(),
  amountPkr: z.number().int().min(0),
  status: CouponRedemptionStatusSchema,
  createdAt: z.string(),
});
export type CouponRedemption = z.infer<typeof CouponRedemptionSchema>;

/** Percent discount, rounded to the nearest whole PKR. */
export function percentDiscountPkr(amountPkr: number, percent: number): number {
  if (amountPkr <= 0 || percent <= 0) return 0;
  return Math.round((amountPkr * percent) / 100);
}

/** Balance discount: capped at the remaining balance, never below 0. */
export function balanceDiscountPkr(amountPkr: number, remainingBalancePkr: number): number {
  if (amountPkr <= 0 || remainingBalancePkr <= 0) return 0;
  return Math.min(amountPkr, remainingBalancePkr);
}

export const CreateCouponRequestSchema = z
  .object({
    code: couponCodeField,
    kind: CouponKindSchema,
    percent: z.number().int().min(1).max(100).optional(),
    valuePkr: z.number().int().min(1).max(100000000).optional(),
  })
  .refine(
    (value) =>
      value.kind === 'balance'
        ? value.valuePkr !== undefined && value.percent === undefined
        : value.percent !== undefined && value.valuePkr === undefined,
    {
      message:
        'Percent coupons need a percent (1–100); balance coupons need a PKR value, not a percent.',
    }
  );
export type CreateCouponRequest = z.infer<typeof CreateCouponRequestSchema>;

export const AdminCouponActionSchema = z.object({
  action: z.enum(['pause', 'resume', 'delete']),
});
export type AdminCouponAction = z.infer<typeof AdminCouponActionSchema>;

export const CouponValidateRequestSchema = z.object({
  code: z.string().min(1).max(32),
  counts: PlatformCountsSchema,
});
export type CouponValidateRequest = z.infer<typeof CouponValidateRequestSchema>;

export const CouponValidateResponseSchema = z.object({
  code: z.string().min(1),
  kind: CouponKindSchema,
  percent: z.number().int().min(1).max(100).nullable(),
  discountPkr: z.number().int().min(0),
  amountDuePkr: z.number().int().min(0),
  amountAfterDiscountPkr: z.number().int().min(0),
  fullyCovered: z.boolean(),
});
export type CouponValidateResponse = z.infer<typeof CouponValidateResponseSchema>;

export const ZeroDueCheckoutRequestSchema = z.object({
  counts: PlatformCountsSchema,
  couponCode: z.string().min(1).max(32),
});
export type ZeroDueCheckoutRequest = z.infer<typeof ZeroDueCheckoutRequestSchema>;

export const ZeroDueCheckoutResponseSchema = z.object({
  period: z.object({
    id: z.string().uuid(),
    startsAt: z.string(),
    endsAt: z.string(),
  }),
  couponCode: z.string().min(1),
  discountPkr: z.number().int().min(0),
  counts: PlatformCountsSchema,
  isUpgrade: z.boolean(),
});
export type ZeroDueCheckoutResponse = z.infer<typeof ZeroDueCheckoutResponseSchema>;

export const CouponsListResponseSchema = z.object({
  coupons: z.array(CouponSchema),
  page: z.number().int().min(1),
});
export type CouponsListResponse = z.infer<typeof CouponsListResponseSchema>;

export const CouponRedemptionsResponseSchema = z.object({
  redemptions: z.array(CouponRedemptionSchema),
  page: z.number().int().min(1),
});
export type CouponRedemptionsResponse = z.infer<typeof CouponRedemptionsResponseSchema>;
