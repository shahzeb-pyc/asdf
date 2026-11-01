'use client';

/**
 * Seller dashboard — the seller's only surface: referral link,
 * signups/purchasers, commission balances, payout details and
 * payout requests. All data comes from the typed /api/seller/*
 * routes; the layout already guarantees an active seller session.
 */

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ReferralCodeSchema, SellerPayoutDetailsSchema } from '@fbuploadpro/contracts';
import { api, getErrorMessage, isApiError } from '@/lib/api';
import {
  SellerDashboardResponseSchema,
  SellerPayoutRequestsResponseSchema,
  SellerReferredUsersResponseSchema,
  SellerCodeResponseSchema,
  SellerOkResponseSchema,
  SellerPayoutRequestCreatedSchema,
  type SellerDashboardResponse,
} from '@/lib/api/schemas/sellers';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { StatusMark } from '@/components/shared/ui/status-mark';

function formatPkr(amount: number): string {
  return `PKR ${amount.toLocaleString('en-PK')}`;
}

function scopeLabel(scope: 'one-time' | 'every'): string {
  return scope === 'one-time' ? 'First purchase only' : 'Every purchase';
}

function methodLabel(method: 'easypaisa' | 'nayapay' | 'ubl' | 'binance'): string {
  return method === 'easypaisa'
    ? 'Easypaisa'
    : method === 'nayapay'
      ? 'Nayapay'
      : method === 'ubl'
        ? 'Bank (UBL)'
        : 'Binance';
}

const CodeChangeFormSchema = z.object({ code: ReferralCodeSchema });
type CodeChangeFormValues = z.infer<typeof CodeChangeFormSchema>;

