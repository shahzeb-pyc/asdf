import { nowPaymentsPayCurrency } from '@fbuploadpro/contracts';

/**
 * Method-only verification, for failed/expired notifications: a
 * failed event legitimately arrives with nothing paid, so only the
 * payment-method match is enforced there.
 */
export function verifyIpnMethodOnly(
  payment: { method: string }
): { ok: true } | { ok: false; reason: 'amount_mismatch'; detail: string } {
  if (payment.method !== 'nowpayments') {
    return {
      ok: false,
      reason: 'amount_mismatch',
      detail: 'This notification names a payment that is not a crypto payment, so it cannot settle it.',
    };
  }
  return { ok: true };
}

/**
 * Verify a money-moving IPN against the payment it claims to settle.
 * Method: the payment must be a crypto payment — an order_id that
 * happens to match a bank row must never activate it. Currency:
 * the notification's pay_currency must be the network's USDT
 * ticker. Amount: what actually arrived (actually_paid, falling
 * back to pay_amount) must be present and at least the checkout
 * pay amount — overpayment is fine, underpayment is held for an
 * admin, never auto-activated. A payment without a recorded pay
 * amount cannot be verified and is held, never assumed.
 */
export function verifyIpnAgainstPayment(
  payment: {
    method: string;
    nowpaymentsNetwork: 'trc20' | 'bep20' | null;
    nowpaymentsPayAmount: number | null;
  },
  payload: {
    pay_currency?: string | undefined;
    pay_amount?: number | undefined;
    actually_paid?: number | undefined;
  }
): { ok: true } | { ok: false; reason: 'currency_mismatch' | 'amount_mismatch' | 'underpaid'; detail: string } {
  if (payment.method !== 'nowpayments') {
    return {
      ok: false,
      reason: 'amount_mismatch',
      detail: 'This notification names a payment that is not a crypto payment, so it cannot settle it.',
    };
  }
  if (payment.nowpaymentsNetwork) {
    const expectedCurrency = nowPaymentsPayCurrency(payment.nowpaymentsNetwork);
    if (payload.pay_currency !== expectedCurrency) {
      return {
        ok: false,
        reason: 'currency_mismatch',
        detail:
          typeof payload.pay_currency === 'string'
            ? `The notification arrived in ${payload.pay_currency}, but this payment was created for ${expectedCurrency}.`
            : `The notification carries no currency, but this payment was created for ${expectedCurrency}.`,
      };
    }
  }
  const arrived = typeof payload.actually_paid === 'number' ? payload.actually_paid : payload.pay_amount;
  if (typeof arrived !== 'number' || payment.nowpaymentsPayAmount === null) {
    return {
      ok: false,
      reason: 'amount_mismatch',
      detail: 'The notification carries no usable amount to verify against this payment.',
    };
  }
  if (arrived < payment.nowpaymentsPayAmount) {
    return {
      ok: false,
      reason: 'underpaid',
      detail: `Only ${arrived} USDT arrived, but this payment needs ${payment.nowpaymentsPayAmount} USDT.`,
    };
  }
  return { ok: true };
}
