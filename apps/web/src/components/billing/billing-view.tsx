'use client';

import * as React from 'react';
import { ClockIcon, UploadIcon, XIcon } from 'lucide-react';
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
  type UpgradeQuote,
} from '@fbuploadpro/contracts';
import { BANK_PAYMENT_DETAILS } from '@/lib/billing/payment-details';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Input } from '@/components/shared/ui/input';
import { Skeleton } from '@/components/shared/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/shared/ui/table';
import { BillingStatusMark } from './billing-status-mark';

const PLATFORM_LABELS: Record<keyof PlatformCounts, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

type BankMethod = 'easypaisa' | 'nayapay' | 'ubl';

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

function BillingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-6">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-4 pt-6">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function BillingView({ subdomain }: Readonly<{ subdomain: string }>) {
  const [status, setStatus] = React.useState<BillingStatusResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [counts, setCounts] = React.useState<PlatformCounts | null>(null);
  const [bankMethod, setBankMethod] = React.useState<BankMethod>('easypaisa');
  const [screenshot, setScreenshot] = React.useState<File | null>(null);
  const [cryptoNetwork, setCryptoNetwork] = React.useState<'trc20' | 'bep20'>('trc20');
  const [cryptoResult, setCryptoResult] = React.useState<CryptoCheckoutResponse | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'bank' | 'crypto' | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [formNotice, setFormNotice] = React.useState<string | null>(null);
  const screenshotInputRef = React.useRef<HTMLInputElement | null>(null);

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

  async function handleRetry() {
    setReloading(true);
    try {
      await load();
    } finally {
      setReloading(false);
    }
  }

  const entitlement = status?.entitlement ?? null;
  const effectiveCounts = counts ?? entitlement?.counts ?? ZERO_PLATFORM_COUNTS;
  const total = totalPricePkr(effectiveCounts);
  const units = totalUnits(effectiveCounts);

  let quoteError: string | null = null;
  let amountToPay = total;
  let quote: UpgradeQuote | null = null;
  if (entitlement?.periodEndsAt) {
    const daysLeft = daysRemainingBetween(new Date(), new Date(entitlement.periodEndsAt));
    try {
      quote = quoteUpgrade(entitlement.counts, effectiveCounts, daysLeft);
      amountToPay = quote.amountToPayPkr;
    } catch (err) {
      quoteError = err instanceof Error ? err.message : 'That change is not an upgrade.';
    }
  }
  const isUpgrade = Boolean(
    entitlement && entitlement.periodEndsAt && total > totalPricePkr(entitlement.counts)
  );

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
      setFormNotice('Payment submitted. It starts once approved, for 30 days from approval.');
      setScreenshot(null);
      if (screenshotInputRef.current) screenshotInputRef.current.value = '';
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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load billing</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!status || !entitlement) {
    return <BillingSkeleton />;
  }

  const cryptoAmount = cryptoResult
    ? (cryptoResult.payAmount ?? cryptoResult.estimatedUsdt)
    : null;
  const details = BANK_PAYMENT_DETAILS[bankMethod];
  const includedUnits = totalUnits(entitlement.counts);
  const usedUnits = totalUnits(entitlement.usage);
  const summaryAmount = isUpgrade ? amountToPay : total;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <p className="text-body text-ink-sub">
          70 PKR per page or account, per month. Facebook counts pages; every other platform
          counts accounts.
        </p>
      </div>

      {/* Sticky total: always visible while choosing counts, compact on phone. */}
      <div className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-3 border-b border-line bg-canvas px-4 py-3 sm:-mx-6 sm:px-6">
        <p className="min-w-0 text-body font-semibold text-ink">
          <span className="tabular-nums">{units} selected</span>
          <span className="text-ink-sub"> · </span>
          <span className="tabular-nums">{summaryAmount} PKR{isUpgrade ? ' to upgrade' : ' / month'}</span>
        </p>
        <Button variant="outline" size="sm" asChild>
          <a href="#billing-payment">Review payment</a>
        </Button>
      </div>

      {/* Plan hero: what am I on, when does it end, what do I have. */}
      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <CardDescription>
            {entitlement.active
              ? `Paid until ${formatDate(entitlement.periodEndsAt)}`
              : 'Free plan — Prompt Library only'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1">
              <span className="text-metadata text-ink-sub">Plan</span>
              {entitlement.active ? (
                <BillingStatusMark kind="ok" label="Paid and active" />
              ) : (
                <BillingStatusMark kind="failed" label="Not paid" />
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-metadata text-ink-sub">Paid until</span>
              <span className="text-body font-medium text-ink">
                {formatDate(entitlement.periodEndsAt)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-metadata text-ink-sub">Included</span>
              <span className="text-body font-medium tabular-nums text-ink">
                {includedUnits} pages / accounts
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-metadata text-ink-sub">Used in features</span>
              <span className="text-body font-medium tabular-nums text-ink">
                {usedUnits} pages / accounts
              </span>
            </div>
          </div>
          {entitlement.reason ? (
            <Alert variant="warning">
              <AlertTitle>Posting is paused</AlertTitle>
              <AlertDescription>{entitlement.reason}</AlertDescription>
            </Alert>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Platform</TableHead>
                <TableHead className="text-right">Included</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead className="text-right">Left</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SUBSCRIPTION_PLATFORMS.map((platform) => (
                <TableRow key={platform}>
                  <TableCell className="font-medium">{PLATFORM_LABELS[platform]}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entitlement.counts[platform]} {subscriptionUnitLabel(platform)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entitlement.usage[platform]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Math.max(0, entitlement.counts[platform] - entitlement.usage[platform])}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-body text-ink-sub">
            Free covers the Prompt Library only. When a paid period ends without renewal, posting
            pauses and the app becomes read-only until you renew.
          </p>
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* Plan builder */}
          <Card>
            <CardHeader>
              <CardTitle>Build your paid plan</CardTitle>
              <CardDescription>
                Choose how many pages or accounts to manage, per platform. Monthly only.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col">
                {SUBSCRIPTION_PLATFORMS.map((platform) => (
                  <div
                    key={platform}
                    className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0 first:pt-0"
                  >
                    <div className="min-w-44 flex-1">
                      <p className="text-body font-medium text-ink">{PLATFORM_LABELS[platform]}</p>
                      <p className="text-metadata text-ink-sub">
                        {subscriptionUnitLabel(platform)} · 70 PKR each, per month · Included{' '}
                        {entitlement.counts[platform]}, used {entitlement.usage[platform]}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`Decrease ${PLATFORM_LABELS[platform]}`}
                        onClick={() => setCount(platform, effectiveCounts[platform] - 1)}
                        disabled={effectiveCounts[platform] <= 0}
                      >
                        −
                      </Button>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={effectiveCounts[platform]}
                        aria-label={`${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)}`}
                        className="w-16 text-center tabular-nums"
                        onChange={(event) => setCount(platform, Number(event.target.value))}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`Increase ${PLATFORM_LABELS[platform]}`}
                        onClick={() => setCount(platform, effectiveCounts[platform] + 1)}
                      >
                        +
                      </Button>
                    </div>
                    <span className="w-full text-body text-ink-sub tabular-nums sm:w-24 sm:text-right">
                      {effectiveCounts[platform] * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
                    </span>
                  </div>
                ))}
              </div>
              {quoteError ? (
                <Alert variant="destructive">
                  <AlertTitle>That change is not an upgrade</AlertTitle>
                  <AlertDescription>{quoteError}</AlertDescription>
                </Alert>
              ) : null}
              <p className="text-body text-ink-sub">
                Your count covers a whole platform, not each feature. Example: 5 Facebook pages
                means 5 in total across in-app schedule, auto download-upload and auto repost —
                not 5 in each. Connecting accounts is unlimited; using one in a feature counts.
              </p>
            </CardContent>
          </Card>

          {/* Checkout */}
          <Card id="billing-payment" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>Pay for this plan</CardTitle>
              <CardDescription>
                {isUpgrade
                  ? `${amountToPay} PKR to upgrade`
                  : `${total} PKR / month`}
                {quote?.daysRemaining ? ` · ${quote.daysRemaining} days left on your current plan` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <section aria-label="Pay by bank or mobile wallet" className="flex flex-col gap-4">
                <h3 className="text-body font-semibold text-ink">Bank or mobile wallet</h3>
                <div role="radiogroup" aria-label="Payment method" className="grid gap-2 sm:grid-cols-3">
                  {(['easypaisa', 'nayapay', 'ubl'] as const).map((method) => {
                    const selected = bankMethod === method;
                    return (
                      <button
                        key={method}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setBankMethod(method)}
                        className={cn(
                          'rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
                          selected
                            ? 'border-primary bg-primary/10'
                            : 'border-line bg-panel hover:bg-hover'
                        )}
                      >
                        <span className="block text-body font-medium text-ink">
                          {BANK_PAYMENT_DETAILS[method].label}
                        </span>
                        <span className="block text-metadata text-ink-sub">
                          {BANK_PAYMENT_DETAILS[method].accountNumber}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <dt className="text-metadata text-ink-sub">Account number</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-body text-ink">{details.accountNumber}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void copyText(details.accountNumber, `account-${bankMethod}`)}
                      >
                        {copied === `account-${bankMethod}` ? 'Copied' : 'Copy number'}
                      </Button>
                    </dd>
                  </div>
                  {details.iban ? (
                    <div className="flex flex-col gap-1">
                      <dt className="text-metadata text-ink-sub">IBAN</dt>
                      <dd className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-body text-ink">{details.iban}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void copyText(details.iban ?? '', `iban-${bankMethod}`)}
                        >
                          {copied === `iban-${bankMethod}` ? 'Copied' : 'Copy IBAN'}
                        </Button>
                      </dd>
                    </div>
                  ) : null}
                  {details.holder ? (
                    <div className="flex flex-col gap-1">
                      <dt className="text-metadata text-ink-sub">Account holder</dt>
                      <dd className="text-body text-ink">{details.holder}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="flex flex-col gap-2">
                  <span className="text-body font-medium text-ink">Payment screenshot</span>
                  <input
                    ref={screenshotInputRef}
                    id="billing-screenshot"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="sr-only"
                    onChange={(event) => setScreenshot(event.target.files?.[0] ?? null)}
                  />
                  {screenshot ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-panel px-4 py-3">
                      <span className="flex min-w-0 items-center gap-2 text-body text-ink">
                        <UploadIcon aria-hidden className="size-4 shrink-0 text-ink-sub" />
                        <span className="truncate">{screenshot.name}</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setScreenshot(null);
                          if (screenshotInputRef.current) screenshotInputRef.current.value = '';
                        }}
                      >
                        <XIcon aria-hidden className="size-4" /> Remove
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => screenshotInputRef.current?.click()}
                      className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line bg-panel px-4 py-6 text-center transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                    >
                      <UploadIcon aria-hidden className="size-5 text-ink-sub" />
                      <span className="text-body font-medium text-ink">
                        Upload your payment screenshot
                      </span>
                      <span className="text-metadata text-ink-sub">
                        PNG, JPG, WebP or GIF, up to 10 MB
                      </span>
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <Button
                    onClick={() => void submitBank()}
                    loading={busy === 'bank'}
                    disabled={busy !== null || units === 0 || !screenshot || Boolean(quoteError)}
                  >
                    Submit payment for approval
                  </Button>
                  {units === 0 ? (
                    <p className="text-metadata text-ink-sub">Choose at least one page or account first.</p>
                  ) : !screenshot ? (
                    <p className="text-metadata text-ink-sub">
                      Attach a screenshot so your payment can be approved.
                    </p>
                  ) : null}
                  <p className="text-metadata text-ink-sub">
                    Approval lasts 30 days from approval.
                  </p>
                </div>
              </section>

              <div aria-hidden="true" className="h-px bg-line" />

              <section aria-label="Pay with crypto" className="flex flex-col gap-4">
                <h3 className="text-body font-semibold text-ink">Crypto</h3>
                <p className="text-body text-ink-sub">
                  USDT via NOWPayments, on TRC20 or BEP20. You pay the USDT equivalent of{' '}
                  {isUpgrade ? amountToPay : total} PKR at checkout.
                </p>
                <div role="radiogroup" aria-label="Crypto network" className="grid gap-2 sm:grid-cols-2">
                  {(['trc20', 'bep20'] as const).map((network) => {
                    const selected = cryptoNetwork === network;
                    return (
                      <button
                        key={network}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setCryptoNetwork(network)}
                        className={cn(
                          'rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
                          selected
                            ? 'border-primary bg-primary/10'
                            : 'border-line bg-panel hover:bg-hover'
                        )}
                      >
                        <span className="block text-body font-medium text-ink">
                          {network === 'trc20' ? 'TRC20' : 'BEP20'}
                        </span>
                        <span className="block text-metadata text-ink-sub">USDT</span>
                      </button>
                    );
                  })}
                </div>
                <div>
                  <Button
                    variant="outline"
                    onClick={() => void submitCrypto()}
                    loading={busy === 'crypto'}
                    disabled={busy !== null || units === 0 || Boolean(quoteError)}
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
                        Network: {cryptoResult.network === 'trc20' ? 'TRC20' : 'BEP20'} · Your
                        paid period starts automatically once NOWPayments confirms the payment.
                      </span>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </section>

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
            </CardContent>
          </Card>

          {/* Payments history */}
          <Card>
            <CardHeader>
              <CardTitle>Your payments</CardTitle>
              <CardDescription>
                Bank payments wait for approval. Crypto payments activate on payment.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {status.payments.length === 0 ? (
                <EmptyState
                  type="first-use"
                  title="No payments yet"
                  description="Payments you submit will appear here, with their approval status."
                  action={
                    <Button variant="outline" asChild>
                      <a href="#billing-payment">Make a payment</a>
                    </Button>
                  }
                />
              ) : null}
              {status.payments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0 first:pt-0"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-body font-medium tabular-nums text-ink">
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
                    <BillingStatusMark kind="pending" label="Waiting for approval" />
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Sticky summary: desktop only in layout, compact card on phone above is the sticky strip. */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>What you will pay for this plan.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <dl className="flex flex-col gap-2 text-body">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-sub">Selected</dt>
                  <dd className="font-medium tabular-nums text-ink">{units} pages / accounts</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-sub">Monthly total</dt>
                  <dd className="font-medium tabular-nums text-ink">{total} PKR</dd>
                </div>
                {isUpgrade && quote ? (
                  <>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-sub">Credit · {quote.daysRemaining} days left</dt>
                      <dd className="font-medium tabular-nums text-ink">−{quote.creditPkr} PKR</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                      <dt className="font-medium text-ink">You pay to upgrade</dt>
                      <dd className="font-semibold tabular-nums text-ink">{amountToPay} PKR</dd>
                    </div>
                  </>
                ) : (
                  <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                    <dt className="font-medium text-ink">You pay</dt>
                    <dd className="font-semibold tabular-nums text-ink">{total} PKR / month</dd>
                  </div>
                )}
              </dl>
              {isUpgrade ? (
                <p className="text-body text-ink-sub">
                  Upgrades only. Example: 10 pages to 20 pages with 10 days left — credit 233 PKR,
                  pay 1,167 PKR. Your new period starts from the upgrade approval.
                </p>
              ) : (
                <p className="text-body text-ink-sub">
                  Approval lasts 30 days from approval. When a period ends without renewal,
                  posting pauses and the app becomes read-only.
                </p>
              )}
              <Button variant="outline" asChild>
                <a href="#billing-payment">Go to payment</a>
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