function ReferralSection({ dashboard }: { dashboard: SellerDashboardResponse }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSuccess, setCodeSuccess] = useState(false);

  const form = useForm<CodeChangeFormValues>({
    resolver: zodResolver(CodeChangeFormSchema),
    mode: 'onTouched',
    defaultValues: { code: '' },
  });

  const changeCode = useMutation({
    mutationFn: (code: string) =>
      api.post('/api/seller/referral-code', { code }, { schema: SellerCodeResponseSchema }),
    onSuccess: () => {
      setCodeError(null);
      setCodeSuccess(true);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['seller', 'dashboard'] });
    },
    onError: (error: unknown) => {
      setCodeSuccess(false);
      setCodeError(
        isApiError(error)
          ? getErrorMessage(error, 'The referral code could not be changed right now.')
          : 'The referral code could not be changed right now.'
      );
    },
  });

  const oldCodes = dashboard.codes.filter((c) => !c.current);

  const handleCopy = async () => {
    if (!dashboard.referralLink) return;
    try {
      await navigator.clipboard.writeText(dashboard.referralLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your referral link</CardTitle>
        <CardDescription>
          Share this link — anyone who signs up through it is linked to you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {dashboard.referralLink ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input readOnly value={dashboard.referralLink} aria-label="Referral link" />
            <Button type="button" variant="outline" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        ) : (
          <p className="text-body text-ink-dim">
            You don&apos;t have a referral code yet. Set one below to get your link.
          </p>
        )}
        {oldCodes.length > 0 && (
          <p className="text-metadata text-ink-dim">
            Old codes still work: {oldCodes.map((c) => c.code).join(', ')} — anyone who signed up
            with them stays linked to you.
          </p>
        )}
        <Form {...form}>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={form.handleSubmit((values) => changeCode.mutate(values.code))}
          >
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>{dashboard.currentCode ? 'Change referral code' : 'Set referral code'}</FormLabel>
                  <FormControl>
                    <Input placeholder={dashboard.currentCode ?? 'e.g. ALI20'} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={changeCode.isPending}>
              {changeCode.isPending ? 'Saving…' : dashboard.currentCode ? 'Change code' : 'Set code'}
            </Button>
          </form>
        </Form>
        {codeError && <p className="text-body text-signal-critical">{codeError}</p>}
        {codeSuccess && (
          <p className="text-body text-signal-operational">Referral code updated.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PayoutSection({ dashboard }: { dashboard: SellerDashboardResponse }) {
  const queryClient = useQueryClient();
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsSaved, setDetailsSaved] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const requestsQuery = useQuery({
    queryKey: ['seller', 'payout-requests'],
    queryFn: () =>
      api.get('/api/seller/payout-requests', { schema: SellerPayoutRequestsResponseSchema }),
  });

  const detailsForm = useForm<z.infer<typeof SellerPayoutDetailsSchema>>({
    resolver: zodResolver(SellerPayoutDetailsSchema),
    mode: 'onTouched',
    defaultValues: {
      method: dashboard.payoutDetails?.method ?? 'easypaisa',
      accountLabel: dashboard.payoutDetails?.accountLabel ?? '',
    },
  });

  const saveDetails = useMutation({
    mutationFn: (values: z.infer<typeof SellerPayoutDetailsSchema>) =>
      api.put('/api/seller/payout-details', values, { schema: SellerOkResponseSchema }),
    onSuccess: () => {
      setDetailsError(null);
      setDetailsSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['seller', 'dashboard'] });
    },
    onError: (error: unknown) => {
      setDetailsSaved(false);
      setDetailsError(
        isApiError(error)
          ? getErrorMessage(error, 'Payout details could not be saved right now.')
          : 'Payout details could not be saved right now.'
      );
    },
  });

  const requestPayout = useMutation({
    mutationFn: () =>
      api.post('/api/seller/payout-requests', {}, { schema: SellerPayoutRequestCreatedSchema }),
    onSuccess: () => {
      setRequestError(null);
      void queryClient.invalidateQueries({ queryKey: ['seller', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['seller', 'payout-requests'] });
    },
    onError: (error: unknown) => {
      setRequestError(
        isApiError(error)
          ? getErrorMessage(error, 'The payout request could not be created right now.')
          : 'The payout request could not be created right now.'
      );
    },
  });

  const payable = dashboard.balances.payable;
  const shortfall = Math.max(0, 1000 - payable);
  const canRequest = payable >= 1000 && dashboard.payoutDetails !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payout</CardTitle>
        <CardDescription>
          Request payout of everything currently payable. Payouts are paid outside the app.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Form {...detailsForm}>
          <form
            className="flex flex-col gap-3"
            onSubmit={detailsForm.handleSubmit((values) => saveDetails.mutate(values))}
          >
            <FormField
              control={detailsForm.control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Payout method</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a payout method" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="easypaisa">Easypaisa</SelectItem>
                      <SelectItem value="nayapay">Nayapay</SelectItem>
                      <SelectItem value="ubl">Bank (UBL)</SelectItem>
                      <SelectItem value="binance">Binance</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={detailsForm.control}
              name="accountLabel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Easypaisa/Nayapay number, bank account / IBAN, or Binance ID"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div>
              <Button type="submit" disabled={saveDetails.isPending}>
                {saveDetails.isPending ? 'Saving…' : 'Save payout details'}
              </Button>
            </div>
          </form>
        </Form>
        {detailsError && <p className="text-body text-signal-critical">{detailsError}</p>}
        {detailsSaved && (
          <p className="text-body text-signal-operational">Payout details saved.</p>
        )}
        {dashboard.payoutDetails && !detailsSaved && (
          <p className="text-body text-ink-dim">
            Saved payout method: {methodLabel(dashboard.payoutDetails.method)} ·{' '}
            {dashboard.payoutDetails.accountLabel}
          </p>
        )}
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <p className="text-body text-ink">
            Payable now: <strong>{formatPkr(payable)}</strong>
          </p>
          {shortfall > 0 && (
            <p className="text-body text-ink-dim">
              You need {formatPkr(shortfall)} more to request a payout (minimum PKR 1,000).
            </p>
          )}
          {dashboard.payoutDetails === null && (
            <p className="text-body text-ink-dim">
              Add your payout details above before requesting a payout.
            </p>
          )}
          <div>
            <Button
              type="button"
              disabled={!canRequest || requestPayout.isPending}
              onClick={() => requestPayout.mutate()}
            >
              {requestPayout.isPending ? 'Requesting…' : 'Request payout'}
            </Button>
          </div>
          {requestError && <p className="text-body text-signal-critical">{requestError}</p>}
        </div>
        {requestsQuery.data && requestsQuery.data.requests.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className="text-body font-semibold text-ink">Payout requests</h3>
            <ul className="flex flex-col gap-2">
              {requestsQuery.data.requests.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-body text-ink">
                    {formatPkr(r.totalPkr)} · {r.commissionCount} commission
                    {r.commissionCount === 1 ? '' : 's'}
                  </span>
                  <StatusMark
                    kind={
                      r.status === 'paid'
                        ? 'operational'
                        : r.status === 'rejected'
                          ? 'critical'
                          : 'queued'
                    }
                    label={
                      r.status === 'paid'
                        ? 'Paid'
                        : r.status === 'rejected'
                          ? 'Rejected'
                          : 'Pending'
                    }
                    testId={`payout-request-status-${r.id}`}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SellerDashboard() {
  const dashboardQuery = useQuery({
    queryKey: ['seller', 'dashboard'],
    queryFn: () => api.get('/api/seller/dashboard', { schema: SellerDashboardResponseSchema }),
  });
  const referralsQuery = useQuery({
    queryKey: ['seller', 'referrals'],
    queryFn: () =>
      api.get('/api/seller/referrals?limit=50', { schema: SellerReferredUsersResponseSchema }),
  });

  if (dashboardQuery.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-label="Loading seller dashboard">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (dashboardQuery.isError || !dashboardQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load your dashboard</AlertTitle>
        <AlertDescription>
          <span className="mb-2 block">Please try again.</span>
          <Button variant="outline" size="sm" onClick={() => void dashboardQuery.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const dashboard = dashboardQuery.data;

  return (
    <div className="flex flex-col gap-4">
      {dashboard.status === 'paused' && (
        <Alert variant="warning">
          <AlertTitle>Your account is paused</AlertTitle>
          <AlertDescription>
            New signups and new commissions are frozen while paused. Your existing balances stay
            payable.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Commission</CardTitle>
          <CardDescription>
            {dashboard.rate}% · {scopeLabel(dashboard.scope)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Pending</dt>
              <dd className="text-body font-semibold text-ink">
                {formatPkr(dashboard.balances.pending)}
              </dd>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Payable</dt>
              <dd className="text-body font-semibold text-ink">
                {formatPkr(dashboard.balances.payable)}
              </dd>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Requested</dt>
              <dd className="text-body font-semibold text-ink">
                {formatPkr(dashboard.balances.requested)}
              </dd>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Paid</dt>
              <dd className="text-body font-semibold text-ink">
                {formatPkr(dashboard.balances.paid)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-metadata text-ink-dim">
            Commissions become payable 10 days after the buyer&apos;s plan starts, once any refund
            request on that payment is resolved.
          </p>
        </CardContent>
      </Card>

      <ReferralSection dashboard={dashboard} />
      <PayoutSection dashboard={dashboard} />

      <Card>
        <CardHeader>
          <CardTitle>Referrals</CardTitle>
          <CardDescription>
            {dashboard.signups} signups · {dashboard.purchasers} purchasers
          </CardDescription>
        </CardHeader>
        <CardContent>
          {referralsQuery.isPending && (
            <div className="flex flex-col gap-2" aria-label="Loading referrals">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {referralsQuery.isError && (
            <p className="text-body text-signal-critical">
              Referrals couldn&apos;t be loaded.{' '}
              <Button variant="link" size="sm" onClick={() => void referralsQuery.refetch()}>
                Retry
              </Button>
            </p>
          )}
          {referralsQuery.data && referralsQuery.data.users.length === 0 && (
            <p className="text-body text-ink-dim">
              No signups yet. Share your referral link to get started.
            </p>
          )}
          {referralsQuery.data && referralsQuery.data.users.length > 0 && (
            <ul className="flex flex-col gap-2">
              {referralsQuery.data.users.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium text-ink">
                      {u.name ?? u.email}
                    </span>
                    <span className="block truncate text-metadata text-ink-dim">{u.email}</span>
                  </span>
                  <StatusMark
                    kind={u.purchased ? 'operational' : 'idle'}
                    label={u.purchased ? 'Purchased' : 'Not purchased yet'}
                    testId={`referral-purchased-${u.id}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
