'use client';

/**
 * MyPlanView — the My Plan section only, split out of the old
 * BillingView in the 2026-11-02 separate-sections build.
 *
 * Layout (spec 260, approved mockup): an Analytics-style full-width
 * KPI band on top, then the cards in a tighter centred 768px column
 * so they stop stretching. Every state names the plan type in plain
 * language ("Monthly plan" for paid), the pages/accounts and
 * platforms included and in use, the price per month, the start/end
 * dates where a period exists, what happens next and when, and what
 * to do if something is wrong. No state renders only a plan card
 * with a generic "Buy or upgrade" button.
 *
 * Plan-only degradation: the plan card renders from the shared
 * (proven-only) entitlement even when the payments fetch fails;
 * only the payments-dependent cards show a retryable error.
 * Storage is its own fetch with its own error state, for the same
 * reason — a storage blip never hides the plan.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckIcon, XIcon } from 'lucide-react';
import { apiGet, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import { reportError } from '@/lib/report-error';
import {
  BillingStatusResponseSchema,
  MediaStorageResponseSchema,
  UserRefundsResponseSchema,
  type BillingPaymentItem,
} from '@/lib/api/schemas/billing';
import {
  SUBSCRIPTION_PLATFORMS,
  subscriptionUnitLabel,
  totalPricePkr,
  totalUnits,
  type PlatformCounts,
} from '@fbuploadpro/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { Progress } from '@/components/shared/ui/progress';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { calendarDaysLeft } from '@/components/shell/topbar-plan-pill';
import { cn } from '@/lib/utils';
import { BillingStatusMark } from './billing-status-mark';
import { useSharedEntitlement } from './entitlement-provider';

const PLATFORM_LABELS: Record<keyof PlatformCounts, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

const GIB_BYTES = 1024 * 1024 * 1024;

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function countsSummary(counts: PlatformCounts): string {
  const parts = SUBSCRIPTION_PLATFORMS.filter((p) => counts[p] > 0).map(
    (p) => `${counts[p]} ${PLATFORM_LABELS[p]} ${subscriptionUnitLabel(p)}`
  );
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts';
}

/** Gigabytes with one decimal, without the unit (rendered separately). */
function formatGbValue(bytes: number): string {
  return (bytes / GIB_BYTES).toFixed(1);
}

/** Grouped thousands ("350,000") for the big hero/KPI numbers. */
function formatGrouped(value: number): string {
  return value.toLocaleString('en-US');
}

function usagePercent(used: number, included: number): number {
  if (included <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / included) * 100)));
}

function firstPlatformWithCounts(counts: PlatformCounts): keyof PlatformCounts | null {
  return SUBSCRIPTION_PLATFORMS.find((p) => counts[p] > 0) ?? null;
}

function paymentMethodLabel(payment: BillingPaymentItem): string {
  if (payment.bankMethod === 'easypaisa') return 'Easypaisa';
  if (payment.bankMethod === 'nayapay') return 'Nayapay';
  if (payment.bankMethod === 'binance') return 'Binance';
  return 'UBL bank';
}

/**
 * KPI band cell — the Analytics audience-hero shape: coloured dot +
 * label, big number, small sub-line.
 */
function KpiCell({
  dotClassName,
  label,
  sub,
  valueClassName,
  children,
}: Readonly<{
  dotClassName: string;
  label: string;
  sub?: string;
  valueClassName?: string;
  children: React.ReactNode;
}>) {
  return (
    <div className="py-6 sm:px-8 sm:first:pl-0 sm:last:pr-0 lg:py-7 lg:px-12 lg:first:pl-0 lg:last:pr-0">
      <div className="flex items-center gap-2 text-body font-semibold text-ink-sub">
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', dotClassName)} />
        <span>{label}</span>
      </div>
      <div
        className={cn(
          'mt-2.5 text-4xl leading-none font-bold tracking-display tabular-nums text-ink sm:text-5xl',
          valueClassName
        )}
      >
        {children}
      </div>
      {sub ? <div className="mt-2 text-metadata text-ink-dim">{sub}</div> : null}
    </div>
  );
}

/** Status pill — the shared status mark inside a bordered pill frame. */
function StatusPill({ kind, label }: Readonly<{ kind: 'ok' | 'failed' | 'pending'; label: string }>) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-line-strong bg-panel px-2 py-1">
      <BillingStatusMark kind={kind} label={label} />
    </span>
  );
}

