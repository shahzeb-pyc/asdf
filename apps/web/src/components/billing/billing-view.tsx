'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
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
type Step = 'plans' | 'build' | 'checkout' | 'confirmation' | 'payments';
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

function plainQuoteError(message: string | null): string | null {
  if (!message) return null;
  if (
    message ===
    'Counts can only be increased mid-cycle. To reduce a count, wait until the current period ends.'
  ) {
    return 'You can only increase counts during your current month. To lower a count, wait until this month ends.';
  }
  if (message === 'An upgrade must cost more than the current plan.') {
    return 'Your new plan must cost more than your current plan.';
  }
  return message;
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
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts selected';
}

function BillingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <div className="grid items-stretch gap-6 lg:grid-cols-2">
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
      <div className="flex flex-col gap-4 border-t border-line pt-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

function StepIndicator({ current }: Readonly<{ current: Step }>) {
  const steps: { id: Step; label: string }[] = [
    { id: 'plans', label: 'Plans' },
    { id: 'build', label: 'Build plan' },
    { id: 'checkout', label: 'Checkout' },
    { id: 'confirmation', label: 'Confirmation' },
  ];
  const currentIndex = steps.findIndex((step) => step.id === current);
  return (
    <nav aria-label="Billing steps" className="flex flex-wrap items-center gap-2">
      {steps.map((step, index) => {
        const active = step.id === current;
        const done = index < currentIndex;
        return (
          <span key={step.id} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-line" /> : null}
            <span
              aria-hidden
              className={cn(
                'flex size-6 items-center justify-center rounded-full text-metadata font-medium',
                active ? 'bg-primary text-on-primary' : 'bg-subtle text-ink-sub'
              )}
            >
              {done ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span
              aria-current={active ? 'step' : undefined}
              className={cn('text-body', active ? 'font-medium text-ink' : 'text-ink-sub')}
            >
              {step.label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

/**
 * Top-level Billing navigation (Plans | Payments). Used only on the two
 * top-level pages; the flow pages (Build plan, Checkout, Confirmation)
 * use StepIndicator instead. Navigation goes through the ?view= URL
 * param so the sidebar group and the browser back button stay in sync.
 */
function PageNav({
  current,
  onNavigate,
}: Readonly<{
  current: 'plans' | 'payments';
  onNavigate: (view: 'plans' | 'payments') => void;
}>) {
  return (
    <nav aria-label="Billing pages" className="flex gap-2 border-b border-line">
      {(['plans', 'payments'] as const).map((view) => (
        <button
          key={view}
          type="button"
          aria-current={current === view ? 'page' : undefined}
          onClick={() => onNavigate(view)}
          className={cn(
            'border-b-2 px-3 py-2 text-body font-medium',
            current === view ? 'border-ink text-ink' : 'border-transparent text-ink-sub hover:text-ink'
          )}
        >
          {view === 'plans' ? 'Plans' : 'Payments'}
        </button>
      ))}
    </nav>
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
        selected ? 'border-ink bg-subtle' : 'border-line bg-panel hover:bg-hover'
      )}
    >
      <span className="block text-body font-medium text-ink">{title}</span>
      <span className="block text-metadata text-ink-sub">{description}</span>
    </button>
  );
}

export function BillingView({
  subdomain,
  initialStep,
}: Readonly<{ subdomain: string; initialStep: Step }>) {
  const [status, setStatus] = React.useState<BillingStatusResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [counts, setCounts] = React.useState<PlatformCounts | null>(null);
  const [step, setStep] = React.useState<Step>(initialStep);
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Sidebar leaves and the browser back button navigate by ?view=, which
   * re-renders this component with a new initialStep. Only follow the
   * prop when it actually changes — internal flow transitions (build →
   * checkout → confirmation) update the URL themselves via navigateTo
   * and must not be reset by this effect.
   */
  const prevInitialStepRef = React.useRef<Step>(initialStep);
  React.useEffect(() => {
    if (prevInitialStepRef.current !== initialStep) {
      prevInitialStepRef.current = initialStep;
      setStep(initialStep);
    }
  }, [initialStep]);
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

  /**
   * Every Billing page change goes through the ?view= URL param, so the
   * sidebar group highlights the right sub-leaf and the browser back
   * button moves between pages. Sidebar leaves themselves are plain
   * Links; this is only for in-page actions (Back buttons, Continue,
   * View payments).
   */
  function navigateTo(target: Step) {
    setStep(target);
    if (pathname) router.replace(`${pathname}?view=${target}`, { scroll: false });
    window.scrollTo({ top: 0 });
  }

  function goToBuild() {
    navigateTo('build');
  }

  function goToCheckout() {
    setFormError(null);
    setConfirmation(null);
    navigateTo('checkout');
  }

  function goToPlans() {
    navigateTo('plans');
  }

  function goToPayments() {
    navigateTo('payments');
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
      setFormError(plainQuoteError(quoteError));
      return;
    }
    if (!screenshot) {
      setFormError('Add a screenshot of your payment so we can approve it.');
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
      navigateTo('confirmation');
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
      setFormError(plainQuoteError(quoteError));
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
      navigateTo('confirmation');
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (loadError && !status) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
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
    : plainQuoteError(quoteError) ?? (!screenshot ? 'Add a screenshot of your payment so we can approve it.' : null);

  // Rate is stated once, in the Paid card header — not repeated on every row.
  // Included/used only shows where it matters (a non-zero included or used count);
  // otherwise the row just names the unit, so a Free workspace is not six
  // identical "Included 0, used 0" lines.
  const configurator = (
    <div className="flex flex-col">
      {SUBSCRIPTION_PLATFORMS.map((platform) => {
        const count = effectiveCounts[platform];
        const showUsage = entitlement.counts[platform] > 0 || entitlement.usage[platform] > 0;
        return (
          <div
            key={platform}
            className="flex items-center gap-4 border-t border-line py-4 first:border-t-0 first:pt-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-ink">{PLATFORM_LABELS[platform]}</p>
              <p className="truncate text-body text-ink-sub">
                {showUsage
                  ? `Included: ${entitlement.counts[platform]} · In use: ${entitlement.usage[platform]}`
                  : 'Not included yet'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="icon-lg"
                aria-label={`Decrease ${PLATFORM_LABELS[platform]}`}
                onClick={() => setCount(platform, count - 1)}
                disabled={count <= 0}
                className="text-lg disabled:opacity-100 disabled:text-ink-sub"
              >
                −
              </Button>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={count}
                aria-label={`${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)}`}
                className="h-10 w-16 text-center tabular-nums"
                onChange={(event) => setCount(platform, Number(event.target.value))}
              />
              <Button
                variant="outline"
                size="icon-lg"
                aria-label={`Increase ${PLATFORM_LABELS[platform]}`}
                onClick={() => setCount(platform, count + 1)}
                className="text-lg"
              >
                +
              </Button>
            </div>
            <span className="w-20 shrink-0 text-right text-body font-medium tabular-nums text-ink">
              {count * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
            </span>
          </div>
        );
      })}
    </div>
  );

  const orderSummary = (
    <Card>
      <CardHeader>
        <CardTitle>Order summary</CardTitle>
        <CardDescription>What you will pay.</CardDescription>
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
            <dd className="font-semibold tabular-nums text-ink">{total} PKR</dd>
          </div>
          {isUpgrade && quote ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Current plan</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.oldMonthlyTotalPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Days left on your current plan</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.daysRemaining} days</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Credit for unused days</dt>
                <dd className="font-medium tabular-nums text-ink">−{quote.creditPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                <dt className="font-medium text-ink">You pay now</dt>
                <dd className="font-semibold tabular-nums text-ink">{amountToPay} PKR</dd>
              </div>
            </>
          ) : (
            <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
              <dt className="text-lg font-medium text-ink">You pay</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink">{total} PKR / month</dd>
            </div>
          )}
        </dl>
        <p className="text-body text-ink-sub">
          {isUpgrade
            ? 'Your new month starts when your upgrade is approved.'
            : 'Your month runs for 30 days from approval. If you do not renew, posting pauses and you can only view your account until you renew.'}
        </p>
      </CardContent>
    </Card>
  );

  const paymentsHistory = (
    <Card id="billing-payments" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Your payments</CardTitle>
        <CardDescription>Bank payments start after we approve them. Crypto payments start as soon as we receive them.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {status.payments.length === 0 ? (
          <EmptyState
            type="first-use"
            title="No payments yet"
            description="Payments you make will show here, with their status."
            action={
              <Button variant="link" onClick={goToPlans}>
                Back to plans
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
                  : `Crypto · USDT (${payment.nowpaymentsNetwork === 'trc20' ? 'TRC20' : 'BEP20'})`}
                {payment.isUpgrade ? ' · Upgrade' : ''}
              </span>
              <span className="text-metadata text-ink-sub">{formatDate(payment.createdAt)}</span>
            </div>
            {payment.status === 'approved' || payment.status === 'paid' ? (
              <BillingStatusMark kind="ok" label={paymentStatusLabel(payment.status)} />
            ) : payment.status === 'rejected' || payment.status === 'failed' || payment.status === 'expired' ? (
              <BillingStatusMark kind="failed" label={paymentStatusLabel(payment.status)} />
            ) : (
              <BillingStatusMark kind="pending" label={payment.method === 'bank' ? 'Waiting for approval' : 'Waiting for payment'} />
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
          <p className="text-body text-ink-sub">{confirmation.kind === 'bank' ? 'We have received your payment.' : 'One step left: send your payment.'}</p>
        </div>
        <StepIndicator current="confirmation" />
        <Card>
          <CardHeader>
            <CardTitle>
              {confirmation.kind === 'bank' ? 'Payment submitted' : 'Send your crypto payment'}
            </CardTitle>
            <CardDescription>
              {confirmation.kind === 'bank'
                ? 'Your plan starts when we approve it, and runs for 30 days.'
                : 'Your plan starts automatically once we receive your payment.'}
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
              Bank payments start after we approve them. Crypto payments start as soon as we
              receive them. You can see this payment under Payments.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={goToPlans}>Back to plans</Button>
              <Button variant="outline" onClick={goToPayments}>
                View payments
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ---------- Checkout step ---------- */
  if (step === 'checkout') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <Button variant="outline" size="sm" className="self-start" onClick={goToBuild}>
            <ArrowLeftIcon aria-hidden className="size-4" /> Back to build plan
          </Button>
          <h1 className="text-xl leading-heading font-semibold text-ink">Checkout</h1>
          <p className="text-body text-ink-sub">
            {isUpgrade ? 'Upgrade · ' : ''}
            {countsSummary(effectiveCounts)} · {amountToPay} PKR
            {isUpgrade ? ' to pay now' : ' / month'}
          </p>
        </div>
        <StepIndicator current="checkout" />
        {entitlement.reason ? (
          <Alert variant="warning">
            <AlertTitle>Posting is paused</AlertTitle>
            <AlertDescription>{entitlement.reason}</AlertDescription>
          </Alert>
        ) : null}
        {quoteError ? (
          <Alert variant="destructive">
            <AlertTitle>You can only increase your plan</AlertTitle>
            <AlertDescription>{plainQuoteError(quoteError)}</AlertDescription>
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
                    title="Crypto (USDT)"
                    description="Pay in USDT"
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
                        variant={bankDisabled ? 'secondary' : 'default'}
                        onClick={() => void submitBank()}
                        loading={busy === 'bank'}
                        disabled={bankDisabled}
                      >
                        Submit payment for approval
                      </Button>
                      {bankDisabledReason ? (
                        <p className="text-body text-ink-sub">{bankDisabledReason}</p>
                      ) : null}
                      <p className="text-body text-ink-sub">Your plan runs for 30 days from approval.</p>
                    </div>
                  </section>
                ) : (
                  <section aria-label="Pay with crypto" className="flex flex-col gap-4">
                    <p className="text-body text-ink-sub">
                      Pay in USDT. You will pay the USDT equal to {amountToPay} PKR.
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
                        Continue to crypto payment
                      </Button>
                      {units === 0 ? (
                        <p className="mt-2 text-body text-ink-sub">
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

  /* ---------- Build your plan page ---------- */
  if (step === 'build') {
    const buildDisabled =
      busy !== null || units === 0 || Boolean(quoteError) || (isPaid && countsUnchanged);
    const buildDisabledReason =
      units === 0
        ? 'Choose at least one page or account first.'
        : isPaid && countsUnchanged
          ? 'This is the same as your current plan. Increase a count to upgrade.'
          : null;
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="sm" className="self-start" onClick={goToPlans}>
            <ArrowLeftIcon aria-hidden className="size-4" /> Back to plans
          </Button>
          <h1 className="text-xl leading-heading font-semibold text-ink">Build your paid plan</h1>
          <p className="text-body text-ink-sub">
            70 PKR per page or account, paid monthly. Facebook counts pages; other platforms
            count accounts.
          </p>
        </div>
        <StepIndicator current="build" />
        {quoteError ? (
          <Alert variant="destructive">
            <AlertTitle>You can only increase your plan</AlertTitle>
            <AlertDescription>{plainQuoteError(quoteError)}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Choose your pages and accounts</CardTitle>
              <CardDescription>
                Connect as many accounts as you like — only the pages and accounts you actually use count towards your plan.
              </CardDescription>
            </CardHeader>
            <CardContent>{configurator}</CardContent>
          </Card>
          <div className="flex flex-col gap-6 lg:sticky lg:top-20 lg:self-start">
            {orderSummary}
            <div className="flex flex-col gap-2">
              <Button
                variant={buildDisabled ? 'secondary' : 'default'}
                onClick={goToCheckout}
                disabled={buildDisabled}
              >
                Continue to checkout
              </Button>
              {buildDisabledReason ? (
                <p className="text-body text-ink-sub">{buildDisabledReason}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Payments page ---------- */
  if (step === 'payments') {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
          <p className="text-body text-ink-sub">
            Every payment you have made, and its status.
          </p>
        </div>
        <PageNav current="payments" onNavigate={(view) => navigateTo(view)} />
        {paymentsHistory}
      </div>
    );
  }

  /* ---------- Plans view (default) ---------- */
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <p className="text-body text-ink-sub">
          Choose a plan, then pay. Paid plans cost 70 PKR per page or account, each month.
        </p>
      </div>
      <PageNav current="plans" onNavigate={(view) => navigateTo(view)} />

      {entitlement.reason ? (
        <Alert variant="warning">
          <AlertTitle>Posting is paused</AlertTitle>
          <AlertDescription>{entitlement.reason}</AlertDescription>
        </Alert>
      ) : null}

      {/* Current-plan status panel — Free is a plan, not a failure, so it
          gets no red mark; "No paid plan" replaces the bare dash. */}
      <Card>
        <CardHeader>
          <CardTitle>Your plan</CardTitle>
          <CardDescription>Your current plan.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className="text-body text-ink-sub">Plan</span>
            <span className="text-lg font-semibold text-ink">{isPaid ? 'Paid' : 'Free'}</span>
            {isPaid ? (
              <BillingStatusMark kind="ok" label="Active" />
            ) : (
              <span className="text-body text-ink-sub">Prompt Library only</span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-body text-ink-sub">Paid until</span>
            <span className="text-body font-medium text-ink">
              {entitlement.periodEndsAt ? formatDate(entitlement.periodEndsAt) : 'No paid plan'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-body text-ink-sub">Included</span>
            <span className="text-body font-medium tabular-nums text-ink">
              {includedUnits} pages / accounts
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-body text-ink-sub">In use</span>
            <span className="text-body font-medium tabular-nums text-ink">
              {usedUnits} pages / accounts
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Pricing cards — matched pair: equal height, Free content anchored
          to the bottom instead of stranded mid-card. */}
      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        {/* Free card */}
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>Free</CardTitle>
            <CardDescription>Start with the Prompt Library.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
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
                <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                <span>Connect as many accounts as you like</span>
              </li>
              <li className="flex items-start gap-2">
                <XIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-critical" />
                <span>Posting and scheduling</span>
              </li>
              <li className="flex items-start gap-2">
                <XIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-critical" />
                <span>Scheduling, auto download-upload and auto repost</span>
              </li>
            </ul>
            <div className="mt-auto flex flex-col gap-2">
              <p className="text-body text-ink-sub">
                There is no trial — Free is your starting plan.
              </p>
              {!isPaid ? (
                <BillingStatusMark kind="ok" label="Current plan" />
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Paid card — featured. No builder, no summary panel, no checkout
            button buried here: those live on their own pages. This card
            only presents the plan and sends the user to Build your plan. */}
        <Card id="billing-paid-card" className="flex scroll-mt-20 flex-col">
          <CardHeader>
            <div className="flex items-baseline gap-2">
              <CardTitle>Paid</CardTitle>
              <span className="rounded-sm bg-primary px-2 py-0.5 text-metadata font-medium text-on-primary">
                Featured
              </span>
            </div>
            <CardDescription>Pay only for what you manage.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-5">
            <p className="flex flex-wrap items-baseline gap-x-2 text-ink">
              <span className="text-3xl font-semibold tabular-nums">70 PKR</span>
              <span className="text-body text-ink-sub">per page or account, per month</span>
            </p>
            <p className="text-body text-ink-sub">
              Paid monthly. Facebook counts pages; other platforms count accounts.
            </p>
            <ul className="flex flex-col gap-2 text-body">
              <li className="flex items-start gap-2">
                <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                <span>Prompt Library</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                <span>Posting and scheduling</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                <span>
                  Scheduling, auto download-upload and auto repost, up to the pages and
                  accounts in your plan
                </span>
              </li>
              <li className="flex items-start gap-2">
                <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                <span>Connect as many accounts as you like</span>
              </li>
            </ul>
            <p className="text-body text-ink-sub">
              Example: 5 Facebook pages + 3 Instagram accounts = 560 PKR / month.
            </p>
            <div className="mt-auto flex flex-col gap-2">
              {isPaid && countsUnchanged ? (
                <BillingStatusMark kind="ok" label="Current plan" />
              ) : null}
              <Button onClick={goToBuild}>
                {!isPaid
                  ? 'Build your paid plan'
                  : countsChanged
                    ? 'Review your plan change'
                    : 'Change plan'}
              </Button>
              {isPaid && countsChanged ? (
                <p className="text-body text-ink-sub">
                  {countsSummary(effectiveCounts)} · {total} PKR / month
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* How the limit works — plain section, not another box */}
      <section className="border-t border-line pt-6">
        <h2 className="text-lg leading-heading font-semibold text-ink">How the limit works</h2>
        <div className="mt-4">
          <ul className="flex flex-col gap-3 text-body text-ink">
            <li className="flex items-start gap-2">
              <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
              <span>
                <span className="font-medium">One limit per platform, across everything.</span>{' '}
                5 Facebook pages means 5 in total for scheduling, auto download-upload and auto
                repost — not 5 in each.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
              <span>
                <span className="font-medium">Connecting is unlimited.</span> Connecting an
                account never counts; it only counts once you actually use it.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
              <span>
                <span className="font-medium">Monthly, from approval.</span> Each paid month lasts
                30 days from approval.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
              <span>
                <span className="font-medium">If you do not renew, posting pauses</span>{' '}
                and you can only view your account until you renew.
              </span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
