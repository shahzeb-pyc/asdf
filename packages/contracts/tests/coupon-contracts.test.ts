import { describe, it, expect } from 'vitest';
import {
  balanceDiscountPkr,
  CreateCouponRequestSchema,
  CouponValidateResponseSchema,
  normalizeCouponCode,
  percentDiscountPkr,
} from '../src/domain/coupon.js';
import { ZERO_PLATFORM_COUNTS, type PlatformCounts } from '../src/domain/subscription.js';

function counts(partial: Partial<PlatformCounts>): PlatformCounts {
  return { ...ZERO_PLATFORM_COUNTS, ...partial };
}

describe('percentDiscountPkr', () => {
  it('computes 20% off a known total', () => {
    expect(percentDiscountPkr(700, 20)).toBe(140);
  });

  it('rounds to the nearest PKR, halves up', () => {
    // 333 × 10% = 33.3 → 33; 335 × 10% = 33.5 → 34.
    expect(percentDiscountPkr(333, 10)).toBe(33);
    expect(percentDiscountPkr(335, 10)).toBe(34);
  });

  it('never discounts a non-positive amount', () => {
    expect(percentDiscountPkr(0, 20)).toBe(0);
    expect(percentDiscountPkr(-50, 20)).toBe(0);
  });
});

describe('balanceDiscountPkr', () => {
  it('deducts the full amount while balance covers it', () => {
    expect(balanceDiscountPkr(400, 1000)).toBe(400);
  });

  it('caps the discount at the remaining balance', () => {
    expect(balanceDiscountPkr(1500, 1000)).toBe(1000);
  });

  it('gives nothing on an exhausted balance', () => {
    expect(balanceDiscountPkr(400, 0)).toBe(0);
  });
});

describe('normalizeCouponCode', () => {
  it('trims and upper-cases', () => {
    expect(normalizeCouponCode('  save20 ')).toBe('SAVE20');
  });

  it('collapses nothing else: codes are compared exactly after normalisation', () => {
    expect(normalizeCouponCode('SAVE-20_x')).toBe('SAVE-20_X');
  });
});

describe('CreateCouponRequestSchema', () => {
  it('accepts a percent coupon with a percent and no PKR value', () => {
    const parsed = CreateCouponRequestSchema.safeParse({
      code: 'SAVE20',
      kind: 'percent_multi',
      percent: 20,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a balance coupon with a PKR value and no percent', () => {
    const parsed = CreateCouponRequestSchema.safeParse({
      code: 'POOL1000',
      kind: 'balance',
      valuePkr: 1000,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a percent coupon without a percent', () => {
    const parsed = CreateCouponRequestSchema.safeParse({
      code: 'SAVE20',
      kind: 'percent_once',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a balance coupon carrying a percent', () => {
    const parsed = CreateCouponRequestSchema.safeParse({
      code: 'POOL1000',
      kind: 'balance',
      valuePkr: 1000,
      percent: 20,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a percent outside 1–100', () => {
    expect(
      CreateCouponRequestSchema.safeParse({ code: 'X', kind: 'percent_multi', percent: 0 })
        .success
    ).toBe(false);
    expect(
      CreateCouponRequestSchema.safeParse({ code: 'X', kind: 'percent_multi', percent: 101 })
        .success
    ).toBe(false);
  });
});

describe('CouponValidateResponseSchema', () => {
  it('accepts the fully-covered shape', () => {
    const parsed = CouponValidateResponseSchema.safeParse({
      code: 'POOL1000',
      kind: 'balance',
      percent: null,
      discountPkr: 700,
      amountDuePkr: 700,
      amountAfterDiscountPkr: 0,
      fullyCovered: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a negative discount', () => {
    const parsed = CouponValidateResponseSchema.safeParse({
      code: 'SAVE20',
      kind: 'percent_multi',
      percent: 20,
      discountPkr: -1,
      amountDuePkr: 700,
      amountAfterDiscountPkr: 701,
      fullyCovered: false,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('coupon counts shape', () => {
  it('builds platform counts for a validate request', () => {
    const c = counts({ facebook: 10 });
    expect(c.facebook).toBe(10);
    expect(c.instagram).toBe(0);
  });
});