/** Included / not-included row on the Free card. */
function FeatureRow({ included, label }: Readonly<{ included: boolean; label: string }>) {
  const Icon = included ? CheckIcon : XIcon;
  return (
    <div className="flex items-center gap-3 py-3">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          included
            ? 'bg-signal-operational/15 text-signal-operational'
            : 'bg-signal-critical/15 text-signal-critical'
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className={cn('font-semibold', included ? 'text-ink' : 'text-ink-sub')}>{label}</span>
    </div>
  );
}

/** Two-cell hero row inside a card (price, counts, storage). */
function HeroRow({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="grid grid-cols-2 border-y border-line">{children}</div>;
}

function HeroCell({
  value,
  label,
  divided,
  valueClassName,
}: Readonly<{
  value: React.ReactNode;
  label: string;
  divided?: boolean;
  valueClassName?: string;
}>) {
  return (
    <div className={cn('py-4', divided ? 'border-l border-line pl-6' : 'pr-6')}>
      <div
        className={cn(
          'text-4xl leading-none font-bold tracking-display tabular-nums text-ink',
          valueClassName
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 text-metadata font-semibold text-ink-sub">{label}</div>
    </div>
  );
}

/** Big amount with a sub-line, used in the split conditional cards. */
function AmountHero({
  amountPkr,
  sub,
}: Readonly<{ amountPkr: number; sub: React.ReactNode }>) {
  return (
    <div>
      <div className="text-4xl leading-none font-bold tracking-display tabular-nums text-ink">
        {formatGrouped(amountPkr)} <span className="text-lg font-bold text-ink-sub">PKR</span>
      </div>
      <div className="mt-1.5 text-metadata font-semibold text-ink-sub">{sub}</div>
    </div>
  );
}

/** Split layout for the conditional cards (Waiting Option C). */
function SplitCard({
  left,
  right,
}: Readonly<{ left: React.ReactNode; right: React.ReactNode }>) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="grid grid-cols-1 sm:grid-cols-5">
        <div className="flex flex-col justify-center gap-3 border-b border-line px-6 py-6 sm:col-span-2 sm:border-r sm:border-b-0">
          {left}
        </div>
        <div className="flex flex-col gap-3 px-6 py-6 sm:col-span-3">{right}</div>
      </div>
    </Card>
  );
}

export function MyPlanView({ subdomain }: Readonly<{ subdomain: string }>) {
  const router = useRouter();
  const shared = useSharedEntitlement();
  const entitlement = shared.entitlement;
  const [payments, setPayments] = React.useState<BillingPaymentItem[] | null>(null);
  const [paymentsError, setPaymentsError] = React.useState<string | null>(null);
  const [storage, setStorage] = React.useState<{
    quotaBytes: number;
    usedBytes: number;
    state: string | null;
  } | null>(null);
  const [storageError, setStorageError] = React.useState<string | null>(null);
  const [refundPending, setRefundPending] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);

  const loadPayments = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing'), {
        schema: BillingStatusResponseSchema,
      });
      setPayments(result.payments);
      setPaymentsError(null);
    } catch (err) {
      setPaymentsError(getErrorMessage(err));
    }
  }, [subdomain]);

  React.useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  const loadStorage = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing/storage'), {
        schema: MediaStorageResponseSchema,
      });
      setStorage(result);
      setStorageError(null);
    } catch (err) {
      setStorageError(getErrorMessage(err));
    }
  }, [subdomain]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiGet(buildTenantApiPath(subdomain, '/billing/storage'), {
          schema: MediaStorageResponseSchema,
        });
        if (!cancelled) setStorage(result);
      } catch (err) {
        if (!cancelled) setStorageError(getErrorMessage(err));
      }
    })();
    void (async () => {
      try {
        const result = await apiGet(buildTenantApiPath(subdomain, '/billing/refunds'), {
          schema: UserRefundsResponseSchema,
        });
        if (!cancelled) {
          setRefundPending(result.requests.some((item) => item.status === 'requested'));
        }
      } catch (err) {
        // Refund flag is advisory; never block My Plan on it.
        reportError(err, { source: 'my-plan-refund-flag' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subdomain]);

  async function handleRetry() {
    setReloading(true);
    try {
      await shared.refetch();
      await loadPayments();
    } finally {
      setReloading(false);
    }
  }

  const tenantPath = (path: string) => `/tenant/${subdomain}${path}`;

  if (shared.isUnproven) {
    return (
      <div className="mx-auto w-full max-w-300 px-4 py-6 sm:px-6">
        <h1 className="text-xxxl font-bold tracking-h1 text-ink">My plan</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t check your plan</AlertTitle>
          <AlertDescription>
            Your plan could not be checked right now. Please try again.
          </AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!entitlement) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading your plan"
        className="mx-auto w-full max-w-300 px-4 py-6 sm:px-6"
      >
        <Skeleton className="h-8 w-56" />
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <div className="mx-auto mt-9 flex w-full max-w-3xl flex-col gap-8">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-6">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-32" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const isPaid = entitlement.active;
  const sortedPayments = [...(payments ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const pendingPayment = sortedPayments.find((payment) => payment.status === 'pending') ?? null;
  const latestRejected = sortedPayments.find((payment) => payment.status === 'rejected') ?? null;
  const scheduledDowngrade = sortedPayments.find(
    (payment) =>
      payment.isDowngrade &&
      (payment.status === 'approved' || payment.status === 'paid') &&
      payment.scheduledStartsAt &&
      new Date(payment.scheduledStartsAt).getTime() > Date.now()
  ) ?? null;
  const pendingUpgrade = isPaid && pendingPayment?.isUpgrade ? pendingPayment : null;
  // Expired users have no live period, so the entitlement counts
  // are zeros — the previous plan's counts come from the most
  // recent approved payment instead.
  const latestApproved = sortedPayments.find(
    (payment) => payment.status === 'approved' || payment.status === 'paid'
  ) ?? null;
  const previousCounts =
    !isPaid && entitlement.hasPriorPeriod && totalUnits(entitlement.counts) === 0 && latestApproved
      ? latestApproved.counts
      : entitlement.counts;
  const planTitle = isPaid ? 'Monthly plan' : entitlement.hasPriorPeriod ? 'Expired' : 'Free';
  const monthlyPrice = totalPricePkr(entitlement.counts);
  const includedUnits = totalUnits(entitlement.counts);
  const usedUnits = totalUnits(entitlement.usage);
  const usagePct = usagePercent(usedUnits, includedUnits);
  const daysLeft =
    isPaid && entitlement.periodEndsAt ? calendarDaysLeft(entitlement.periodEndsAt) : null;
  const primaryPlatform = firstPlatformWithCounts(entitlement.counts);
  const usageLabel = primaryPlatform
    ? `${PLATFORM_LABELS[primaryPlatform]} ${subscriptionUnitLabel(primaryPlatform)} in use`
    : 'Pages or accounts in use';
  const heroUsageLabel = primaryPlatform
    ? `${subscriptionUnitLabel(primaryPlatform)} in use`
    : 'pages or accounts in use';
  const perPageLabel =
    primaryPlatform === 'facebook'
      ? 'Per page'
      : primaryPlatform
        ? 'Per account'
        : 'Per page or account';
  const usageSub =
    includedUnits > 0
      ? `${usagePct}% of included ${primaryPlatform ? subscriptionUnitLabel(primaryPlatform) : 'pages or accounts'}`
      : 'No pages or accounts';
  const lastPlatform = firstPlatformWithCounts(previousCounts);
  const lastPlanHeroValue = lastPlatform ? previousCounts[lastPlatform] : totalUnits(previousCounts);
  const lastPlanHeroLabel = lastPlatform
    ? `${PLATFORM_LABELS[lastPlatform]} ${subscriptionUnitLabel(lastPlatform)} on your last plan`
    : 'pages or accounts on your last plan';
  const storageUsedGb = storage ? formatGbValue(storage.usedBytes) : null;
  const storagePct =
    storage && storage.quotaBytes > 0 ? usagePercent(storage.usedBytes, storage.quotaBytes) : 0;
  const daysLeftTone =
    daysLeft === null ? 'text-ink' : daysLeft < 7 ? 'text-signal-critical' : 'text-brand-emerald';
  const daysLeftDot =
    daysLeft === null ? 'bg-ink-dim' : daysLeft < 7 ? 'bg-signal-critical' : 'bg-brand-emerald';

  return (
    <div className="mx-auto w-full max-w-300 px-4 py-6 sm:px-6">
      <header className="pb-8">
        <h1 className="text-xxxl font-bold tracking-h1 text-ink">My plan</h1>
        <p className="mt-1.5 text-body text-ink-sub">What your current plan includes.</p>
      </header>

      <div className="grid grid-cols-1 divide-y divide-line border-y border-line sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        {isPaid ? (
          <>
            <KpiCell
              dotClassName={daysLeftDot}
              label="Days left"
              sub={
                entitlement.periodEndsAt
                  ? `Ends ${formatDate(entitlement.periodEndsAt)}`
                  : 'No end date'
              }
              valueClassName={daysLeftTone}
            >
              {daysLeft ?? '—'}
            </KpiCell>
            <KpiCell dotClassName="bg-primary" label={usageLabel} sub={usageSub}>
              {formatGrouped(usedUnits)}{' '}
              <span className="text-xl text-ink-sub sm:text-2xl">/ {formatGrouped(includedUnits)}</span>
            </KpiCell>
            <KpiCell dotClassName="bg-ink-dim" label="Price per month" sub="70 PKR per page or account">
              {formatGrouped(monthlyPrice)}{' '}
              <span className="text-xl text-ink-sub sm:text-2xl">PKR</span>
            </KpiCell>
            <KpiCell dotClassName="bg-ink-dim" label="Storage used" sub="5 GB per page or account">
              {storageUsedGb ?? '—'}{' '}
              <span className="text-xl text-ink-sub sm:text-2xl">GB</span>
            </KpiCell>
          </>
        ) : entitlement.hasPriorPeriod ? (
          <>
            <KpiCell
              dotClassName="bg-signal-critical"
              label="Your plan"
              sub="Posting is paused until you renew"
              valueClassName="text-2xl leading-tight text-signal-critical sm:text-3xl"
            >
              Expired
            </KpiCell>
            <KpiCell
              dotClassName="bg-ink-dim"
              label="Posting"
              sub="View-only until renewal"
              valueClassName="text-2xl leading-tight sm:text-3xl"
            >
              Paused
            </KpiCell>
            <KpiCell dotClassName="bg-primary" label="Pages in use" sub="No live period">
              {formatGrouped(usedUnits)}
            </KpiCell>
            <KpiCell
              dotClassName="bg-ink-dim"
              label="Renewal"
              sub="Starts from your last plan's counts"
              valueClassName="text-2xl leading-tight sm:text-3xl"
            >
              30-day plan
            </KpiCell>
          </>
        ) : (
          <>
            <KpiCell
              dotClassName="bg-ink-dim"
              label="Your plan"
              sub="Posting needs a monthly plan"
              valueClassName="text-2xl leading-tight sm:text-3xl"
            >
              Free
            </KpiCell>
            <KpiCell dotClassName="bg-primary" label="Pages in use" sub="No pages or accounts">
              {formatGrouped(usedUnits)}
            </KpiCell>
            <KpiCell dotClassName="bg-ink-dim" label="Price per month" sub="70 PKR per page or account">
              {formatGrouped(monthlyPrice)}{' '}
              <span className="text-xl text-ink-sub sm:text-2xl">PKR</span>
            </KpiCell>
            <KpiCell
              dotClassName="bg-ink-dim"
              label="Included"
              valueClassName="text-2xl leading-tight sm:text-3xl"
            >
              Prompt Library only
            </KpiCell>
          </>
        )}
      </div>

      <div className="mx-auto mt-9 flex w-full max-w-3xl flex-col gap-8">
        {paymentsError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load your payments</AlertTitle>
            <AlertDescription>
              {paymentsError} Your plan below is still correct — only the payment cards are affected.
            </AlertDescription>
          </Alert>
        ) : null}

        {isPaid ? (
          <Card>
            <CardHeader>
              <CardTitle>{planTitle}</CardTitle>
              <StatusPill kind="ok" label="Active" />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <HeroRow>
                <HeroCell
                  value={
                    <>
                      {formatGrouped(monthlyPrice)}{' '}
                      <span className="text-lg font-bold text-ink-sub">PKR</span>
                    </>
                  }
                  label="per month"
                />
                <HeroCell divided value={formatGrouped(usedUnits)} label={heroUsageLabel} />
              </HeroRow>
              {SUBSCRIPTION_PLATFORMS.filter((p) => entitlement.counts[p] > 0).map((p) => {
                const platformUsed = entitlement.usage[p];
                const platformIncluded = entitlement.counts[p];
                const platformPct = usagePercent(platformUsed, platformIncluded);
                const platformLeft = Math.max(0, platformIncluded - platformUsed);
                return (
                  <div key={p} className="flex flex-col gap-1.5 border-t border-line pt-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-bold text-ink">{PLATFORM_LABELS[p]}</span>
                      <span className="font-bold tabular-nums text-ink">
                        {formatGrouped(platformUsed)}{' '}
                        <span className="font-semibold text-ink-sub">
                          / {formatGrouped(platformIncluded)} {subscriptionUnitLabel(p)} in use
                        </span>
                      </span>
                    </div>
                    <Progress
                      className="h-3.5"
                      value={platformPct}
                      aria-label={`${PLATFORM_LABELS[p]} ${subscriptionUnitLabel(p)} in use`}
                    />
                    <div className="flex items-baseline justify-between gap-3 text-metadata text-ink-sub">
                      <span>
                        <b className="font-bold text-ink tabular-nums">{formatGrouped(platformUsed)}</b>{' '}
                        in use
                      </span>
                      <span>
                        <b className="font-bold text-ink tabular-nums">{formatGrouped(platformLeft)}</b>{' '}
                        {subscriptionUnitLabel(p)} left
                      </span>
                    </div>
                  </div>
                );
              })}
              <div className="grid grid-cols-3 divide-x divide-line border-y border-line">
                <div className="py-3">
                  <div className="text-xs font-bold uppercase tracking-caption text-ink-dim">Started</div>
                  <div className="mt-0.5 text-body font-bold tabular-nums text-ink">
                    {formatDate(entitlement.periodStartsAt)}
                  </div>
                </div>
                <div className="py-3 pl-4">
                  <div className="text-xs font-bold uppercase tracking-caption text-ink-dim">Ends</div>
                  <div className="mt-0.5 text-body font-bold tabular-nums text-ink">
                    {formatDate(entitlement.periodEndsAt)}
                  </div>
                </div>
                <div className="py-3 pl-4">
                  <div className="text-xs font-bold uppercase tracking-caption text-ink-dim">
                    {perPageLabel}
                  </div>
                  <div className="mt-0.5 text-body font-bold tabular-nums text-ink">70 PKR</div>
                </div>
              </div>
              <p className="rounded-md border border-line bg-canvas px-4 py-3.5 text-ink-sub">
                <b className="font-bold text-ink">What happens next:</b> your plan keeps running until{' '}
                {formatDate(entitlement.periodEndsAt)}. If you do not renew, posting pauses and you
                can only view your account until you renew.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => router.push(tenantPath('/purchase'))}>Change your plan</Button>
                <Button variant="outline" onClick={() => router.push(tenantPath('/payments'))}>
                  View payments
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : entitlement.hasPriorPeriod ? (
          <Card>
            <CardHeader>
              <CardTitle>{planTitle}</CardTitle>
              <StatusPill kind="failed" label="Expired" />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <HeroRow>
                <HeroCell value={formatGrouped(lastPlanHeroValue)} label={lastPlanHeroLabel} />
                <HeroCell
                  divided
                  value="30-day"
                  label="monthly plan when you renew"
                  valueClassName="text-2xl leading-tight sm:text-3xl"
                />
              </HeroRow>
              <p className="text-body text-ink">
                Your previous monthly plan was {countsSummary(previousCounts)}.
              </p>
              <p className="rounded-md border border-line bg-canvas px-4 py-3.5 text-ink-sub">
                <b className="font-bold text-ink">What happens next:</b> renew in Purchase to start a
                new 30-day monthly plan. Renewal starts from your last plan&apos;s counts — change
                them, or continue with the same plan.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => router.push(tenantPath('/purchase'))}>Renew your plan</Button>
                <Button variant="outline" onClick={() => router.push(tenantPath('/payments'))}>
                  View payments
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{planTitle}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <HeroRow>
                <HeroCell
                  value={
                    <>
                      {formatGrouped(monthlyPrice)}{' '}
                      <span className="text-lg font-bold text-ink-sub">PKR</span>
                    </>
                  }
                  label="per month"
                />
                <HeroCell
                  divided
                  value="Prompt Library only"
                  label="included with Free"
                  valueClassName="text-2xl leading-tight sm:text-3xl"
                />
              </HeroRow>
              <div className="flex flex-col divide-y divide-line border-y border-line">
                <FeatureRow included label="Prompt Library" />
                <FeatureRow included={false} label="Posting" />
                <FeatureRow included={false} label="Scheduling" />
                <FeatureRow included={false} label="Creator Finder" />
              </div>
              <p className="text-body text-ink-sub">
                Monthly plan: <b className="font-bold text-ink">70 PKR</b> per page or account, per
                month · <b className="font-bold text-ink">5 GB</b> Media Library storage per page or
                account · Creator Finder free · Unlimited posts.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => router.push(tenantPath('/purchase'))}>Buy a monthly plan</Button>
                <Button variant="outline" onClick={() => router.push(tenantPath('/payments'))}>
                  View payments
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {pendingPayment ? (
          <SplitCard
            left={
              <>
                <BillingStatusMark kind="pending" label="Waiting" />
                <AmountHero
                  amountPkr={pendingPayment.amountPkr}
                  sub={
                    <>
                      {paymentMethodLabel(pendingPayment)}
                      {pendingPayment.isUpgrade ? ' · Upgrade' : ''}
                      {pendingPayment.isDowngrade ? ' · Downgrade' : ''} · Submitted{' '}
                      {formatDateTime(pendingPayment.createdAt)}
                    </>
                  }
                />
              </>
            }
            right={
              <>
                <div className="text-lg leading-heading font-semibold text-ink">
                  {pendingUpgrade
                    ? 'Upgrade waiting for approval'
                    : isPaid
                      ? 'Payment waiting for approval'
                      : entitlement.hasPriorPeriod
                        ? 'Renewal waiting for approval'
                        : 'Submitted for approval'}
                </div>
                <p className="text-body text-ink-sub">
                  Your monthly plan starts when we approve your payment, not when you paid. If
                  approval takes a few days, those days are not added to your plan.
                </p>
                <p className="text-body text-ink-sub">
                  {pendingUpgrade
                    ? 'Your current plan keeps running unchanged until this upgrade is approved.'
                    : 'You can build a new plan once this payment is decided.'}
                </p>
                <div>
                  <Button variant="outline" onClick={() => void loadPayments()}>
                    Check again
                  </Button>
                </div>
              </>
            }
          />
        ) : null}

        {latestRejected && !pendingPayment ? (
          <SplitCard
            left={
              <>
                <BillingStatusMark kind="failed" label="Rejected" />
                <AmountHero
                  amountPkr={latestRejected.amountPkr}
                  sub={
                    <>
                      {paymentMethodLabel(latestRejected)} · {countsSummary(latestRejected.counts)}
                    </>
                  }
                />
              </>
            }
            right={
              <>
                <div className="text-lg leading-heading font-semibold text-ink">Payment rejected</div>
                <p className="text-body text-ink-sub">
                  Your last payment was not approved. No plan started from it.
                </p>
                {latestRejected.rejectionReason ? (
                  <p className="text-body text-ink">
                    Reason: {latestRejected.rejectionReason}
                    {latestRejected.rejectionDetail ? ` — ${latestRejected.rejectionDetail}` : ''}
                  </p>
                ) : null}
                <p className="text-body text-ink-sub">
                  Pay again in Purchase — your counts from the rejected order are already filled in.
                </p>
                <div>
                  <Button onClick={() => router.push(tenantPath('/purchase'))}>Pay again</Button>
                </div>
              </>
            }
          />
        ) : null}

        {scheduledDowngrade ? (
          <SplitCard
            left={
              <>
                <AmountHero
                  amountPkr={scheduledDowngrade.amountPkr}
                  sub={
                    <>
                      per month · Starts {formatDate(scheduledDowngrade.scheduledStartsAt)}
                    </>
                  }
                />
                <p className="text-body text-ink-sub">
                  New monthly plan: {countsSummary(scheduledDowngrade.counts)}
                </p>
              </>
            }
            right={
              <>
                <div className="text-lg leading-heading font-semibold text-ink">
                  Scheduled downgrade
                </div>
                <p className="text-body text-ink-sub">
                  Your lower monthly plan starts after your current plan ends.
                </p>
                <p className="text-body text-ink-sub">
                  Your current plan runs unchanged until {formatDate(entitlement.periodEndsAt)}. No
                  credit was given for the days left — you already paid the new lower monthly price
                  in advance. There is no cancel for a scheduled downgrade in this version; it takes
                  effect on the date above.
                </p>
              </>
            }
          />
        ) : null}

        {refundPending ? (
          <SplitCard
            left={
              <>
                <BillingStatusMark kind="pending" label="Waiting" />
                <div>
                  <div className="text-2xl leading-tight font-bold tracking-display text-ink sm:text-3xl">
                    Refund request
                  </div>
                  <div className="mt-1.5 text-metadata font-semibold text-ink-sub">
                    waiting for a decision
                  </div>
                </div>
              </>
            }
            right={
              <>
                <div className="text-lg leading-heading font-semibold text-ink">
                  Refund request waiting
                </div>
                <p className="text-body text-ink-sub">
                  You have a refund request waiting for a decision. Your plan stays active while it
                  waits.
                </p>
                <div>
                  <Button variant="outline" onClick={() => router.push(tenantPath('/refund'))}>
                    View refund
                  </Button>
                </div>
              </>
            }
          />
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Media Library storage</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-body text-ink-sub">
              5 GB included per page or account on a monthly plan.
            </p>
            {storageError ? (
              <>
                <Alert variant="destructive">
                  <AlertTitle>Couldn&apos;t check storage</AlertTitle>
                  <AlertDescription>{storageError}</AlertDescription>
                </Alert>
                <div>
                  <Button variant="outline" onClick={() => void loadStorage()}>
                    Try again
                  </Button>
                </div>
              </>
            ) : !storage ? (
              <Skeleton className="h-4 w-64 max-w-full" />
            ) : (
              <>
                <HeroRow>
                  <HeroCell
                    value={
                      <>
                        {storageUsedGb}{' '}
                        <span className="text-lg font-bold text-ink-sub">GB</span>
                      </>
                    }
                    label="used"
                  />
                  <HeroCell
                    divided
                    value={
                      <>
                        5 <span className="text-lg font-bold text-ink-sub">GB</span>
                      </>
                    }
                    label="per page or account"
                  />
                </HeroRow>
                <div className="flex flex-col gap-1.5">
                  <Progress
                    className="h-3.5"
                    indicatorClassName="bg-brand-emerald"
                    value={storagePct}
                    aria-label="Media Library storage used"
                  />
                  <div className="flex items-baseline justify-between gap-3 text-metadata text-ink-sub">
                    <span>
                      <b className="font-bold text-ink tabular-nums">{storageUsedGb} GB</b> used
                    </span>
                    <span>5 GB per page or account</span>
                  </div>
                </div>
                {storage.quotaBytes <= 0 ? (
                  <p className="text-body text-ink-sub">
                    {entitlement.hasPriorPeriod
                      ? 'No storage quota while the plan has ended. A monthly plan includes 5 GB per page or account.'
                      : 'No storage quota on the Free plan. A monthly plan includes 5 GB per page or account.'}
                  </p>
                ) : null}
                {storage.state === 'near' ? (
                  <p className="text-body text-ink-sub">
                    You are close to your limit. Delete files you no longer need, or add pages or
                    accounts in Purchase to raise your quota.
                  </p>
                ) : null}
                {storage.state === 'full' || storage.state === 'over' ? (
                  <p className="text-body text-ink-sub">
                    You are out of space. Delete files from your Media Library, or add pages or
                    accounts in Purchase to raise your quota.
                  </p>
                ) : null}
                {storage.state === 'full' || storage.state === 'over' ? (
                  <div>
                    <Button onClick={() => router.push(tenantPath('/purchase'))}>
                      Add pages or accounts
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <div>
          <Button variant="outline" onClick={() => router.push(tenantPath('/refund'))}>
            View refunds
          </Button>
        </div>
      </div>
    </div>
  );
}
