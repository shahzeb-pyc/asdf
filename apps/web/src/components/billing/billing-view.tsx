'use client';

import * as React from 'react';
import { ArrowLeftIcon, CheckIcon, UploadIcon, XIcon } from 'lucide-react';
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
type Step = 'plans' | 'checkout' | 'confirmation';
type PaymentType = 'bank' | 'crypto';

interface ConfirmationData {
  kind: 'bank' | 'crypto';
  amountPkr: number;
  counts: PlatformCounts;
  isUpgrade: boolean;
  crypto: CryptoCheckoutResponse | null;
}

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

function countsSummary(counts: PlatformCounts): string {
  const parts = SUBSCRIPTION_PLATFORMS.filter((p) => counts[p] > 0).map(
    (p) => `${counts[p]} ${PLATFORM_LABELS[p]} ${subscriptionUnitLabel(p)}`
  );
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts';
}

function BillingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <div className="grid items-start gap-6 md:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function MethodCard({
  selected,
  title,
  description,
  onClick,
  label,
}: Readonly<{
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
  label: string;
}>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
        selected ? 'border-primary bg-primary/10' : 'border-line bg-panel hover:bg-hover'
      )}
    >
      <span className="block text-body font-medium text-ink">{title}</span>
      <span className="block text-metadata text-ink-sub">{description}</span>
    </button>
  );
}

