'use client';

/**
 * Admin seller detail — profile, rate/scope/status editing, pause,
 * delete (blocked while any commission is unpaid), commissions,
 * payout history, and referrals. Delete and mark-sent both ask
 * first: delete is destructive, mark-sent records money paid
 * outside the app.
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SellerPatchSchema, type SellerPatch } from '@fbuploadpro/contracts';
import { api, getErrorMessage, isApiError } from '@/lib/api';
import {
  AdminSellerDetailResponseSchema,
  SellerOkResponseSchema,
} from '@/lib/api/schemas/sellers';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
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
import { toast } from '@/components/shared/ui/toast';

function formatPkr(amount: number): string {
  return `PKR ${amount.toLocaleString('en-PK')}`;
}

function commissionStatusMark(status: string): { kind: 'operational' | 'queued' | 'critical'; label: string } {
  switch (status) {
    case 'payable':
      return { kind: 'operational', label: 'Payable' };
    case 'requested':
      return { kind: 'queued', label: 'Requested' };
    case 'paid':
      return { kind: 'operational', label: 'Paid' };
    case 'cancelled':
      return { kind: 'critical', label: 'Cancelled' };
    default:
      return { kind: 'queued', label: 'Pending' };
  }
}

export function AdminSellerDetail({
  sellerId,
}: {
  sellerId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSentId, setConfirmSentId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['admin', 'sellers', sellerId],
    queryFn: () =>
      api.get(`/api/admin/sellers/${sellerId}`, {
        schema: AdminSellerDetailResponseSchema,
      }),
  });

  const form = useForm<SellerPatch>({
    resolver: zodResolver(SellerPatchSchema),
    mode: 'onTouched',
    // Memoized: the object identity must only change when the
    // loaded data changes — an inline literal would reset the
    // form on every keystroke re-render, making the fields
    // uneditable. The placeholder never renders (the pending
    // branch returns before the form JSX).
    values: React.useMemo(
      () =>
        detailQuery.data
          ? {
              rate: detailQuery.data.seller.rate,
              scope: detailQuery.data.seller.scope,
              status: detailQuery.data.seller.status === 'paused' ? 'paused' : 'active',
            }
          : { rate: 20, scope: 'every' as const, status: 'active' as const },
      [detailQuery.data]
    ),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'sellers'] });
  };

  const update = useMutation({
    mutationFn: (values: SellerPatch) =>
      api.patch(`/api/admin/sellers/${sellerId}`, values, {
        schema: SellerOkResponseSchema,
      }),
    onSuccess: () => {
      setEditError(null);
      invalidate();
      toast('Seller updated');
    },
    onError: (error: unknown) => {
      setEditError(
        isApiError(error)
          ? getErrorMessage(error, 'The seller could not be updated right now.')
          : 'The seller could not be updated right now.'
      );
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      api.delete(`/api/admin/sellers/${sellerId}`, {
        schema: SellerOkResponseSchema,
      }),
    onSuccess: () => {
      setConfirmDelete(false);
      invalidate();
      toast('Seller deleted');
      router.push('/admin/sellers');
    },
    onError: (error: unknown) => {
      setConfirmDelete(false);
      setDeleteError(
        isApiError(error)
          ? getErrorMessage(error, 'The seller could not be deleted right now.')
          : 'The seller could not be deleted right now.'
      );
    },
  });

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'mark-sent' | 'reject' }) =>
      api.post(`/api/admin/sellers/payout-requests/${id}`, { action }, {
        schema: SellerOkResponseSchema,
      }),
    onSuccess: () => {
      setConfirmSentId(null);
      invalidate();
      toast('Payout request updated');
    },
    onError: (error: unknown) => {
      toast('Could not update the payout request', {
        description: isApiError(error) ? getErrorMessage(error) : 'Please try again.',
      });
    },
  });

  if (detailQuery.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-label="Loading seller details">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load this seller</AlertTitle>
        <AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { seller, codes, balances, commissions, payoutRequests, referredUsers, referredTotal } =
    detailQuery.data;
  const oldCodes = codes.filter((c) => !c.current);
  const pendingRequests = payoutRequests.filter((r) => r.status === 'pending');
  const decidedRequests = payoutRequests.filter((r) => r.status !== 'pending');
  const unpaidExists =
    balances.pending > 0 || balances.payable > 0 || balances.requested > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{seller.name ?? seller.email}</CardTitle>
          <CardDescription>
            {seller.email}
            {seller.currentCode ? ` · Referral code ${seller.currentCode}` : ' · No referral code yet'}
            {` · ${referredTotal} signups · ${seller.purchasers} purchasers`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Pending</dt>
              <dd className="text-body font-semibold text-ink">{formatPkr(balances.pending)}</dd>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Payable</dt>
              <dd className="text-body font-semibold text-ink">{formatPkr(balances.payable)}</dd>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Requested</dt>
              <dd className="text-body font-semibold text-ink">{formatPkr(balances.requested)}</dd>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <dt className="text-metadata text-ink-dim">Paid</dt>
              <dd className="text-body font-semibold text-ink">{formatPkr(balances.paid)}</dd>
            </div>
          </dl>
          {oldCodes.length > 0 && (
            <p className="text-metadata text-ink-dim">
              Old codes still valid: {oldCodes.map((c) => c.code).join(', ')}
            </p>
          )}
          <Form {...form}>
            <form
              className="flex flex-col gap-3"
              onSubmit={form.handleSubmit((values) => update.mutate(values))}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="rate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Commission %</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          inputMode="numeric"
                          {...field}
                          value={field.value ?? ''}
                          onChange={(e) =>
                            field.onChange(e.target.value === '' ? undefined : Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="scope"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scope</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose scope" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="one-time">First purchase only</SelectItem>
                          <SelectItem value="every">Every purchase</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="paused">Paused</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <p className="text-metadata text-ink-dim">
                Rate, scope, and pause changes apply to future purchases only. Commissions already
                recorded keep the rate and scope they were created with.
              </p>
              {editError && <p className="text-body text-signal-critical">{editError}</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending ? 'Saving…' : 'Save changes'}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={unpaidExists}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete seller
                </Button>
              </div>
              {unpaidExists && (
                <p className="text-body text-ink-dim">
                  Delete is blocked until every commission is paid out — pending commissions must
                  mature and be paid first.
                </p>
              )}
              {deleteError && <p className="text-body text-signal-critical">{deleteError}</p>}
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Commissions</CardTitle>
          <CardDescription>Newest first, up to 100 shown.</CardDescription>
        </CardHeader>
        <CardContent>
          {commissions.length === 0 && (
            <p className="text-body text-ink-dim">No commissions yet.</p>
          )}
          {commissions.length > 0 && (
            <ul className="flex flex-col gap-2">
              {commissions.map((c) => {
                const mark = commissionStatusMark(c.status);
                return (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-body font-medium text-ink">
                        {c.buyerName ?? c.buyerEmail}
                      </span>
                      <span className="block text-metadata text-ink-dim">
                        {c.rate}% · {c.scope === 'one-time' ? 'First purchase only' : 'Every purchase'}
                        {` · ${formatPkr(c.amountPkr)}`}
                      </span>
                    </span>
                    <StatusMark
                      kind={mark.kind}
                      label={mark.label}
                      testId={`admin-commission-status-${c.id}`}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payout history</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {payoutRequests.length === 0 && (
            <p className="text-body text-ink-dim">No payout requests yet.</p>
          )}
          {pendingRequests.length > 0 && (
            <ul className="flex flex-col gap-2">
              {pendingRequests.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-body text-ink">
                    {formatPkr(r.totalPkr)} · {r.commissionCount} commission
                    {r.commissionCount === 1 ? '' : 's'}
                    {r.payoutMethod
                      ? ` · ${r.payoutMethod === 'easypaisa' ? 'Easypaisa' : r.payoutMethod === 'nayapay' ? 'Nayapay' : r.payoutMethod === 'ubl' ? 'Bank (UBL)' : 'Binance'}: ${r.payoutAccount ?? ''}`
                      : ''}
                  </span>
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => setConfirmSentId(r.id)}
                      disabled={decide.isPending}
                    >
                      Mark as sent
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decide.mutate({ id: r.id, action: 'reject' })}
                      disabled={decide.isPending}
                    >
                      Reject
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {decidedRequests.length > 0 && (
            <ul className="flex flex-col gap-2">
              {decidedRequests.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-body text-ink">
                    {formatPkr(r.totalPkr)} · {r.commissionCount} commission
                    {r.commissionCount === 1 ? '' : 's'}
                  </span>
                  <StatusMark
                    kind={r.status === 'paid' ? 'operational' : 'critical'}
                    label={r.status === 'paid' ? 'Paid' : 'Rejected'}
                    testId={`admin-payout-status-${r.id}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Referrals</CardTitle>
          <CardDescription>{referredTotal} signups in total.</CardDescription>
        </CardHeader>
        <CardContent>
          {referredUsers.length === 0 && (
            <p className="text-body text-ink-dim">No signups yet.</p>
          )}
          {referredUsers.length > 0 && (
            <ul className="flex flex-col gap-2">
              {referredUsers.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium text-ink">
                      {u.name ?? u.email}
                    </span>
                    <span className="block truncate text-metadata text-ink-dim">
                      {u.email}
                      {u.referralCode ? ` · Code ${u.referralCode}` : ''}
                    </span>
                  </span>
                  <StatusMark
                    kind={u.purchased ? 'operational' : 'idle'}
                    label={u.purchased ? 'Purchased' : 'Not purchased yet'}
                    testId={`admin-referral-purchased-${u.id}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this seller?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the seller account, their referral codes, and their settings. Past
              commissions stay recorded. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Delete seller</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmSentId !== null} onOpenChange={(open) => !open && setConfirmSentId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this payout as sent?</AlertDialogTitle>
            <AlertDialogDescription>
              Only confirm after you have actually paid the seller outside the app. This marks
              the whole batch as paid and cannot be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmSentId && decide.mutate({ id: confirmSentId, action: 'mark-sent' })
              }
            >
              Yes, I paid it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
