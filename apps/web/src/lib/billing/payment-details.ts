/**
 * Payment-destination details shown on the Billing page.
 *
 * These are NOT secrets: they are the accounts customers pay INTO,
 * and the same details were shown publicly in the old app's
 * add-tokens dialogue. They are configurable display data, kept
 * here (not in Doppler, not in code as credentials) so the Billing
 * page can render them without any secret plumbing.
 */
export interface BankPaymentDetails {
  label: string;
  accountNumber: string;
  /** Label for the destination value; defaults to 'Account number'. */
  accountNumberLabel?: string | undefined;
  bank?: string | undefined;
  iban?: string | undefined;
  holder?: string | undefined;
}

/**
 * Binance ID and holder are verbatim from the old app's add-tokens
 * dialogue (webapp/src/app/(dashboard)/agency/add-tokens-dialog.tsx:
 * binanceDetails id "983001576", name "Shahzebpyc") — the same
 * source as the Easypaisa/Nayapay/UBL details above.
 */
export const BANK_PAYMENT_DETAILS: Record<
  'easypaisa' | 'nayapay' | 'ubl' | 'binance',
  BankPaymentDetails
> = {
  easypaisa: { label: 'Easypaisa', accountNumber: '03278644204' },
  nayapay: { label: 'Nayapay', accountNumber: '03278644204' },
  ubl: {
    label: 'UBL bank',
    bank: 'UBL',
    accountNumber: '313590315',
    iban: 'PK77UNIL0109000313590315',
    holder: 'SHAH ZAIB MALIK',
  },
  binance: {
    label: 'Binance',
    accountNumber: '983001576',
    accountNumberLabel: 'Binance ID',
    holder: 'Shahzebpyc',
  },
};