export function BillingView({ subdomain }: Readonly<{ subdomain: string }>) {
  const [status, setStatus] = React.useState<BillingStatusResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [counts, setCounts] = React.useState<PlatformCounts | null>(null);
  const [step, setStep] = React.useState<Step>('plans');
  const [paymentType, setPaymentType] = React.useState<PaymentType>('bank');
  const [bankMethod, setBankMethod] = React.useState<BankMethod>('easypaisa');
  const [screenshot, setScreenshot] = React.useState<File | null>(null);
  const [cryptoNetwork, setCryptoNetwork] = React.useState<'trc20' | 'bep20'>('trc20');
  const [confirmation, setConfirmation] = React.useState<ConfirmationData | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'bank' | 'crypto' | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
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
  const isPaid = Boolean(entitlement?.active);
  const countsChanged =
    entitlement !== null &&
    SUBSCRIPTION_PLATFORMS.some((p) => effectiveCounts[p] !== entitlement.counts[p]);
  const countsUnchanged = entitlement !== null && !countsChanged;

  let quoteError: string | null = null;
  let amountToPay = total;
  let quote: UpgradeQuote | null = null;
  if (entitlement?.periodEndsAt && countsChanged) {
    const daysLeft = daysRemainingBetween(new Date(), new Date(entitlement.periodEndsAt));
    try {
      quote = quoteUpgrade(entitlement.counts, effectiveCounts, daysLeft);
      amountToPay = quote.amountToPayPkr;
    } catch (err) {
      quoteError = err instanceof Error ? err.message : 'That change is not an upgrade.';
    }
  }
  const isUpgrade = Boolean(quote && entitlement?.periodEndsAt);

  function setCount(platform: keyof PlatformCounts, value: number) {
    const next = { ...effectiveCounts, [platform]: Math.max(0, Math.floor(value) || 0) };
    setCounts(next);
  }

  function scrollToId(id: string) {
    window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function goToCheckout() {
    setFormError(null);
    setConfirmation(null);
    setStep('checkout');
    window.scrollTo({ top: 0 });
  }

  function goToPlans() {
    setStep('plans');
    window.scrollTo({ top: 0 });
  }

  function goToPayments() {
    setStep('plans');
    scrollToId('billing-payments');
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
    try {
      const form = new FormData();
      form.append('counts', JSON.stringify(effectiveCounts));
      form.append('bankMethod', bankMethod);
      form.append('screenshot', screenshot);
      await apiPost(buildTenantApiPath(subdomain, '/billing/payments'), form, {
        schema: BillingPaymentItemSchema,
      });
      setScreenshot(null);
      if (screenshotInputRef.current) screenshotInputRef.current.value = '';
      await load();
      setConfirmation({
        kind: 'bank',
        amountPkr: amountToPay,
        counts: effectiveCounts,
        isUpgrade,
        crypto: null,
      });
      setStep('confirmation');
      window.scrollTo({ top: 0 });
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
    try {
      const result = await apiPost(
        buildTenantApiPath(subdomain, '/billing/payments/crypto'),
        { counts: effectiveCounts, network: cryptoNetwork, isUpgrade },
        { schema: CryptoCheckoutResponseSchema }
      );
      await load();
      setConfirmation({
        kind: 'crypto',
        amountPkr: amountToPay,
        counts: effectiveCounts,
        isUpgrade,
        crypto: result,
      });
      setStep('confirmation');
      window.scrollTo({ top: 0 });
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

  const details = BANK_PAYMENT_DETAILS[bankMethod];
  const includedUnits = totalUnits(entitlement.counts);
  const usedUnits = totalUnits(entitlement.usage);
  const checkoutDisabled = busy !== null || units === 0 || Boolean(quoteError);
  const bankDisabled = checkoutDisabled || !screenshot;
  const bankDisabledReason = units === 0
    ? 'Choose at least one page or account first.'
    : quoteError ?? (!screenshot ? 'Attach a screenshot so your payment can be approved.' : null);

  const configurator = (
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
  );

  const orderSummary = (
    <Card>
      <CardHeader>
        <CardTitle>Order summary</CardTitle>
        <CardDescription>What you pay for this plan.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="flex flex-col gap-2 text-body">
          {SUBSCRIPTION_PLATFORMS.filter((p) => effectiveCounts[p] > 0).map((platform) => (
            <div key={platform} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 truncate text-ink-sub">
                {PLATFORM_LABELS[platform]} · {effectiveCounts[platform]}{' '}
                {subscriptionUnitLabel(platform)}
              </dt>
              <dd className="shrink-0 font-medium tabular-nums text-ink">
                {effectiveCounts[platform] * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
              </dd>
            </div>
          ))}
          {units === 0 ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-sub">Selected</dt>
              <dd className="font-medium text-ink">Nothing selected yet</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-sub">Monthly total</dt>
            <dd className="font-medium tabular-nums text-ink">{total} PKR</dd>
          </div>
          {isUpgrade && quote ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Old plan total</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.oldMonthlyTotalPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Days remaining</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.daysRemaining} days</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Credit</dt>
                <dd className="font-medium tabular-nums text-ink">−{quote.creditPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                <dt className="font-medium text-ink">You pay now</dt>
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
        <p className="text-body text-ink-sub">
          {isUpgrade
            ? 'Upgrades only. Your new period starts from the upgrade approval.'
            : 'Approval lasts 30 days from approval. When a period ends without renewal, posting pauses and the app becomes read-only.'}
        </p>
      </CardContent>
    </Card>
  );

  const paymentsHistory = (
    <Card id="billing-payments" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Your payments</CardTitle>
        <CardDescription>Bank payments wait for approval. Crypto payments activate on payment.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {status.payments.length === 0 ? (
          <EmptyState
            type="first-use"
            title="No payments yet"
            description="Payments you submit will appear here, with their approval status."
            action={
              <Button variant="outline" onClick={() => scrollToId('billing-paid-card')}>
                Build a paid plan
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
  );

  /* ---------- Confirmation step ---------- */
  if (step === 'confirmation' && confirmation) {
    const cryptoAmount = confirmation.crypto
      ? (confirmation.crypto.payAmount ?? confirmation.crypto.estimatedUsdt)
      : null;
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
          <p className="text-body text-ink-sub">Your payment is on its way.</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              {confirmation.kind === 'bank' ? 'Payment submitted' : 'Send your crypto payment'}
            </CardTitle>
            <CardDescription>
              {confirmation.kind === 'bank'
                ? 'It starts once approved, for 30 days from approval.'
                : 'Your paid period starts automatically once NOWPayments confirms the payment.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <BillingStatusMark
              kind="pending"
              label={confirmation.kind === 'bank' ? 'Waiting for approval' : 'Waiting for payment'}
            />
            <p className="text-body text-ink">
              {countsSummary(confirmation.counts)} · {confirmation.amountPkr} PKR
              {confirmation.isUpgrade ? ' · Upgrade' : ''}
            </p>
            {confirmation.kind === 'crypto' && confirmation.crypto && cryptoAmount !== null ? (
              <Alert variant="success">
                <AlertTitle>Send exactly {cryptoAmount} USDT</AlertTitle>
                <AlertDescription>
                  <span className="block break-all">To: {confirmation.crypto.payAddress}</span>
                  <span className="block">
                    Network: {confirmation.crypto.network === 'trc20' ? 'TRC20' : 'BEP20'}
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
            <p className="text-body text-ink-sub">
              Your new payment is in Your payments below. Bank payments wait for an admin to
              approve them; crypto payments activate on payment.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={goToPlans}>Back to plans</Button>
              <Button variant="outline" onClick={goToPayments}>
                View payments
              </Button>
            </div>
          </CardContent>
        </Card>
        {paymentsHistory}
      </div>
    );
  }

  /* ---------- Checkout step ---------- */
  if (step === 'checkout') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-1">
          <Button variant="outline" size="sm" className="self-start" onClick={goToPlans}>
            <ArrowLeftIcon aria-hidden className="size-4" /> Back to plans
          </Button>
          <h1 className="text-xl leading-heading font-semibold text-ink">Checkout</h1>
          <p className="text-body text-ink-sub">
            {isUpgrade ? 'Upgrade checkout. ' : ''}
            {countsSummary(effectiveCounts)} · {amountToPay} PKR
            {isUpgrade ? ' to pay now' : ' / month'}
          </p>
        </div>
        {quoteError ? (
          <Alert variant="destructive">
            <AlertTitle>That change is not an upgrade</AlertTitle>
            <AlertDescription>{quoteError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="order-2 flex min-w-0 flex-col gap-6 lg:order-1">
            <Card>
              <CardHeader>
                <CardTitle>Choose how to pay</CardTitle>
                <CardDescription>Bank, mobile wallet, or crypto.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <div role="radiogroup" aria-label="Payment type" className="grid gap-2 sm:grid-cols-2">
                  <MethodCard
                    selected={paymentType === 'bank'}
                    title="Bank or mobile wallet"
                    description="Easypaisa, Nayapay, UBL bank"
                    label="Pay by bank or mobile wallet"
                    onClick={() => setPaymentType('bank')}
                  />
                  <MethodCard
                    selected={paymentType === 'crypto'}
                    title="Crypto"
                    description="USDT via NOWPayments"
                    label="Pay with crypto"
                    onClick={() => setPaymentType('crypto')}
                  />
                </div>

                {paymentType === 'bank' ? (
                  <section aria-label="Pay by bank or mobile wallet" className="flex flex-col gap-4">
                    <div role="radiogroup" aria-label="Payment method" className="grid gap-2 sm:grid-cols-3">
                      {(['easypaisa', 'nayapay', 'ubl'] as const).map((method) => (
                        <MethodCard
                          key={method}
                          selected={bankMethod === method}
                          title={BANK_PAYMENT_DETAILS[method].label}
                          description={BANK_PAYMENT_DETAILS[method].accountNumber}
                          label={`Pay with ${BANK_PAYMENT_DETAILS[method].label}`}
                          onClick={() => setBankMethod(method)}
                        />
                      ))}
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
                        disabled={bankDisabled}
                      >
                        Submit payment for approval
                      </Button>
                      {bankDisabledReason ? (
                        <p className="text-metadata text-ink-sub">{bankDisabledReason}</p>
                      ) : null}
                      <p className="text-metadata text-ink-sub">Approval lasts 30 days from approval.</p>
                    </div>
                  </section>
                ) : (
                  <section aria-label="Pay with crypto" className="flex flex-col gap-4">
                    <p className="text-body text-ink-sub">
                      USDT via NOWPayments. You pay the USDT equivalent of {amountToPay} PKR at
                      checkout.
                    </p>
                    <div role="radiogroup" aria-label="Crypto network" className="grid gap-2 sm:grid-cols-2">
                      {(['trc20', 'bep20'] as const).map((network) => (
                        <MethodCard
                          key={network}
                          selected={cryptoNetwork === network}
                          title={network === 'trc20' ? 'TRC20' : 'BEP20'}
                          description="USDT"
                          label={`Pay with USDT on ${network === 'trc20' ? 'TRC20' : 'BEP20'}`}
                          onClick={() => setCryptoNetwork(network)}
                        />
                      ))}
                    </div>
                    <div>
                      <Button
                        variant="outline"
                        onClick={() => void submitCrypto()}
                        loading={busy === 'crypto'}
                        disabled={checkoutDisabled}
                      >
                        Continue with NOWPayments
                      </Button>
                      {units === 0 ? (
                        <p className="mt-2 text-metadata text-ink-sub">
                          Choose at least one page or account first.
                        </p>
                      ) : null}
                    </div>
                  </section>
                )}

                {formError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Couldn&apos;t complete that</AlertTitle>
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                ) : null}
              </CardContent>
            </Card>
          </div>
          <div className="order-1 lg:order-2 lg:sticky lg:top-20 lg:self-start">{orderSummary}</div>
        </div>
      </div>
    );
  }

  /* ---------- Plans view (default) ---------- */
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <p className="text-body text-ink-sub">
          Choose a plan, then check out. Paid is charged per page or account, per month.
        </p>
      </div>

      {entitlement.reason ? (
        <Alert variant="warning">
          <AlertTitle>Posting is paused</AlertTitle>
          <AlertDescription>{entitlement.reason}</AlertDescription>
        </Alert>
      ) : null}

      {/* Compact current-plan summary strip */}
      <Card>
        <CardContent className="grid gap-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className="text-metadata text-ink-sub">Plan</span>
            {isPaid ? (
              <BillingStatusMark kind="ok" label="Paid and active" />
            ) : (
              <BillingStatusMark kind="failed" label="Free plan" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-metadata text-ink-sub">Paid until</span>
            <span className="text-body font-medium text-ink">{formatDate(entitlement.periodEndsAt)}</span>
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
        </CardContent>
      </Card>

      {/* Pricing cards */}
      <div className="grid items-start gap-6 md:grid-cols-2">
        {/* Free card */}
        <Card>
          <CardHeader>
            <CardTitle>Free</CardTitle>
            <CardDescription>Start with the Prompt Library.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-body text-ink">
              <span className="text-3xl font-semibold tabular-nums">0 PKR</span>
              <span className="text-ink-sub"> / month</span>
            </p>
            <ul className="flex flex-col gap-2 text-body">
              <li className="flex items-start gap-2">
                <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                <span>Prompt Library</span>
              </li>
              <li className="flex items-start gap-2">
                <XIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-critical" />
                <span>Posting and scheduling</span>
              </li>
            </ul>
            <p className="text-body text-ink-sub">There is no free trial. Free is the starting plan.</p>
            {!isPaid ? (
              <BillingStatusMark kind="ok" label="Current plan" />
            ) : null}
          </CardContent>
        </Card>

        {/* Paid card — featured, configurator lives here, not a fixed tier */}
        <Card id="billing-paid-card" className="scroll-mt-20 border-primary">
          <CardHeader>
            <p className="text-metadata font-medium text-ink">Featured</p>
            <CardTitle>Paid</CardTitle>
            <CardDescription>Pay only for what you manage.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-body text-ink">
              <span className="text-3xl font-semibold tabular-nums">70 PKR</span>
              <span className="text-ink-sub"> per page or account, per month</span>
            </p>
            <p className="text-body text-ink-sub">
              Monthly only. Facebook counts pages; every other platform counts accounts.
            </p>
            {configurator}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-primary px-4 py-3">
              <span className="text-body font-semibold text-on-primary">
                {units} pages / accounts selected
              </span>
              <span className="text-body font-semibold tabular-nums text-on-primary">
                {isUpgrade ? `${amountToPay} PKR to upgrade` : `${total} PKR / month`}
              </span>
            </div>
            <p className="text-body text-ink-sub">
              Example: 5 Facebook pages + 3 Instagram accounts = 560 PKR / month.
            </p>
            {isUpgrade && quote ? (
              <p className="text-body text-ink-sub">
                Upgrade preview: credit {quote.creditPkr} PKR for {quote.daysRemaining} days left —
                you pay {amountToPay} PKR. Your new period starts from the upgrade approval.
              </p>
            ) : null}
            {quoteError ? (
              <Alert variant="destructive">
                <AlertTitle>That change is not an upgrade</AlertTitle>
                <AlertDescription>{quoteError}</AlertDescription>
              </Alert>
            ) : null}
            {isPaid && countsUnchanged ? (
              <div className="flex flex-col gap-2">
                <BillingStatusMark kind="ok" label="Current plan" />
                <Button disabled>Current plan</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Button onClick={goToCheckout} disabled={units === 0 || Boolean(quoteError)}>
                  {isUpgrade ? 'Continue to upgrade checkout' : 'Continue to checkout'}
                </Button>
                {units === 0 ? (
                  <p className="text-metadata text-ink-sub">
                    Choose at least one page or account first.
                  </p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* How the limit works */}
      <Card>
        <CardHeader>
          <CardTitle>How the limit works</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-body text-ink-sub">
            Your count covers a whole platform, not each feature. Example: 5 Facebook pages means
            5 in total across in-app schedule, auto download-upload and auto repost — not 5 in
            each. Connecting accounts is unlimited; using one in a feature counts.
          </p>
          <p className="text-body text-ink-sub">
            Free covers the Prompt Library only. When a paid period ends without renewal, posting
            pauses and the app becomes read-only until you renew.
          </p>
        </CardContent>
      </Card>

      {paymentsHistory}
    </div>
  );
}
