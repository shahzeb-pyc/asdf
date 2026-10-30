'use client';

import * as React from 'react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  AdminPaymentsResponseSchema,
  type AdminPaymentsResponse,
} from '@/lib/api/schemas/billing';
import { SUBSCRIPTION_PLATFORMS, subscriptionUnitLabel } from '@fbuploadpro/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { BillingStatusMark } from './billing-status-mark';

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
  return 'UBL bank';
}

export function AdminApprovalsView({ subdomain }: Readonly<{ subdomain: string }>) {
  const [data, setData] = React.useState<AdminPaymentsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing/admin/payments'), {
        schema: AdminPaymentsResponseSchema,
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

  async function decide(paymentId: string, decision: 'approve' | 'reject') {
    setBusyId(paymentId);
    setNotice(null);
    try {
      await apiPost(
        buildTenantApiPath(subdomain, `/billing/admin/payments/${paymentId}`),
        { decision }
      );
      setNotice(
        decision === 'approve'
          ? 'Approved. The paid period starts from now and runs for 30 days.'
          : 'Rejected. No paid period started.'
      );
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (error && !data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load payments</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!data) {
    return <p className="text-body text-ink-sub">Loading payments…</p>;
  }

  const pending = data.payments.filter((payment) => payment.status === 'pending');
  const decided = data.payments.filter((payment) => payment.status !== 'pending');

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Subscriptions approval</h1>
        <p className="text-body text-ink-sub">
          Approve a payment to start a paid period of 30 days from approval. Rejecting starts no
          period.
        </p>
      </div>

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
          Waiting for approval ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <Card>
            <CardContent>
              <p className="text-body text-ink-sub">Nothing is waiting for approval.</p>
            </CardContent>
          </Card>
        ) : null}
        {pending.map((payment) => (
          <Card key={payment.id}>
            <CardHeader>
              <CardTitle>{payment.userEmail ?? 'Unknown user'}</CardTitle>
              <CardDescription>
                {countsSummary(payment.counts)} · {payment.amountPkr} PKR · {methodLabel(payment)}
                {payment.isUpgrade ? ' · Upgrade' : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {payment.screenshotStorageKey ? (
                <a
                  href={buildTenantApiPath(
                    subdomain,
                    `/billing/admin/payments/${payment.id}/screenshot`
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="text-body text-link underline-offset-4 hover:underline"
                >
                  View payment screenshot
                </a>
              ) : payment.nowpaymentsPaymentId ? (
                <p className="text-body text-ink-sub">
                  Crypto payment {payment.nowpaymentsPaymentId}
                  {payment.nowpaymentsPayAddress ? ` · ${payment.nowpaymentsPayAddress}` : ''}
                </p>
              ) : (
                <p className="text-body text-ink-sub">No screenshot attached.</p>
              )}
              <div className="flex gap-2">
                <Button
                  onClick={() => void decide(payment.id, 'approve')}
                  loading={busyId === payment.id}
                  disabled={busyId !== null}
                >
                  Approve payment
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void decide(payment.id, 'reject')}
                  disabled={busyId !== null}
                >
                  Reject payment
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <section aria-label="Recently decided payments" className="flex flex-col gap-4">
        <h2 className="text-lg leading-heading font-semibold text-ink">Recently decided</h2>
        {decided.length === 0 ? (
          <p className="text-body text-ink-sub">No decided payments yet.</p>
        ) : null}
        {decided.map((payment) => (
          <Card key={payment.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-body font-medium text-ink">
                  {payment.userEmail ?? 'Unknown user'}
                </span>
                <span className="text-metadata text-ink-sub">
                  {countsSummary(payment.counts)} · {payment.amountPkr} PKR · {methodLabel(payment)}
                </span>
              </div>
              {payment.status === 'approved' || payment.status === 'paid' ? (
                <BillingStatusMark kind="ok" label="Approved" />
              ) : (
                <BillingStatusMark kind="failed" label="Rejected" />
              )}
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
