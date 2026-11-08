'use client';

/**
 * MyPlanView — the My Plan section only, split out of the old
 * BillingView in the 2026-11-02 separate-sections build.
 *
 * Every state names the plan type in plain language ("Monthly
 * plan" for paid), the pages/accounts and platforms included and
 * in use, the price per month, the start/end dates where a period
 * exists, what happens next and when, and what to do if something
 * is wrong. No state renders only a plan card with a generic
 * "Buy or upgrade" button.
 *
 * Plan-only degradation: the plan card renders from the shared
 * (proven-only) entitlement even when the payments fetch fails;
 * only the payments-dependent cards show a retryable error.
 * Storage is its own fetch with its own error state, for the same
 * reason — a storage blip never hides the plan.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { Skeleton } from '@/components/shared/ui/skeleton';
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

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function paymentMethodLabel(payment: BillingPaymentItem): string {
  if (payment.bankMethod === 'easypaisa') return 'Easypaisa';
  if (payment.bankMethod === 'nayapay') return 'Nayapay';
  if (payment.bankMethod === 'binance') return 'Binance';
  return 'UBL bank';
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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl leading-heading font-semibold text-ink">My plan</h1>
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
      <div aria-busy="true" aria-label="Loading your plan" className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-32" />
          </CardContent>
        </Card>
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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">My plan</h1>
        <p className="text-body text-ink-sub">What your current plan includes.</p>
      </div>

      {paymentsError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load your payments</AlertTitle>
          <AlertDescription>
            {paymentsError} Your plan below is still correct — only the payment cards are affected.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{planTitle}</CardTitle>
          <CardDescription>
            {isPaid
              ? `Your monthly plan is active. ${monthlyPrice} PKR per month.`
              : entitlement.hasPriorPeriod
                ? 'Your monthly plan has ended. Posting is paused until you renew.'
                : 'You are on the Free plan. Posting needs a monthly plan.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isPaid ? (
            <>
              <p className="text-body text-ink">
                {countsSummary(entitlement.counts)} · {monthlyPrice} PKR / month ·{' '}
                {includedUnits} included, {usedUnits} in use
              </p>
              <p className="text-body text-ink-sub">
                Started {formatDate(entitlement.periodStartsAt)} · Ends{' '}
                {formatDate(entitlement.periodEndsAt)} · 70 PKR per page or account, paid monthly.
              </p>
              <p className="text-body text-ink-sub">
                What happens next: your plan keeps running until {formatDate(entitlement.periodEndsAt)}.
                If you do not renew, posting pauses and you can only view your account until you renew.
              </p>
            </>
          ) : entitlement.hasPriorPeriod ? (
            <>
              <p className="text-body text-ink">
                Your previous monthly plan was {countsSummary(previousCounts)}.
              </p>
              <p className="text-body text-ink-sub">
                What happens next: renew in Purchase to start a new 30-day monthly plan. Renewal
                starts from your last plan&apos;s counts — change them, or continue with the same plan.
              </p>
            </>
          ) : (
            <>
              <p className="text-body text-ink">
                Free includes viewing your account and the Prompt Library. Posting, scheduling,
                and Creator Finder need a monthly plan.
              </p>
              <p className="text-body text-ink-sub">
                A monthly plan costs 70 PKR per page or account, per month, and includes 5 GB of
                Media Library storage per page or account, Creator Finder free, and unlimited posts.
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => router.push(tenantPath('/purchase'))}>
              {isPaid ? 'Change your plan' : entitlement.hasPriorPeriod ? 'Renew your plan' : 'Buy a monthly plan'}
            </Button>
            <Button variant="outline" onClick={() => router.push(tenantPath('/payments'))}>
              View payments
            </Button>
          </div>
        </CardContent>
      </Card>

      {pendingPayment ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {pendingUpgrade
                ? 'Upgrade waiting for approval'
                : isPaid
                  ? 'Payment waiting for approval'
                  : entitlement.hasPriorPeriod
                    ? 'Renewal waiting for approval'
                    : 'Submitted for approval'}
            </CardTitle>
            <CardDescription>
              Your monthly plan starts when we approve your payment, not when you paid. If
              approval takes a few days, those days are not added to your plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <BillingStatusMark kind="pending" label="Waiting" />
            <p className="text-body text-ink">
              {pendingPayment.amountPkr} PKR · {paymentMethodLabel(pendingPayment)}
              {pendingPayment.isUpgrade ? ' · Upgrade' : ''}
              {pendingPayment.isDowngrade ? ' · Downgrade' : ''} · Submitted{' '}
              {formatDateTime(pendingPayment.createdAt)}
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
          </CardContent>
        </Card>
      ) : null}

      {latestRejected && !pendingPayment ? (
        <Card>
          <CardHeader>
            <CardTitle>Payment rejected</CardTitle>
            <CardDescription>
              Your last payment was not approved. No plan started from it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <BillingStatusMark kind="failed" label="Rejected" />
            <p className="text-body text-ink">
              {latestRejected.amountPkr} PKR · {paymentMethodLabel(latestRejected)} ·{' '}
              {countsSummary(latestRejected.counts)}
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
          </CardContent>
        </Card>
      ) : null}

      {scheduledDowngrade ? (
        <Card>
          <CardHeader>
            <CardTitle>Scheduled downgrade</CardTitle>
            <CardDescription>
              Your lower monthly plan starts after your current plan ends.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-body text-ink">
              New monthly plan: {countsSummary(scheduledDowngrade.counts)} ·{' '}
              {scheduledDowngrade.amountPkr} PKR / month · Starts{' '}
              {formatDate(scheduledDowngrade.scheduledStartsAt)}
            </p>
            <p className="text-body text-ink-sub">
              Your current plan runs unchanged until {formatDate(entitlement.periodEndsAt)}. No
              credit was given for the days left — you already paid the new lower monthly price
              in advance. There is no cancel for a scheduled downgrade in this version; it takes
              effect on the date above.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {refundPending ? (
        <Card>
          <CardHeader>
            <CardTitle>Refund request waiting</CardTitle>
            <CardDescription>
              You have a refund request waiting for a decision. Your plan stays active while it waits.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <BillingStatusMark kind="pending" label="Waiting" />
            <div>
              <Button variant="outline" onClick={() => router.push(tenantPath('/refund'))}>
                View refund
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Media Library storage</CardTitle>
          <CardDescription>
            5 GB included per page or account on a monthly plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
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
          ) : storage.quotaBytes <= 0 ? (
            <p className="text-body text-ink-sub">
              No storage quota on the Free plan. A monthly plan includes 5 GB per page or account.
            </p>
          ) : (
            <>
              <p className="text-body text-ink">
                {formatGb(storage.usedBytes)} used of {formatGb(storage.quotaBytes)}
                {storage.state === 'near' ? ' — nearly full' : ''}
                {storage.state === 'full' ? ' — full' : ''}
                {storage.state === 'over' ? ' — over quota' : ''}
              </p>
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
              {(storage.state === 'full' || storage.state === 'over') ? (
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

      <Card>
        <CardHeader>
          <CardTitle>Refund</CardTitle>
          <CardDescription>
            Only your first purchase can be refunded, within 7 days of approval.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => router.push(tenantPath('/refund'))}>
            View refunds
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
