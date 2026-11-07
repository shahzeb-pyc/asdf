'use client';

/**
 * PaymentsView — the Payments section only, split out of the old
 * BillingView in the 2026-11-02 separate-sections build.
 *
 * The user API pages by 50, newest-first. This view loads more
 * pages on demand and never claims "every payment" while only page
 * 1 is loaded. Pending rows are not page-1-only: a pending payment
 * is newest by construction (one pending per user, and nothing
 * newer can be created while it waits), so page 1 always carries
 * it — and the pending card is also shown on My Plan.
 *
 * Rejected rows show the stored reason.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  BillingStatusResponseSchema,
  type BillingPaymentItem,
} from '@/lib/api/schemas/billing';
import {
  SUBSCRIPTION_PLATFORMS,
  subscriptionUnitLabel,
  type PlatformCounts,
} from '@fbuploadpro/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
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

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function countsSummary(counts: PlatformCounts): string {
  const parts = SUBSCRIPTION_PLATFORMS.filter((p) => counts[p] > 0).map(
    (p) => `${counts[p]} ${PLATFORM_LABELS[p]} ${subscriptionUnitLabel(p)}`
  );
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts';
}

function paymentMethodLabel(payment: BillingPaymentItem): string {
  if (payment.bankMethod === 'easypaisa') return 'Easypaisa';
  if (payment.bankMethod === 'nayapay') return 'Nayapay';
  if (payment.bankMethod === 'binance') return 'Binance';
  return 'UBL bank';
}

function paymentStatusLabel(status: string): string {
  if (status === 'pending') return 'Waiting for approval';
  if (status === 'approved' || status === 'paid') return 'Paid';
  if (status === 'rejected') return 'Rejected';
  if (status === 'failed') return 'Failed';
  return 'Expired';
}

export function PaymentsView({ subdomain }: Readonly<{ subdomain: string }>) {
  const router = useRouter();
  const [payments, setPayments] = React.useState<BillingPaymentItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const [page, setPage] = React.useState(1);

  const load = React.useCallback(
    async (pageToLoad: number, append: boolean) => {
      try {
        const result = await apiGet(buildTenantApiPath(subdomain, `/billing?page=${pageToLoad}`), {
          schema: BillingStatusResponseSchema,
        });
        setPayments((prev) => (append && prev ? [...prev, ...result.payments] : result.payments));
        // The API pages by 50: a full page means there may be more.
        setHasMore(result.payments.length >= 50);
        setPage(pageToLoad);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [subdomain]
  );

  React.useEffect(() => {
    void load(1, false);
  }, [load]);

  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading payments" className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error && !payments) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl leading-heading font-semibold text-ink">Payments</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load payments</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void load(1, false)}>Try again</Button>
        </div>
      </div>
    );
  }

  const list = payments ?? [];
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl leading-heading font-semibold text-ink">Payments</h1>
        <p className="text-body text-ink-sub">
          Every payment you have made, and its status. Manual payments start after we approve
          them.
        </p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load more payments</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Your payments</CardTitle>
          <CardDescription>
            {list.length === 0
              ? 'No payments yet.'
              : `Showing ${list.length} payment${list.length === 1 ? '' : 's'}${hasMore ? ' — more below' : '.'}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {list.length === 0 ? (
            <EmptyState
              type="first-use"
              title="No payments yet"
              description="Payments you make will show here, with their status."
              action={
                <Button variant="link" onClick={() => router.push(`/tenant/${subdomain}/purchase`)}>
                  Buy a monthly plan
                </Button>
              }
            />
          ) : null}
          {list.map((payment) => (
            <div
              key={payment.id}
              className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-body font-medium tabular-nums text-ink">
                    {payment.amountPkr} PKR · {paymentMethodLabel(payment)}
                    {payment.isUpgrade ? ' · Upgrade' : ''}
                    {payment.isDowngrade ? ' · Downgrade' : ''}
                    {payment.couponCode
                      ? ` · Coupon ${payment.couponCode} (−${payment.discountPkr} PKR)`
                      : ''}
                  </span>
                  <span className="text-metadata text-ink-sub">
                    {formatDate(payment.createdAt)} · {countsSummary(payment.counts)}
                    {payment.isDowngrade && payment.scheduledStartsAt
                      ? ` · Lower plan starts ${formatDate(payment.scheduledStartsAt)}`
                      : ''}
                  </span>
                </div>
                {payment.status === 'approved' || payment.status === 'paid' ? (
                  <BillingStatusMark kind="ok" label={paymentStatusLabel(payment.status)} />
                ) : payment.status === 'rejected' ||
                  payment.status === 'failed' ||
                  payment.status === 'expired' ? (
                  <BillingStatusMark kind="failed" label={paymentStatusLabel(payment.status)} />
                ) : (
                  <BillingStatusMark kind="pending" label="Waiting for approval" />
                )}
              </div>
              {payment.method === 'bank' && payment.status === 'pending' ? (
                <p className="text-body text-ink-sub">
                  Your monthly plan starts when we approve your payment, not when you paid. If
                  approval takes a few days, those days are not added to your plan.
                </p>
              ) : null}
              {payment.status === 'rejected' && payment.rejectionReason ? (
                <p className="text-body text-ink-sub">
                  Rejected: {payment.rejectionReason}
                  {payment.rejectionDetail ? ` — ${payment.rejectionDetail}` : ''}
                </p>
              ) : null}
              {(payment.status === 'failed' || payment.status === 'expired') ? (
                <p className="text-body text-ink-sub">
                  This payment expired. You can submit a new payment in Purchase.
                </p>
              ) : null}
            </div>
          ))}
          {hasMore ? (
            <div>
              <Button
                variant="outline"
                loading={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void load(page + 1, true);
                }}
              >
                Load more payments
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
