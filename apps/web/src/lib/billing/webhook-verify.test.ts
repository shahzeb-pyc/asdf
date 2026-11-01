import { describe, it, expect } from 'vitest';
import {
  verifyIpnAgainstPayment,
  verifyIpnMethodOnly,
} from './webhook-verify';

/**
 * Crypto webhook verification (audit fix 2026-11-01, fix 6).
 * Method is verified for every money status; currency + amount
 * gate activation only (a failed event legitimately arrives with
 * nothing paid, so amount checks would wrongly hold every genuine
 * failure — those use the method-only check).
 */
const CRYPTO_TRC20 = {
  method: 'nowpayments',
  nowpaymentsNetwork: 'trc20' as const,
  nowpaymentsPayAmount: 10,
};

describe('verifyIpnAgainstPayment', () => {
  it('accepts exact payment and overpayment', () => {
    expect(
      verifyIpnAgainstPayment(CRYPTO_TRC20, { pay_currency: 'usdttrc20', actually_paid: 10 })
    ).toEqual({ ok: true });
    expect(
      verifyIpnAgainstPayment(CRYPTO_TRC20, { pay_currency: 'usdttrc20', actually_paid: 12.5 })
    ).toEqual({ ok: true });
  });

  it('falls back to pay_amount when actually_paid is absent', () => {
    expect(
      verifyIpnAgainstPayment(CRYPTO_TRC20, { pay_currency: 'usdttrc20', pay_amount: 10 })
    ).toEqual({ ok: true });
  });

  it('prefers actually_paid over pay_amount', () => {
    // Quoted 10, actually arrived 9: held even though pay_amount says 10.
    const result = verifyIpnAgainstPayment(CRYPTO_TRC20, {
      pay_currency: 'usdttrc20',
      pay_amount: 10,
      actually_paid: 9,
    });
    expect(result).toMatchObject({ ok: false, reason: 'underpaid' });
  });

  it('rejects a currency mismatch, including a missing currency', () => {
    expect(
      verifyIpnAgainstPayment(CRYPTO_TRC20, { pay_currency: 'usdtbsc', actually_paid: 10 })
    ).toMatchObject({ ok: false, reason: 'currency_mismatch' });
    expect(verifyIpnAgainstPayment(CRYPTO_TRC20, { actually_paid: 10 })).toMatchObject({
      ok: false,
      reason: 'currency_mismatch',
    });
  });

  it('holds underpayment and missing amounts instead of activating', () => {
    expect(
      verifyIpnAgainstPayment(CRYPTO_TRC20, { pay_currency: 'usdttrc20', actually_paid: 9.99 })
    ).toMatchObject({ ok: false, reason: 'underpaid' });
    expect(verifyIpnAgainstPayment(CRYPTO_TRC20, { pay_currency: 'usdttrc20' })).toMatchObject({
      ok: false,
      reason: 'amount_mismatch',
    });
    expect(
      verifyIpnAgainstPayment(
        { ...CRYPTO_TRC20, nowpaymentsPayAmount: null },
        { pay_currency: 'usdttrc20', actually_paid: 10 }
      )
    ).toMatchObject({ ok: false, reason: 'amount_mismatch' });
  });

  it('rejects a bank payment outright, whatever the IPN claims', () => {
    expect(
      verifyIpnAgainstPayment(
        { method: 'bank', nowpaymentsNetwork: null, nowpaymentsPayAmount: null },
        { pay_currency: 'usdttrc20', actually_paid: 10 }
      )
    ).toMatchObject({ ok: false, reason: 'amount_mismatch' });
  });

  it('skips the currency check when the payment has no recorded network', () => {
    expect(
      verifyIpnAgainstPayment(
        { method: 'nowpayments', nowpaymentsNetwork: null, nowpaymentsPayAmount: 10 },
        { pay_currency: 'usdtbsc', actually_paid: 10 }
      )
    ).toEqual({ ok: true });
  });
});

describe('verifyIpnMethodOnly', () => {
  it('passes crypto payments and rejects bank payments', () => {
    expect(verifyIpnMethodOnly({ method: 'nowpayments' })).toEqual({ ok: true });
    expect(verifyIpnMethodOnly({ method: 'bank' })).toMatchObject({
      ok: false,
      reason: 'amount_mismatch',
    });
  });
});
