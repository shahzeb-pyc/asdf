import { describe, expect, it } from 'vitest';
import {
  computeRefundAmount,
  daysUsedBetween,
  isWithinRefundWindow,
  REFUND_WINDOW_DAYS,
  RefundDestinationSchema,
  RefundRequestCreateSchema,
} from '../src/domain/refund';

const START = new Date('2026-10-01T00:00:00.000Z');
const DAY = 86_400_000;

describe('refund day math', () => {
  it('counts whole days, floored, from period start', () => {
    expect(daysUsedBetween(START, new Date(START.getTime()))).toBe(0);
    expect(daysUsedBetween(START, new Date(START.getTime() + 3 * DAY + 12 * 3_600_000))).toBe(3);
    expect(daysUsedBetween(START, new Date(START.getTime() + 7 * DAY))).toBe(7);
  });

  it('never counts before the start or past 30 days', () => {
    expect(daysUsedBetween(START, new Date(START.getTime() - DAY))).toBe(0);
    expect(daysUsedBetween(START, new Date(START.getTime() + 45 * DAY))).toBe(30);
  });

  it('keeps the window open through day 7 and closes it after', () => {
    expect(REFUND_WINDOW_DAYS).toBe(7);
    expect(isWithinRefundWindow(START, new Date(START.getTime() + 7 * DAY))).toBe(true);
    expect(isWithinRefundWindow(START, new Date(START.getTime() + 7 * DAY + 1))).toBe(false);
    expect(isWithinRefundWindow(START, new Date(START.getTime() + 8 * DAY))).toBe(false);
  });
});

describe('refund amount math', () => {
  it('refunds in full on day 0', () => {
    expect(computeRefundAmount(4200, 0)).toBe(4200);
  });

  it('deducts days used at paid/30 per day', () => {
    // 4200 / 30 = 140 per day; 3 days used -> 4200 - 420 = 3780.
    expect(computeRefundAmount(4200, 3)).toBe(3780);
  });

  it('rounds PKR to the nearest rupee', () => {
    // 1000 / 30 = 33.33...; 1 day used -> 966.67 -> 967 PKR.
    expect(computeRefundAmount(1000, 1)).toBe(967);
  });

  it('never refunds below zero at the 30-day cap', () => {
    expect(computeRefundAmount(4200, 30)).toBe(0);
  });
});

describe('refund destination validation', () => {
  it('accepts the bank and mobile destinations', () => {
    expect(
      RefundDestinationSchema.safeParse({ type: 'mobile', value: '03001234567' }).success
    ).toBe(true);
    expect(
      RefundDestinationSchema.safeParse({ type: 'bank', value: 'PK00BANK0001' }).success
    ).toBe(true);
    expect(
      RefundDestinationSchema.safeParse({ type: 'binance', value: '983001576' }).success
    ).toBe(true);
  });

  it('rejects an unknown destination type', () => {
    expect(
      RefundDestinationSchema.safeParse({ type: 'wire', value: 'TXabc' }).success
    ).toBe(false);
  });

  it('rejects an empty destination value and an over-long reason', () => {
    expect(
      RefundRequestCreateSchema.safeParse({
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '   ', network: null },
      }).success
    ).toBe(false);
    expect(
      RefundRequestCreateSchema.safeParse({
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
        reason: 'x'.repeat(501),
      }).success
    ).toBe(false);
  });
});
