'use client';

import * as React from 'react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  UserRefundsResponseSchema,
  type RefundRequestItem,
  type UserRefundsResponse,
} from '@/lib/api/schemas/billing';
import { isUpgradeCancelledRefund } from '@fbuploadpro/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { BillingStatusMark } from './billing-status-mark';

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function formatAmount(amount: number, currency: 'PKR'): string {
  return `${amount} PKR`;
}

function destinationLabel(item: RefundRequestItem): string {
  if (item.destinationType === 'mobile') return 'Mobile number';
  if (item.destinationType === 'bank') return 'Bank account / IBAN';
  if (item.destinationType === 'binance') return 'Binance ID';
  return '—';
}

function statusLabel(item: RefundRequestItem): string {
  // Upgrade-cancelled rows are stored as 'rejected' with the exact
  // upgrade reason (the status CHECK has no 'cancelled' value):
  // they render as cancelled, never as a plain rejection.
  if (item.status === 'rejected' && isUpgradeCancelledRefund(item.reason)) {
    return 'Cancelled because you upgraded';
  }
  if (item.status === 'requested') return 'Waiting for a decision';
  if (item.status === 'approved') return 'Approved';
  if (item.status === 'rejected') return 'Rejected';
  return 'Sent';
}

/**
 * Refund section on My Plan. The "Request refund" button appears ONLY
 * when the server says the user is eligible (first purchase, inside
 * the 7-day window, plan active, no approved refund). A rejected
 * request does not hide the section: the user may request again
 * while still inside the window, and past requests always stay
 * visible here.
 */
