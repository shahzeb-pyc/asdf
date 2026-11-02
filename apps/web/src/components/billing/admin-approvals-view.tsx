'use client';

import * as React from 'react';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import {
  AdminPaymentsResponseSchema,
  type AdminPaymentsResponse,
} from '@/lib/api/schemas/billing';
import { PAYMENT_REJECTION_REASONS, SUBSCRIPTION_PLATFORMS, subscriptionUnitLabel } from '@fbuploadpro/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { BillingStatusMark } from './billing-status-mark';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { AdminCouponsView } from './admin-coupons-view';
import { AdminWebhookIssuesView } from './admin-webhook-issues-view';
import { AdminRefundsView } from './admin-refunds-view';

function countsSummary(counts: AdminPaymentsResponse['payments'][number]['counts']): string {
  const parts: string[] = [];
  for (const platform of SUBSCRIPTION_PLATFORMS) {
    const count = counts[platform];
    if (count > 0) {
      const label = platform === 'facebook' ? 'Facebook' : platform[0].toUpperCase() + platform.slice(1);
      parts.push(`${count} ${label} ${subscriptionUnitLabel(platform)}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts';
}

function methodLabel(payment: AdminPaymentsResponse['payments'][number]): string {
  if (payment.method === 'nowpayments') {
    return payment.nowpaymentsNetwork === 'trc20' ? 'Crypto (TRC20)' : 'Crypto (BEP20)';
  }
  if (payment.bankMethod === 'easypaisa') return 'Easypaisa';
  if (payment.bankMethod === 'nayapay') return 'Nayapay';
  if (payment.bankMethod === 'binance') return 'Binance';
  return 'UBL bank';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

/**
 * AdminScreenshot — inline screenshot with the three distinct
 * states the owner required (2026-11-02): loaded (large preview +
 * open full size), missing (no key, or the file is gone — the
 * override / reject-with-reason path, never a retry loop), and
 * failed to load (server/stream error — retry only the screenshot).
 */
function AdminScreenshot({
  paymentId,
  hasScreenshot,
}: Readonly<{ paymentId: string; hasScreenshot: boolean }>) {
  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'loaded'; url: string }
    | { kind: 'missing'; message: string }
    | { kind: 'failed'; message: string }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const urlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!hasScreenshot) {
      setState({ kind: 'missing', message: 'No screenshot attached to this payment.' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const res = await fetch(`/api/admin/payments/${paymentId}/screenshot`);
        if (res.status === 404) {
          const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
          if (!cancelled) {
            setState({
              kind: 'missing',
              message: body?.message ?? 'No screenshot for this payment.',
            });
          }
          return;
        }
        if (!res.ok) {
          if (!cancelled) {
            setState({ kind: 'failed', message: 'The screenshot could not be loaded. Please try again.' });
          }
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setState({ kind: 'loaded', url });
      } catch {
        if (!cancelled) {
          setState({ kind: 'failed', message: 'The screenshot could not be loaded. Please try again.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paymentId, hasScreenshot, attempt]);

  React.useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-48 w-full max-w-md" />
        <p className="text-metadata text-ink-sub">Loading screenshot…</p>
      </div>
    );
  }
  if (state.kind === 'missing') {
    return (
      <p className="text-body text-ink-sub">
        {state.message} Approve it only with a recorded reason, or reject it with a reason.
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-body text-ink-sub">{state.message}</p>
        <div>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Retry screenshot only
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <img
        src={state.url}
        alt="Payment screenshot"
        className="h-auto w-full max-w-md rounded-md border border-line"
      />
      <div>
        <a
          href={`/api/admin/payments/${paymentId}/screenshot`}
          target="_blank"
          rel="noreferrer"
          className="text-body font-medium text-link underline"
        >
          Open full size
        </a>
      </div>
    </div>
  );
}

export function AdminApprovalsView() {
  const [adminSection, setAdminSection] = React.useState<'approvals' | 'coupons'>('approvals');
  const [data, setData] = React.useState<AdminPaymentsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [busy, setBusy] = React.useState<{
    id: string;
    decision: 'approve' | 'reject' | 'approve-crypto' | 'expire-crypto';
  } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [cardNotice, setCardNotice] = React.useState<Record<string, string>>({});
  const [cardError, setCardError] = React.useState<Record<string, string>>({});
  const [dialog, setDialog] = React.useState<{
    payment: AdminPaymentsResponse['payments'][number];
    decision: 'approve' | 'reject' | 'approve-crypto' | 'expire-crypto';
  } | null>(null);
  const [rejectReason, setRejectReason] = React.useState<string>('');
  const [rejectDetail, setRejectDetail] = React.useState('');
  const [overrideReason, setOverrideReason] = React.useState('');

  // Load-more (owner decision 2026-11-02): the API pages by 100,
  // pending-first, and returns the true pending total. The old view
  // never sent ?page=, so everything past page 1 was invisible and
  // the header count was only the loaded slice.
  const load = React.useCallback(async (pageToLoad = 1, append = false) => {
    try {
      const result = await apiGet(`/api/admin/payments?page=${pageToLoad}`, {
        schema: AdminPaymentsResponseSchema,
      });
      setData((prev) =>
        append && prev
          ? {
              payments: [...prev.payments, ...result.payments],
              page: result.page,
              pendingTotal: result.pendingTotal,
            }
          : result
      );
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  React.useEffect(() => {
    void load(1, false);
  }, [load]);

  async function handleLoadMore() {
    if (!data) return;
    setLoadingMore(true);
    try {
      await load(data.page + 1, true);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleRetry() {
    setReloading(true);
    try {
      await load(1, false);
    } finally {
      setReloading(false);
    }
  }

  async function decide(
    paymentId: string,
    decision: 'approve' | 'reject' | 'approve-crypto' | 'expire-crypto',
    extra?: { rejectionReason?: string; rejectionDetail?: string; overrideReason?: string }
  ) {
    setBusy({ id: paymentId, decision });
    setNotice(null);
    setCardError((prev) => {
      const next = { ...prev };
      delete next[paymentId];
      return next;
    });
    try {
      await apiPost(`/api/admin/payments/${paymentId}`, {
        decision,
        ...(extra?.rejectionReason ? { rejectionReason: extra.rejectionReason } : {}),
        ...(extra?.rejectionDetail ? { rejectionDetail: extra.rejectionDetail } : {}),
        ...(extra?.overrideReason ? { overrideReason: extra.overrideReason } : {}),
      });
      const message =
        decision === 'approve'
          ? 'Approved. The plan starts now and runs for 30 days.'
          : decision === 'approve-crypto'
            ? 'Crypto payment approved. The plan starts now and runs for 30 days.'
            : decision === 'expire-crypto'
              ? 'Crypto payment expired. No plan started; any held coupon was released.'
              : 'Rejected. No plan started.';
      setNotice(message);
      setCardNotice((prev) => ({ ...prev, [paymentId]: message }));
      await load(1, false);
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      setCardError((prev) => ({ ...prev, [paymentId]: message }));
    } finally {
      setBusy(null);
    }
  }

  async function confirmDialog() {
    if (!dialog) return;
    const { payment, decision } = dialog;
    if (decision === 'reject') {
      if (!rejectReason || (rejectReason === 'Other' && !rejectDetail.trim())) {
        setCardError((prev) => ({
          ...prev,
          [payment.id]: rejectReason === 'Other'
            ? 'For "Other", write what was wrong with this payment.'
            : 'Choose a reason for rejecting this payment.',
        }));
        return;
      }
    }
    if (decision === 'approve' && !payment.screenshotStorageKey && !overrideReason.trim()) {
      setCardError((prev) => ({
        ...prev,
        [payment.id]: 'This payment has no screenshot. Write a reason to approve it without one.',
      }));
      return;
    }
    setDialog(null);
    setRejectReason('');
    setRejectDetail('');
    setOverrideReason('');
    await decide(payment.id, decision, {
      rejectionReason: decision === 'reject' ? rejectReason : undefined,
      rejectionDetail: decision === 'reject' && rejectDetail.trim() ? rejectDetail.trim() : undefined,
      overrideReason:
        decision === 'approve' && overrideReason.trim() ? overrideReason.trim() : undefined,
    });
  }

  if (adminSection === 'coupons') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">Subscriptions approval</h1>
          <p className="text-body text-ink-sub">
            Approving a payment starts a 30-day plan from approval. Rejecting starts nothing.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Admin billing sections">
          <Button variant="outline" onClick={() => setAdminSection('approvals')}>
            Approvals
          </Button>
          <Button onClick={() => setAdminSection('coupons')}>Coupons</Button>
        </div>
        <AdminCouponsView />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <h1 className="text-xl leading-heading font-semibold text-ink">Subscriptions approval</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load payments</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label="Loading payments" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
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

  const pending = data.payments.filter((payment) => payment.status === 'pending');
  const decided = data.payments.filter((payment) => payment.status !== 'pending');

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Subscriptions approval</h1>
        <p className="text-body text-ink-sub">
          Approving a payment starts a 30-day plan from approval. Rejecting starts nothing.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Admin billing sections">
        <Button onClick={() => setAdminSection('approvals')}>Approvals</Button>
        <Button variant="outline" onClick={() => setAdminSection('coupons')}>
          Coupons
        </Button>
        <Button variant="outline" onClick={() => void handleRetry()} loading={reloading}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-metadata text-ink-sub">Waiting for approval</span>
            <span className="text-lg font-semibold tabular-nums text-ink">{data.pendingTotal}</span>
            {pending.length < data.pendingTotal ? (
              <span className="text-metadata text-ink-sub">
                Showing {pending.length} of {data.pendingTotal} — use Load more below.
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-metadata text-ink-sub">Already decided</span>
            <span className="text-lg font-semibold tabular-nums text-ink">{decided.length}</span>
          </div>
        </CardContent>
      </Card>

      {notice ? (
        <Alert variant="success">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t save that decision</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Payments waiting for approval" className="flex flex-col gap-4">
        <h2 className="text-lg leading-heading font-semibold text-ink">
          Waiting for approval ({data.pendingTotal})
        </h2>
        {pending.length === 0 ? (
          <EmptyState
            type="cleared"
            title="Nothing waiting for approval"
            description="New bank payments will appear here for you to approve or reject."
          />
        ) : null}
        {pending.map((payment) => {
          const isBusy = busy?.id === payment.id;
          return (
            <Card key={payment.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="truncate">{payment.userEmail ?? 'Unknown user'}</CardTitle>
                    <CardDescription>
                      {countsSummary(payment.counts)} · {methodLabel(payment)}
                      {payment.isUpgrade ? ' · Upgrade' : ''}
                      {payment.isDowngrade
                        ? ` · Downgrade${payment.scheduledStartsAt ? ` · Starts ${formatDate(payment.scheduledStartsAt)}` : ''}`
                        : ''} · {formatDate(payment.createdAt)}
                      {payment.couponCode
                        ? ` · Coupon ${payment.couponCode} (−${payment.discountPkr} PKR)`
                        : ''}
                    </CardDescription>
                  </div>
                  <span className="shrink-0 text-lg font-semibold tabular-nums text-ink">
                    {payment.amountPkr} PKR
                  </span>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {cardNotice[payment.id] ? (
                  <Alert variant="success">
                    <AlertTitle>Saved</AlertTitle>
                    <AlertDescription>{cardNotice[payment.id]}</AlertDescription>
                  </Alert>
                ) : null}
                {cardError[payment.id] ? (
                  <Alert variant="destructive">
                    <AlertTitle>Couldn&apos;t save that decision</AlertTitle>
                    <AlertDescription>{cardError[payment.id]}</AlertDescription>
                  </Alert>
                ) : null}
                {payment.method === 'nowpayments' ? (
                  <p className="break-all text-body text-ink-sub">
                    Crypto payment {payment.nowpaymentsPaymentId ?? '—'}
                    {payment.nowpaymentsPayAddress ? ` · ${payment.nowpaymentsPayAddress}` : ''}
                  </p>
                ) : (
                  <AdminScreenshot
                    paymentId={payment.id}
                    hasScreenshot={Boolean(payment.screenshotStorageKey)}
                  />
                )}
                {payment.method === 'nowpayments' ? (
                  <p className="text-body text-ink-sub">
                    Stuck crypto payment: the automatic confirmation never arrived. Approve
                    it only when the payment actually arrived; expire it to cancel it.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {payment.method === 'nowpayments' ? (
                    <>
                      <Button
                        onClick={() => setDialog({ payment, decision: 'approve-crypto' })}
                        disabled={isBusy}
                      >
                        Approve crypto
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setDialog({ payment, decision: 'expire-crypto' })}
                        disabled={isBusy}
                      >
                        Expire crypto
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        onClick={() => setDialog({ payment, decision: 'approve' })}
                        disabled={isBusy}
                      >
                        Approve payment
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setDialog({ payment, decision: 'reject' })}
                        disabled={isBusy}
                      >
                        Reject payment
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section aria-label="Stuck crypto payments" className="flex flex-col gap-4">
        <h2 className="text-lg leading-heading font-semibold text-ink">
          Stuck crypto payments
        </h2>
        <p className="text-body text-ink-sub">
          Crypto payments whose automatic confirmation never arrived or failed. Approve one
          only when the payment actually arrived; expire it to cancel it and release any
          held coupon.
        </p>
        {decided
          .filter(
            (payment) =>
              payment.method === 'nowpayments' &&
              (payment.status === 'failed' || payment.status === 'expired')
          )
          .map((payment) => {
            const isBusy = busy?.id === payment.id;
            return (
              <Card key={payment.id}>
                <CardContent className="flex flex-col gap-4 py-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-body font-medium text-ink">
                      {payment.userEmail ?? 'Unknown user'}
                    </span>
                    <span className="text-metadata text-ink-sub">
                      {countsSummary(payment.counts)} · {payment.amountPkr} PKR ·{' '}
                      {methodLabel(payment)} · {payment.status} · {formatDate(payment.createdAt)}
                      {payment.nowpaymentsPaymentId
                        ? ` · Crypto payment ${payment.nowpaymentsPaymentId}`
                        : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => setDialog({ payment, decision: 'approve-crypto' })}
                      disabled={isBusy}
                    >
                      Approve crypto
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setDialog({ payment, decision: 'expire-crypto' })}
                      disabled={isBusy}
                    >
                      Expire crypto
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
      </section>

      <section aria-label="Recently decided payments" className="flex flex-col gap-4">
        <h2 className="text-lg leading-heading font-semibold text-ink">Recently decided</h2>
        {decided.filter(
          (payment) =>
            !(
              payment.method === 'nowpayments' &&
              (payment.status === 'failed' || payment.status === 'expired')
            )
        ).length === 0 ? (
          <EmptyState
            type="first-use"
            title="No decided payments yet"
            description="Payments you approve or reject will appear here."
          />
        ) : null}
        {decided
          .filter(
            (payment) =>
              !(
                payment.method === 'nowpayments' &&
                (payment.status === 'failed' || payment.status === 'expired')
              )
          )
          .map((payment) => (
          <Card key={payment.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-body font-medium text-ink">
                  {payment.userEmail ?? 'Unknown user'}
                </span>
                <span className="text-metadata text-ink-sub">
                  {countsSummary(payment.counts)} · {payment.amountPkr} PKR · {methodLabel(payment)}
                  {payment.isDowngrade ? ' · Downgrade' : ''}
                  {payment.couponCode
                    ? ` · Coupon ${payment.couponCode} (−${payment.discountPkr} PKR)`
                    : ''}
                  {payment.decidedAt ? ` · Decided ${formatDate(payment.decidedAt)}` : ''}
                </span>
                {payment.rejectionReason ? (
                  <span className="text-metadata text-ink-sub">
                    Rejected: {payment.rejectionReason}
                    {payment.rejectionDetail ? ` — ${payment.rejectionDetail}` : ''}
                  </span>
                ) : null}
                {payment.overrideReason ? (
                  <span className="text-metadata text-ink-sub">
                    Approved without screenshot: {payment.overrideReason}
                  </span>
                ) : null}
              </div>
              {payment.status === 'approved' || payment.status === 'paid' ? (
                <BillingStatusMark kind="ok" label="Approved" />
              ) : (
                // A failed/expired crypto payment was never rejected
                // by an admin — it is stuck, and the section above
                // offers the rescue. Labelling it "Rejected" would
                // hide that.
                <BillingStatusMark
                  kind="failed"
                  label={
                    payment.status === 'failed'
                      ? 'Failed'
                      : payment.status === 'expired'
                        ? 'Expired'
                        : 'Rejected'
                  }
                />
              )}
            </CardContent>
          </Card>
          ))}
      </section>

      {data.payments.length >= 100 ? (
        <div>
          <Button variant="outline" onClick={() => void handleLoadMore()} loading={loadingMore}>
            Load more payments
          </Button>
        </div>
      ) : null}

      <AlertDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setRejectReason('');
            setRejectDetail('');
            setOverrideReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog?.decision === 'reject'
                ? 'Reject this payment?'
                : dialog?.decision === 'expire-crypto'
                  ? 'Expire this crypto payment?'
                  : 'Approve this payment?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.decision === 'reject'
                ? 'The user will see the reason you choose. No plan starts.'
                : dialog?.decision === 'expire-crypto'
                  ? 'No plan starts, and any held coupon is released.'
                  : 'Approving starts a 30-day plan from approval.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialog?.decision === 'reject' ? (
            <div className="flex flex-col gap-3">
              <label htmlFor="admin-reject-reason" className="text-body font-medium text-ink">
                Reason (required)
              </label>
              <select
                id="admin-reject-reason"
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                className="rounded-md border border-line bg-panel px-3 py-2 text-body text-ink"
              >
                <option value="">Choose a reason…</option>
                {PAYMENT_REJECTION_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
              <label htmlFor="admin-reject-detail" className="text-body font-medium text-ink">
                Details {rejectReason === 'Other' ? '(required)' : '(optional)'}
              </label>
              <textarea
                id="admin-reject-detail"
                value={rejectDetail}
                onChange={(event) => setRejectDetail(event.target.value)}
                rows={3}
                className="rounded-md border border-line bg-panel px-3 py-2 text-body text-ink"
              />
            </div>
          ) : null}
          {dialog?.decision === 'approve' && dialog.payment && !dialog.payment.screenshotStorageKey ? (
            <div className="flex flex-col gap-3">
              <p className="text-body text-ink-sub">
                This payment has no screenshot. Approving without one needs a recorded reason.
              </p>
              <label htmlFor="admin-override-reason" className="text-body font-medium text-ink">
                Override reason (required)
              </label>
              <textarea
                id="admin-override-reason"
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                rows={3}
                className="rounded-md border border-line bg-panel px-3 py-2 text-body text-ink"
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={() => void confirmDialog()}
              disabled={
                busy !== null ||
                (dialog?.decision === 'reject' && !rejectReason) ||
                (dialog?.decision === 'approve' &&
                  dialog.payment &&
                  !dialog.payment.screenshotStorageKey &&
                  !overrideReason.trim())
              }
            >
              {dialog?.decision === 'reject'
                ? 'Reject payment'
                : dialog?.decision === 'expire-crypto'
                  ? 'Expire crypto payment'
                  : 'Approve payment'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AdminWebhookIssuesView />

      <AdminRefundsView />
    </div>
  );
}
