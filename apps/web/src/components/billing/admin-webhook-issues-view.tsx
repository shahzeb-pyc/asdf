'use client';

import * as React from 'react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  WebhookIssuesResponseSchema,
  type WebhookIssuesResponse,
} from '@/lib/api/schemas/billing';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent } from '@/components/shared/ui/card';
import { Skeleton } from '@/components/shared/ui/skeleton';

function reasonLabel(reason: WebhookIssuesResponse['issues'][number]['reason']): string {
  if (reason === 'unknown_payment') return 'Unknown payment';
  if (reason === 'amount_mismatch') return 'Amount does not match the payment';
  if (reason === 'currency_mismatch') return 'Currency does not match the payment';
  if (reason === 'underpaid') return 'Underpaid — held for admin decision';
  if (reason === 'coupon_released_before_finish') return 'Coupon released before payment finished';
  return 'Refunded after activation — period revoked';
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

/**
 * Admin-visible webhook issues (audit fix 2026-11-01, fix 22).
 * The crypto webhook never swallows a problem silently: unknown,
 * mismatched, underpaid, and refunded payments land here instead
 * of a dedupe row that could swallow a later real payment. An
 * issue stays open until dismissed; dismissing frees the slot, so
 * a later event for the same key can raise a fresh issue. When
 * the issues table migration is unapplied, the route returns an
 * empty list and this section renders nothing.
 */
export function AdminWebhookIssuesView({ subdomain }: Readonly<{ subdomain: string }>) {
  const [data, setData] = React.useState<WebhookIssuesResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing/admin/webhook-issues'), {
        schema: WebhookIssuesResponseSchema,
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

  async function dismiss(issueId: string) {
    setBusyId(issueId);
    setNotice(null);
    try {
      await apiPost(buildTenantApiPath(subdomain, '/billing/admin/webhook-issues'), { issueId });
      setNotice('Dismissed.');
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (error && !data) return null;
  if (!data) {
    return (
      <section aria-label="Webhook issues" className="flex flex-col gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-10 w-full" />
      </section>
    );
  }
  // Defensive: a malformed payload must never crash the whole admin
  // page — the section hides instead. (The schema-validated fetch
  // guarantees the shape in production; a loose mock or a future
  // shape drift degrades to hidden, not to a white page.)
  const issues = Array.isArray(data.issues) ? data.issues : [];
  if (issues.length === 0) return null;

  return (
    <section aria-label="Webhook issues" className="flex flex-col gap-4">
      <h2 className="text-lg leading-heading font-semibold text-ink">
        Webhook issues ({issues.length})
      </h2>
      <p className="text-body text-ink-sub">
        Crypto payments the automatic confirmation could not activate. Check each one
        manually — the user&apos;s plan is not started until you act on the payment itself.
      </p>
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
      {issues.map((issue) => (
        <Card key={issue.id}>
          <CardContent className="flex flex-col gap-4 py-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-body font-medium text-ink">{reasonLabel(issue.reason)}</span>
              <span className="break-all text-metadata text-ink-sub">
                {issue.provider} payment {issue.providerPaymentId} · {formatDate(issue.createdAt)}
                {issue.detail ? ` · ${issue.detail}` : ''}
              </span>
            </div>
            <div>
              <Button
                variant="outline"
                onClick={() => void dismiss(issue.id)}
                loading={busyId === issue.id}
                disabled={busyId !== null}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