export function RefundSection({
  subdomain,
  standalone = false,
}: Readonly<{ subdomain: string; standalone?: boolean }>) {
  const [data, setData] = React.useState<UserRefundsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const [destinationValue, setDestinationValue] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing/refunds'), {
        schema: UserRefundsResponseSchema,
      });
      setData(result);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [subdomain]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!data?.eligibility.paymentId || !data.eligibility.destinationType) return;
    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    try {
      await apiPost(buildTenantApiPath(subdomain, '/billing/refunds'), {
        paymentId: data.eligibility.paymentId,
        destination: {
          type: data.eligibility.destinationType,
          value: destinationValue.trim(),
        },
        reason: reason.trim() ? reason.trim() : undefined,
      });
      setNotice('Refund requested. We will decide it and let you know here.');
      setShowForm(false);
      setDestinationValue('');
      setReason('');
      await load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (error && !data) {
    // Standalone Refund page: an error must read as an error, never
    // as "no refunds". Embedded use keeps the old null behaviour
    // so a refunds blip never crashes My Plan.
    if (!standalone) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Refund</CardTitle>
          <CardDescription>Your refund requests and eligibility.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load refunds</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <div>
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card aria-busy="true" aria-label="Loading refunds">
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
    );
  }

  // A malformed refunds response must never crash the whole Billing page
  // (e.g. a future server change returning an unexpected shape): fail
  // closed and render nothing, same as the fetch-error path above.
  const eligibility = data.eligibility;
  const requests = data.requests ?? [];
  if (!eligibility) {
    return null;
  }
  const destinationType = eligibility.destinationType;

  // Nothing to show in embedded use: no eligibility and no request
  // history. Standalone use always shows the reason, so a user can
  // tell "window closed" from "never eligible" from "already
  // refunded" (owner decision 2026-11-02: reason + history shown
  // unconditionally on the standalone Refund section).
  if (!eligibility.eligible && requests.length === 0 && !standalone) {
    return null;
  }
  if (!eligibility.eligible && requests.length === 0 && standalone) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Refund</CardTitle>
          <CardDescription>
            Only your first purchase can be refunded, within 7 days of approval. The refund is
            what you paid, minus the days you used.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-body text-ink">
            You cannot request a refund right now.
          </p>
          {eligibility.reason ? (
            <p className="text-body text-ink-sub">{eligibility.reason}</p>
          ) : null}
          <p className="text-body text-ink-sub">
            Refunds are paid outside the app and then marked sent here. If you think this is
            wrong, contact us from the plan you paid for.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Refund</CardTitle>
        <CardDescription>
          Only your first purchase can be refunded, within 7 days of approval. The refund is
          what you paid, minus the days you used.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {notice ? (
          <Alert variant="success">
            <AlertTitle>Saved</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {formError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t submit that request</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        {standalone && !eligibility.eligible && eligibility.reason ? (
          <p className="text-body text-ink-sub">{eligibility.reason}</p>
        ) : null}

        {eligibility.eligible && destinationType && !showForm ? (
          <div className="flex flex-col gap-2">
            <p className="text-body text-ink-sub">
              Estimated refund: {formatAmount(eligibility.estimatedRefund ?? 0, eligibility.currency ?? 'PKR')}
              {eligibility.daysUsed !== null ? ` · ${eligibility.daysUsed} days used` : ''}.
              The final amount is calculated when we approve it, based on the days used then.
            </p>
            <div>
              <Button onClick={() => setShowForm(true)}>Request refund</Button>
            </div>
          </div>
        ) : null}

        {eligibility.eligible && destinationType && showForm ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="refund-destination" className="text-body font-medium text-ink">
                {destinationType === 'mobile'
                  ? 'Mobile number you paid from'
                  : destinationType === 'bank'
                    ? 'Bank account / IBAN you paid from'
                    : 'Binance ID you paid from'}
              </label>
              <input
                id="refund-destination"
                type="text"
                value={destinationValue}
                onChange={(event) => setDestinationValue(event.target.value)}
                required
                className="rounded-md border border-line bg-panel px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="refund-reason" className="text-body font-medium text-ink">
                Reason (optional)
              </label>
              <textarea
                id="refund-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                className="rounded-md border border-line bg-panel px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
              />
            </div>
            <p className="text-body text-ink-sub">
              Refunds go to the same account you paid from. We check it manually against your
              payment screenshot before sending.
            </p>
            <p className="text-body text-ink-sub">
              Estimated refund: {formatAmount(eligibility.estimatedRefund ?? 0, eligibility.currency ?? 'PKR')}
              {eligibility.daysUsed !== null ? ` · ${eligibility.daysUsed} days used` : ''}. The
              final amount is calculated when we approve it, based on the days used then.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={submitting} disabled={!destinationValue.trim()}>
                Submit refund request
              </Button>
              <Button variant="outline" type="button" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {requests.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-body font-medium text-ink">Your refund requests</h3>
            {requests.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0 first:pt-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-body font-medium text-ink">
                    {item.status === 'approved' && item.refundAmount !== null
                      ? `Refund approved: ${formatAmount(item.refundAmount, item.currency)}`
                      : item.status === 'sent' && item.refundAmount !== null
                        ? `Refund sent: ${formatAmount(item.refundAmount, item.currency)}`
                        : `Paid ${formatAmount(item.amountPaid, item.currency)}`}
                  </span>
                  <span className="text-metadata text-ink-sub">
                    {destinationLabel(item)}: {item.destinationValue} · Requested{' '}
                    {formatDate(item.requestedAt)}
                    {item.reason ? ` · ${item.reason}` : ''}
                  </span>
                  {item.status === 'requested' ? (
                    <span className="text-metadata text-ink-sub">
                      Your plan stays active while this request is waiting for a decision.
                    </span>
                  ) : null}
                  {item.status === 'rejected' && isUpgradeCancelledRefund(item.reason) ? (
                    <span className="text-metadata text-ink-sub">
                      Cancelled because you upgraded — the upgrade credit already covered the
                      unused value of your old plan, so no refund is due for it.
                    </span>
                  ) : item.status === 'rejected' ? (
                    <span className="text-metadata text-ink-sub">
                      Rejected — your plan keeps running. You can request again while still
                      inside the 7-day window.
                    </span>
                  ) : null}
                  {item.status === 'approved' ? (
                    <span className="text-metadata text-ink-sub">
                      Approved — your plan is now Free. We will send the money to the account
                      above.
                    </span>
                  ) : null}
                </div>
                {item.status === 'requested' ? (
                  <BillingStatusMark kind="pending" label="Waiting for a decision" />
                ) : item.status === 'approved' || item.status === 'sent' ? (
                  <BillingStatusMark kind="ok" label={statusLabel(item)} />
                ) : (
                  <BillingStatusMark kind="failed" label={statusLabel(item)} />
                )}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
