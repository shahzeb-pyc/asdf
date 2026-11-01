'use client';

/**
 * Admin sellers list — sellers table, create-seller dialog, and
 * the payout-requests queue. All data comes from the typed
 * /api/tenant/[subdomain]/sellers/* routes; the page guards the
 * admin role server-side.
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SellerCreateSchema, type SellerCreateInput } from '@fbuploadpro/contracts';
import { api, getErrorMessage, isApiError } from '@/lib/api';
import {
  AdminSellersResponseSchema,
  SellerCreateResponseSchema,
  SellerOkResponseSchema,
  SellerPayoutRequestsResponseSchema,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/shared/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import { PasswordInput } from '@/components/auth/password-input';
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

function CreateSellerDialog({ subdomain }: { subdomain: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<SellerCreateInput>({
    resolver: zodResolver(SellerCreateSchema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      password: '',
      // No defaults for rate and scope: the keys are deliberately
      // ABSENT (not explicitly undefined — exactOptionalPropertyTypes
      // rejects that in RHF's DefaultValues type). RHF leaves both
      // fields undefined, the rate input renders that as empty, the
      // scope select shows its "Choose scope" placeholder, and the
      // required schema blocks submit until the admin picks both.
      // Undefined, not '': the code is optional, and the schema
      // rejects '' (min 4). The input renders undefined as empty
      // via `field.value ?? ''` below; typing then clearing also
      // converts back to undefined on change.
      referralCode: undefined,
    },
  });

  const create = useMutation({
    mutationFn: (values: SellerCreateInput) =>
      api.post(`/api/tenant/${subdomain}/sellers`, values, {
        schema: SellerCreateResponseSchema,
      }),
    onSuccess: () => {
      setServerError(null);
      setOpen(false);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sellers', subdomain] });
      toast('Seller created');
    },
    onError: (error: unknown) => {
      setServerError(
        isApiError(error)
          ? getErrorMessage(error, 'The seller could not be created right now.')
          : 'The seller could not be created right now.'
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Create seller</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create seller</DialogTitle>
          <DialogDescription>
            The seller signs in on the same login page and sees only their seller dashboard.
            Commission rate and scope have no defaults — pick both every time.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="flex flex-col gap-3"
            onSubmit={form.handleSubmit((values) =>
              create.mutate({
                ...values,
                referralCode: values.referralCode?.trim() ? values.referralCode : undefined,
              })
            )}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Seller name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input placeholder="seller@example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <PasswordInput placeholder="Set the seller's password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
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
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
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
            </div>
            <FormField
              control={form.control}
              name="referralCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial referral code (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. ALI20"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) =>
                        field.onChange(e.target.value.trim() === '' ? undefined : e.target.value)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {serverError && <p className="text-body text-signal-critical">{serverError}</p>}
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create seller'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function PayoutQueue({ subdomain }: { subdomain: string }) {
  const queryClient = useQueryClient();
  const [confirmSentId, setConfirmSentId] = useState<string | null>(null);

  const queueQuery = useQuery({
    queryKey: ['admin', 'sellers', subdomain, 'payout-requests'],
    queryFn: () =>
      api.get(`/api/tenant/${subdomain}/sellers/payout-requests`, {
        schema: SellerPayoutRequestsResponseSchema,
      }),
  });

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'mark-sent' | 'reject' }) =>
      api.post(`/api/tenant/${subdomain}/sellers/payout-requests/${id}`, { action }, {
        schema: SellerOkResponseSchema,
      }),
    onSuccess: () => {
      setConfirmSentId(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sellers', subdomain] });
      toast('Payout request updated');
    },
    onError: (error: unknown) => {
      toast('Could not update the payout request', {
        description: isApiError(error)
          ? getErrorMessage(error)
          : 'Please try again.',
      });
    },
  });

  if (queueQuery.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-label="Loading payout requests">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (queueQuery.isError || !queueQuery.data) {
    return (
      <p className="text-body text-signal-critical">
        Payout requests couldn&apos;t be loaded.{' '}
        <Button variant="link" size="sm" onClick={() => void queueQuery.refetch()}>
          Retry
        </Button>
      </p>
    );
  }

  const pending = queueQuery.data.requests.filter((r) => r.status === 'pending');
  const decided = queueQuery.data.requests.filter((r) => r.status !== 'pending');

  return (
    <div className="flex flex-col gap-4">
      {pending.length === 0 && (
        <p className="text-body text-ink-dim">No pending payout requests.</p>
      )}
      {pending.length > 0 && (
        <ul className="flex flex-col gap-2">
          {pending.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-body font-medium text-ink">
                  {r.sellerName ?? r.sellerEmail}
                </span>
                <span className="block text-metadata text-ink-dim">
                  {formatPkr(r.totalPkr)} · {r.commissionCount} commission
                  {r.commissionCount === 1 ? '' : 's'}
                  {r.payoutMethod
                    ? ` · ${r.payoutMethod === 'easypaisa' ? 'Easypaisa' : r.payoutMethod === 'nayapay' ? 'Nayapay' : r.payoutMethod === 'ubl' ? 'Bank (UBL)' : 'Binance'}: ${r.payoutAccount ?? ''}`
                    : ''}
                </span>
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
      {decided.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-body font-semibold text-ink">Decided</h3>
          <ul className="flex flex-col gap-2">
            {decided.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
              >
                <span className="text-body text-ink">
                  {r.sellerName ?? r.sellerEmail} · {formatPkr(r.totalPkr)}
                </span>
                <StatusMark
                  kind={r.status === 'paid' ? 'operational' : 'critical'}
                  label={r.status === 'paid' ? 'Paid' : 'Rejected'}
                  testId={`admin-payout-status-${r.id}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
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

export function AdminSellersList({ subdomain }: { subdomain: string }) {
  const [page, setPage] = useState(1);
  const listQuery = useQuery({
    queryKey: ['admin', 'sellers', subdomain, page],
    queryFn: () =>
      api.get(`/api/tenant/${subdomain}/sellers?page=${page}`, {
        schema: AdminSellersResponseSchema,
      }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle>Sellers</CardTitle>
            <CardDescription>
              Resellers who earn commission on referred signups. Deleting a seller is blocked
              until every commission is paid out.
            </CardDescription>
          </div>
          <CreateSellerDialog subdomain={subdomain} />
        </CardHeader>
        <CardContent>
          {listQuery.isPending && (
            <div className="flex flex-col gap-2" aria-label="Loading sellers">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {listQuery.isError && (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t load sellers</AlertTitle>
              <AlertDescription>
                <Button variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {listQuery.data && listQuery.data.sellers.length === 0 && (
            <p className="text-body text-ink-dim">
              No sellers yet. Create one to start tracking referrals.
            </p>
          )}
          {listQuery.data && listQuery.data.sellers.length > 0 && (
            <ul className="flex flex-col gap-2">
              {listQuery.data.sellers.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/tenant/${subdomain}/sellers/${s.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 hover:border-link"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-body font-medium text-ink">
                        {s.name ?? s.email}
                      </span>
                      <span className="block truncate text-metadata text-ink-dim">
                        {s.email}
                        {s.currentCode ? ` · Code ${s.currentCode}` : ''}
                        {` · ${s.rate}% · ${s.scope === 'one-time' ? 'First purchase only' : 'Every purchase'}`}
                        {` · ${s.signups} signups · ${s.purchasers} purchasers`}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-body text-ink">
                        Payable {formatPkr(s.payablePkr)}
                      </span>
                      <StatusMark
                        kind={s.status === 'active' ? 'operational' : 'queued'}
                        label={s.status === 'active' ? 'Active' : 'Paused'}
                        testId={`admin-seller-status-${s.id}`}
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {listQuery.data && listQuery.data.total > 20 && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-metadata text-ink-dim">
                Page {page} of {Math.ceil(listQuery.data.total / 20)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= Math.ceil(listQuery.data.total / 20)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payout requests</CardTitle>
          <CardDescription>
            Sellers request payout of their payable commissions. Pay outside the app, then mark
            the batch as sent. Rejecting returns the commissions to payable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PayoutQueue subdomain={subdomain} />
        </CardContent>
      </Card>
    </div>
  );
}
