import { describe, expect, it } from 'vitest';
import {
  commissionAmountPkr,
  normalizeReferralCode,
  ReferralCodeSchema,
  SellerCreateSchema,
  SellerPatchSchema,
  SellerPayoutDetailsSchema,
  SELLER_COMMISSION_PAYABLE_AFTER_DAYS,
  SELLER_PAYOUT_MINIMUM_PKR,
} from './sellers.js';

describe('sellers contracts', () => {
  it('keeps the payout minimum and payable delay from the approved plan', () => {
    expect(SELLER_PAYOUT_MINIMUM_PKR).toBe(1000);
    expect(SELLER_COMMISSION_PAYABLE_AFTER_DAYS).toBe(10);
  });

  it('computes commission as rate × paid, PKR nearest rupee', () => {
    expect(commissionAmountPkr(20, 7000)).toBe(1400);
    expect(commissionAmountPkr(15, 3333)).toBe(500);
    expect(commissionAmountPkr(100, 1234)).toBe(1234);
    expect(commissionAmountPkr(20, 0)).toBe(0);
  });

  it('normalizes referral codes to trimmed uppercase', () => {
    expect(normalizeReferralCode('  ali20 ')).toBe('ALI20');
    expect(ReferralCodeSchema.parse('ali-20_x')).toBe('ALI-20_X');
  });

  it('rejects codes that are too short, too long, or use other characters', () => {
    expect(ReferralCodeSchema.safeParse('AB').success).toBe(false);
    expect(ReferralCodeSchema.safeParse('A'.repeat(33)).success).toBe(false);
    expect(ReferralCodeSchema.safeParse('ALI 20').success).toBe(false);
    expect(ReferralCodeSchema.safeParse('ALI.20').success).toBe(false);
  });

  it('requires both rate and scope at creation, with no defaults', () => {
    const base = { name: 'Ali', email: 'ali@example.com', password: 'password123' };
    expect(SellerCreateSchema.safeParse(base).success).toBe(false);
    expect(SellerCreateSchema.safeParse({ ...base, rate: 20 }).success).toBe(false);
    expect(SellerCreateSchema.safeParse({ ...base, scope: 'every' }).success).toBe(false);
    expect(
      SellerCreateSchema.safeParse({ ...base, rate: 20, scope: 'every' }).success
    ).toBe(true);
  });

  it('rejects non-whole or out-of-range rates', () => {
    const base = {
      name: 'Ali',
      email: 'ali@example.com',
      password: 'password123',
      scope: 'every' as const,
    };
    expect(SellerCreateSchema.safeParse({ ...base, rate: 0 }).success).toBe(false);
    expect(SellerCreateSchema.safeParse({ ...base, rate: 101 }).success).toBe(false);
    expect(SellerCreateSchema.safeParse({ ...base, rate: 12.5 }).success).toBe(false);
  });

  it('allows an optional initial code but rejects a blank update', () => {
    const base = {
      name: 'Ali',
      email: 'ali@example.com',
      password: 'password123',
      rate: 20,
      scope: 'every' as const,
    };
    expect(SellerCreateSchema.safeParse({ ...base, referralCode: 'ALI20' }).success).toBe(true);
    expect(SellerPatchSchema.safeParse({}).success).toBe(false);
    expect(SellerPatchSchema.safeParse({ rate: 15 }).success).toBe(true);
    expect(SellerPatchSchema.safeParse({ status: 'paused' }).success).toBe(true);
    expect(SellerPatchSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });

  it('accepts all four payout methods with an account label', () => {
    for (const method of ['easypaisa', 'nayapay', 'ubl', 'binance'] as const) {
      expect(
        SellerPayoutDetailsSchema.safeParse({ method, accountLabel: '03270000000' }).success
      ).toBe(true);
    }
    expect(
      SellerPayoutDetailsSchema.safeParse({ method: 'easypaisa', accountLabel: '' }).success
    ).toBe(false);
    expect(
      SellerPayoutDetailsSchema.safeParse({ method: 'bank', accountLabel: 'x' }).success
    ).toBe(false);
  });
});
