'use client';

import * as React from 'react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  BillingPaymentItemSchema,
  BillingStatusResponseSchema,
  CryptoCheckoutResponseSchema,
  type BillingStatusResponse,
  type CryptoCheckoutResponse,
  type PlatformCounts,
} from '@/lib/api/schemas/billing';
import {
  daysRemainingBetween,
  quoteUpgrade,
  SUBSCRIPTION_PLATFORMS,
  SUBSCRIPTION_PRICE_PKR_PER_UNIT,
  subscriptionUnitLabel,
  totalPricePkr,
  totalUnits,
  ZERO_PLATFORM_COUNTS,
} from '@fbuploadpro/contracts';
import { BANK_PAYMENT_DETAILS } from '@/lib/billing/payment-details';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { Input } from '@/components/shared/ui/input';
import { BillingStatusMark } from './billing-status-mark';

const PLATFORM_LABELS: Record<keyof PlatformCounts, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function paymentStatusLabel(status: string): string {
  if (status === 'pending') return 'Waiting for approval';
  if (status === 'approved' || status === 'paid') return 'Paid';
  if (status === 'rejected') return 'Rejected';
  if (status === 'failed') return 'Failed';
  return 'Expired';
}

export function BillingView({ subdomain }: Readonly<{ subdomain: string }>) {
  const [status, setStatus] = React.useState<BillingStatusResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [counts, setCounts] = React.useState<PlatformCounts | null>(null);
  const [bankMethod, setBankMethod] = React.useState<'easypaisa' | 'nayapay' | 'ubl'>('easypaisa');
  const [screenshot, setScreenshot] = React.useState<File | null>(null);
  const [cryptoNetwork, setCryptoNetwork] = React.useState<'trc20' | 'bep20'>('trc20');
  const [cryptoResult, setCryptoResult] = React.useState<CryptoCheckoutResponse | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'bank' | 'crypto' | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [formNotice, setFormNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing'), {
        schema: BillingStatusResponseSchema,
      });
      setStatus(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(getErrorMessage(err));
    }
  }, [subdomain]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const entitlement = status?.entitlement ?? null;
  const effectiveCounts = counts ?? entitlement?.counts ?? ZERO_PLATFORM_COUNTS;
  const total = totalPricePkr(effectiveCounts);
  const units = totalUnits(effectiveCounts);

  let quoteError: string | null = null;
  let amountToPay = total;
  if (entitlement?.periodEndsAt) {
    const daysLeft = daysRemainingBetween(new Date(), new Date(entitlement.periodEndsAt));
    try {
      const quote = quoteUpgrade(entitlement.counts, effectiveCounts, daysLeft);
      amountToPay = quote.amountToPayPkr;
    } catch (err) {
      quoteError = err instanceof Error ? err.message : 'That change is not an upgrade.';
    }
  }
  const isUpgrade = Boolean(entitlement?.periodEndsAt) && total > totalPricePkr(entitlement.counts);

  function setCount(platform: keyof PlatformCounts, value: number) {
    const next = { ...effectiveCounts, [platform]: Math.max(0, Math.floor(value) || 0) };
    setCounts(next);
  }

  async function copyText(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  }

  async function submitBank() {
    if (units === 0) {
      setFormError('Choose at least one page or account.');
      return;
    }
    if (quoteError) {
      setFormError(quoteError);
      return;
    }
    if (!screenshot) {
      setFormError('Attach a screenshot of your payment so it can be approved.');
      return;
    }
    setBusy('bank');
    setFormError(null);
    setFormNotice(null);
    try {
      const form = new FormData();
      form.append('counts', JSON.stringify(effectiveCounts));
      form.append('bankMethod', bankMethod);
      form.append('screenshot', screenshot);
      await apiPost(buildTenantApiPath(subdomain, '/billing/payments'), form, {
        schema: BillingPaymentItemSchema,
      });
      setFormNotice('Payment submitted. It will start once an admin approves it, for 30 days from approval.');
      setScreenshot(null);
      await load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function submitCrypto() {
    if (units === 0) {
      setFormError('Choose at least one page or account.');
      return;
    }
    if (quoteError) {
      setFormError(quoteError);
      return;
    }
    setBusy('crypto');
    setFormError(null);
    setFormNotice(null);
    setCryptoResult(null);
    try {
      const result = await apiPost(
        buildTenantApiPath(subdomain, '/billing/payments/crypto'),
        { counts: effectiveCounts, network: cryptoNetwork, isUpgrade },
        { schema: CryptoCheckoutResponseSchema }
      );
      setCryptoResult(result);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (loadError && !status) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load billing</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (!status || !entitlement) {
    return <p className="text-body text-ink-sub">Loading billing…</p>;
  }

  const cryptoAmount = cryptoResult
    ? (cryptoResult.payAmount ?? cryptoResult.estimatedUsdt)
    : null;

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <p className="text-body text-ink-sub">
          Free or Paid. Paid is charged per page or account, per month, at the same price for
          every platform.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <CardDescription>
            {entitlement.active
              ? `Paid until ${formatDate(entitlement.periodEndsAt)}`
              : 'Free plan'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {entitlement.active ? (
            <BillingStatusMark kind="ok" label="Paid and active" />
          ) : (
            <BillingStatusMark kind="failed" label="Not paid — posting paused" />
          )}
          <p className="text-body text-ink-sub">
            Free covers the Prompt Library only. When a paid period ends without renewal, posting
            pauses and the app becomes read-only until you renew.
          </p>
          {entitlement.reason ? (
            <Alert variant="warning">
              <AlertTitle>Posting is paused</AlertTitle>
              <AlertDescription>{entitlement.reason}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1 text-body text-ink-sub">
            <span>
              Used: {SUBSCRIPTION_PLATFORMS.map(
                (platform) => `${entitlement.usage[platform]} ${PLATFORM_LABELS[platform]}`
              ).join(' · ')}
            </span>
            <span>
              Included: {SUBSCRIPTION_PLATFORMS.map(
                (platform) => `${entitlement.counts[platform]} ${PLATFORM_LABELS[platform]}`
              ).join(' · ')}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Build your paid plan</CardTitle>
          <CardDescription>
            Facebook counts pages. Every other platform counts accounts. Price: 70 PKR per page or
            account, per month. Monthly only.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {SUBSCRIPTION_PLATFORMS.map((platform) => (
              <div key={platform} className="flex flex-wrap items-center gap-3 border-t border-line py-2 first:border-t-0 first:pt-0">
                <div className="min-w-40 flex-1">
                  <p className="text-body font-medium text-ink">{PLATFORM_LABELS[platform]}</p>
                  <p className="text-metadata text-ink-sub">
                    {subscriptionUnitLabel(platform)} · {SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR each, per month
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Decrease ${PLATFORM_LABELS[platform]}`}
                    onClick={() => setCount(platform, effectiveCounts[platform] - 1)}
                  >
                    −
                  </Button>
                  <Input
                    type="number"
                    min={0}
                    value={effectiveCounts[platform]}
                    aria-label={`${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)}`}
                    className="w-20 text-center"
                    onChange={(event) => setCount(platform, Number(event.target.value))}
                  />
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Increase ${PLATFORM_LABELS[platform]}`}
                    onClick={() => setCount(platform, effectiveCounts[platform] + 1)}
                  >
                    +
                  </Button>
                </div>
                <span className="w-24 text-right text-body text-ink-sub">
                  {effectiveCounts[platform] * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-primary px-4 py-3">
            <span className="text-body font-semibold text-on-primary">
              {units} pages / accounts selected
            </span>
            <span className="text-body font-semibold text-on-primary">
              {isUpgrade ? `${amountToPay} PKR to upgrade` : `${total} PKR / month`}
            </span>
          </div>
          <Alert>
            <AlertTitle>How the limit works</AlertTitle>
            <AlertDescription>
              The count is across the whole platform group, not per feature. For example, 5
              Facebook pages means 5 pages in total across in-app schedule, auto download-upload,
              auto repost, and any other Facebook feature — not 5 in each. Connecting an account
              or page does not count. Using it inside a feature does.
            </AlertDescription>
          </Alert>
          {quoteError ? (
            <Alert variant="destructive">
              <AlertTitle>That change is not an upgrade</AlertTitle>
              <AlertDescription>{quoteError}</AlertDescription>
            </Alert>
          ) : null}
          {isUpgrade ? (
            <p className="text-body text-ink-sub">
              Upgrade only: your remaining days on the current plan count as credit, and the new
              period starts from the upgrade approval. Example: 10 pages to 20 pages with 10 days
              left — credit 233 PKR, pay 1,167 PKR.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pay by bank or mobile wallet</CardTitle>
          <CardDescription>
            Pay the total above, upload a screenshot of your payment, and submit it for approval.
            Approval lasts 30 days from approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Payment method">
            {(['easypaisa', 'nayapay', 'ubl'] as const).map((method) => (
              <Button
                key={method}
                variant={bankMethod === method ? 'default' : 'outline'}
                onClick={() => setBankMethod(method)}
              >
                {BANK_PAYMENT_DETAILS[method].label}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-1 text-body text-ink">
            <span className="font-medium">{BANK_PAYMENT_DETAILS[bankMethod].label}</span>
            {BANK_PAYMENT_DETAILS[bankMethod].bank ? (
              <span>Bank: {BANK_PAYMENT_DETAILS[bankMethod].bank}</span>
            ) : null}
            {BANK_PAYMENT_DETAILS[bankMethod].holder ? (
              <span>Account holder: {BANK_PAYMENT_DETAILS[bankMethod].holder}</span>
            ) : null}
            <span className="flex flex-wrap items-center gap-2">
              Account number: {BANK_PAYMENT_DETAILS[bankMethod].accountNumber}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void copyText(
                    BANK_PAYMENT_DETAILS[bankMethod].accountNumber,
                    `account-${bankMethod}`
                  )
                }
              >
                {copied === `account-${bankMethod}` ? 'Copied' : 'Copy number'}
              </Button>
            </span>
            {BANK_PAYMENT_DETAILS[bankMethod].iban ? (
              <span className="flex flex-wrap items-center gap-2">
                IBAN: {BANK_PAYMENT_DETAILS[bankMethod].iban}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void copyText(BANK_PAYMENT_DETAILS[bankMethod].iban ?? '', `iban-${bankMethod}`)
                  }
                >
                  {copied === `iban-${bankMethod}` ? 'Copied' : 'Copy IBAN'}
                </Button>
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="billing-screenshot" className="text-body font-medium text-ink">
              Payment screenshot
            </label>
            <Input
              id="billing-screenshot"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => setScreenshot(event.target.files?.[0] ?? null)}
            />
            {screenshot ? (
              <p className="text-metadata text-ink-sub">{screenshot.name}</p>
            ) : null}
          </div>
          <div>
            <Button onClick={() => void submitBank()} loading={busy === 'bank'} disabled={busy !== null}>
              Submit payment for approval
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pay with crypto</CardTitle>
          <CardDescription>
            USDT via NOWPayments, on TRC20 or BEP20. The USDT amount is the equivalent of your PKR
            total at checkout.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Crypto network">
            <Button
              variant={cryptoNetwork === 'trc20' ? 'default' : 'outline'}
              onClick={() => setCryptoNetwork('trc20')}
            >
              TRC20
            </Button>
            <Button
              variant={cryptoNetwork === 'bep20' ? 'default' : 'outline'}
              onClick={() => setCryptoNetwork('bep20')}
            >
              BEP20
            </Button>
          </div>
          <div>
            <Button
              variant="outline"
              onClick={() => void submitCrypto()}
              loading={busy === 'crypto'}
              disabled={busy !== null}
            >
              Continue with NOWPayments
            </Button>
          </div>
          {cryptoResult && cryptoAmount !== null ? (
            <Alert variant="success">
              <AlertTitle>Send exactly {cryptoAmount} USDT</AlertTitle>
              <AlertDescription>
                <span className="block break-all">To: {cryptoResult.payAddress}</span>
                <span className="block">
                  Network: {cryptoResult.network === 'trc20' ? 'TRC20' : 'BEP20'} · Your paid
                  period starts automatically once NOWPayments confirms the payment.
                </span>
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {formError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t complete that</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      {formNotice ? (
        <Alert variant="success">
          <AlertTitle>Submitted</AlertTitle>
          <AlertDescription>{formNotice}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Your payments</CardTitle>
          <CardDescription>Bank payments wait for approval. Crypto payments activate on payment.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {status.payments.length === 0 ? (
            <p className="text-body text-ink-sub">No payments yet.</p>
          ) : null}
          {status.payments.map((payment) => (
            <div
              key={payment.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-col gap-1">
                <span className="text-body font-medium text-ink">
                  {payment.amountPkr} PKR ·{' '}
                  {payment.method === 'bank'
                    ? (payment.bankMethod === 'easypaisa'
                        ? 'Easypaisa'
                        : payment.bankMethod === 'nayapay'
                          ? 'Nayapay'
                          : 'UBL bank')
                    : `Crypto (${payment.nowpaymentsNetwork === 'trc20' ? 'TRC20' : 'BEP20'})`}
                  {payment.isUpgrade ? ' · Upgrade' : ''}
                </span>
                <span className="text-metadata text-ink-sub">{formatDate(payment.createdAt)}</span>
              </div>
              {payment.status === 'approved' || payment.status === 'paid' ? (
                <BillingStatusMark kind="ok" label={paymentStatusLabel(payment.status)} />
              ) : payment.status === 'rejected' || payment.status === 'failed' || payment.status === 'expired' ? (
                <BillingStatusMark kind="failed" label={paymentStatusLabel(payment.status)} />
              ) : (
                <span className="text-metadata text-ink-sub">Waiting for approval</span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
