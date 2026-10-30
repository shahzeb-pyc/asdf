import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  canUseDestination,
  daysRemainingBetween,
  isPeriodActive,
  nowPaymentsPayCurrency,
  quoteUpgrade,
  sortObjectForNowPaymentsSignature,
  totalPricePkr,
  upgradeCreditPkr,
  verifyNowPaymentsIpnSignature,
  ZERO_PLATFORM_COUNTS,
  type PlatformCounts,
} from '../src/domain/subscription.js';

function counts(partial: Partial<PlatformCounts>): PlatformCounts {
  return { ...ZERO_PLATFORM_COUNTS, ...partial };
}

describe('subscription pricing', () => {
  it('charges 70 PKR per page/account on every platform', () => {
    expect(totalPricePkr(counts({ facebook: 5, instagram: 3 }))).toBe(560);
    expect(totalPricePkr(counts({ facebook: 1 }))).toBe(70);
    expect(totalPricePkr(ZERO_PLATFORM_COUNTS)).toBe(0);
  });

  it('maps Facebook to pages and other platforms to accounts via the network tickers', () => {
    expect(nowPaymentsPayCurrency('trc20')).toBe('usdttrc20');
    expect(nowPaymentsPayCurrency('bep20')).toBe('usdtbsc');
  });
});

describe('upgrade credit (owner example)', () => {
  it('10 pages, 10 days left, upgrading to 20 pages: credit 233, pay 1167', () => {
    const quote = quoteUpgrade(counts({ facebook: 10 }), counts({ facebook: 20 }), 10);
    expect(quote.oldMonthlyTotalPkr).toBe(700);
    expect(quote.newMonthlyTotalPkr).toBe(1400);
    expect(quote.creditPkr).toBe(233);
    expect(quote.amountToPayPkr).toBe(1167);
  });

  it('rounds credit to the nearest whole PKR', () => {
    expect(upgradeCreditPkr(700, 10)).toBe(233);
    expect(upgradeCreditPkr(70, 15)).toBe(35);
    expect(upgradeCreditPkr(700, 0)).toBe(0);
  });

  it('rejects a downgrade, a same-total change, and a per-platform decrease', () => {
    expect(() =>
      quoteUpgrade(counts({ facebook: 20 }), counts({ facebook: 10 }), 10)
    ).toThrow();
    expect(() =>
      quoteUpgrade(counts({ facebook: 10 }), counts({ facebook: 10 }), 10)
    ).toThrow();
    expect(() =>
      quoteUpgrade(
        counts({ facebook: 10, instagram: 5 }),
        counts({ facebook: 20, instagram: 1 }),
        10
      )
    ).toThrow();
    expect(() => quoteUpgrade(counts({ facebook: 10 }), ZERO_PLATFORM_COUNTS, 10)).toThrow();
  });

  it('counts any part of a day as a day remaining, and zero once ended', () => {
    const now = new Date('2026-10-30T00:00:00.000Z');
    expect(daysRemainingBetween(now, new Date('2026-11-09T00:00:00.000Z'))).toBe(10);
    expect(daysRemainingBetween(now, new Date('2026-11-09T00:00:01.000Z'))).toBe(11);
    expect(daysRemainingBetween(now, new Date('2026-10-29T00:00:00.000Z'))).toBe(0);
  });
});

describe('period activity and lapse', () => {
  it('is active inside the window, inactive after the end and when superseded', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const base = {
      startsAt: new Date('2026-10-01T00:00:00.000Z'),
      endsAt: new Date('2026-10-31T00:00:00.000Z'),
      supersededAt: null as Date | null,
    };
    expect(isPeriodActive(base, now)).toBe(true);
    expect(isPeriodActive(base, new Date('2026-11-01T00:00:00.000Z'))).toBe(false);
    expect(isPeriodActive(base, new Date('2026-09-30T00:00:00.000Z'))).toBe(false);
    expect(
      isPeriodActive({ ...base, supersededAt: new Date('2026-10-15T00:00:00.000Z') }, now)
    ).toBe(false);
  });
});

describe('cap counting across features', () => {
  it('counts the same destination once, even across a second feature', () => {
    const used = ['fb-page-1', 'fb-page-2'];
    expect(canUseDestination(used, 'fb-page-1', 2)).toBe(true);
    expect(canUseDestination(used, 'fb-page-3', 2)).toBe(false);
    expect(canUseDestination(used, 'fb-page-3', 5)).toBe(true);
  });

  it('blocks a 6th distinct destination over a 5 cap', () => {
    const used = ['p1', 'p2', 'p3', 'p4', 'p5'];
    expect(canUseDestination(used, 'p6', 5)).toBe(false);
    expect(canUseDestination(used, 'p5', 5)).toBe(true);
  });

  it('blocks everything for a free user with a zero cap', () => {
    expect(canUseDestination([], 'anything', 0)).toBe(false);
  });
});

describe('NOWPayments IPN signature', () => {
  it('verifies a signature computed independently with node crypto', async () => {
    const payload = {
      payment_id: '123',
      payment_status: 'finished',
      price_amount: 560,
      nested: { b: 2, a: 1 },
    };
    const secret = 'test-ipn-secret';
    const sorted = JSON.stringify(sortObjectForNowPaymentsSignature(payload));
    const expected = createHmac('sha512', secret).update(sorted).digest('hex');
    expect(await verifyNowPaymentsIpnSignature(payload, expected, secret)).toBe(true);
    expect(await verifyNowPaymentsIpnSignature(payload, expected, 'wrong-secret')).toBe(false);
    expect(
      await verifyNowPaymentsIpnSignature({ ...payload, payment_status: 'waiting' }, expected, secret)
    ).toBe(false);
    expect(await verifyNowPaymentsIpnSignature(payload, null, secret)).toBe(false);
    expect(await verifyNowPaymentsIpnSignature(payload, expected, null)).toBe(false);
  });

  it('sorts keys recursively before signing', () => {
    expect(sortObjectForNowPaymentsSignature({ b: 1, a: { d: 4, c: 3 } })).toEqual({
      a: { c: 3, d: 4 },
      b: 1,
    });
  });
});
