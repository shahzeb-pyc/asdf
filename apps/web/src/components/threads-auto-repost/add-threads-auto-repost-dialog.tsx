'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { ListThreadsAccountsResponseSchema } from '@fbuploadpro/contracts';
import { CreateMirrorResponseSchema } from '@/lib/api/schemas/threads-auto-repost';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Input } from '@/components/shared/ui/input';
import { toast } from '@/components/shared/ui/toast';

/**
 * Add Threads Auto Repost dialog — two steps, no page discovery:
 * Threads has no pages, so the target IS the connected Threads
 * account itself.
 *
 * Flow: pick a connected Threads account → enter a TikTok username
 * → Add. On Add the server verifies the username's feed with
 * tikwmapi; a feed that cannot be fetched shows an inline error and
 * creates nothing. Only active accounts are selectable: an expired
 * account must be reconnected in Accounts first (the dialog says so
 * plainly instead of offering a second connect flow here).
 *
 * Deliberately different from Facebook's Add dialog: no page step,
 * no timezone or posting-times steps (Auto Repost has no schedule),
 * and nothing is added to Schedule — the mirror targets the account
 * directly, and Schedule stays a separate section the user manages.
 */

type AddStep = 'select-account' | 'username';

export interface AddThreadsAutoRepostDialogProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: ((mirrorId: string) => void) | undefined;
}

export function AddThreadsAutoRepostDialog({
  subdomain,
  open,
  onOpenChange,
  onSuccess,
}: Readonly<AddThreadsAutoRepostDialogProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);

  const [step, setStep] = React.useState<AddStep>('select-account');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [username, setUsername] = React.useState('');
  const [inlineError, setInlineError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    setStep('select-account');
    setAccountId(null);
    setUsername('');
    setInlineError(null);
  }, []);

  const accountsQuery = useQuery({
    queryKey: tenant.threadsAccounts.list,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/threads/accounts'), {
        schema: ListThreadsAccountsResponseSchema,
        signal,
      }),
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const account = accountsQuery.data?.accounts.find((a) => a.id === accountId);
      return api.post(
        buildTenantApiPath(subdomain, '/threads/auto-repost'),
        {
          accountId,
          targetExternalId: account?.threadsAccountId,
          sourceUsername: username,
        },
        { schema: CreateMirrorResponseSchema }
      );
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: tenant.threadsAutoRepost.list });
      const immediate = data.immediatePost;
      if (immediate?.attempted && immediate.status === 'pending') {
        toast.warning(
          'Auto Repost added, but the latest reel could not be posted yet — it stays pending and the mirror shows an error.'
        );
      } else if (immediate?.attempted && immediate.status === 'skipped') {
        toast.warning(
          'Auto Repost added, but the latest reel was skipped — its caption is too long for Threads.'
        );
      } else {
        toast.success('Auto Repost added');
      }
      onSuccess?.(data.mirror.id);
      reset();
      onOpenChange(false);
    },
    onError: (error) => {
      if (isApiError(error) && error.kind === 'http') {
        if (error.code === 'DUPLICATE_MIRROR') {
          setInlineError('This TikTok account is already reposted to this Threads account.');
          return;
        }
        if (error.code === 'TIKTOK_FEED_UNAVAILABLE') {
          setInlineError(
            error.message ||
              "Could not fetch that TikTok account's feed. Check the username and try again."
          );
          return;
        }
        if (error.code === 'THREADS_TARGET_NOT_READY') {
          setInlineError('That Threads account is not ready for posting. Reconnect it in Accounts.');
          return;
        }
      }
      setInlineError('Could not add this mirror. Please try again.');
    },
  });

  const accounts = accountsQuery.data?.accounts ?? [];
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;
  const normalizedUsername = username.trim().replace(/^@+/, '');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="threads-add-mirror-dialog">
        <DialogHeader>
          <DialogTitle>
            {step === 'select-account' ? 'Choose a Threads account' : 'Add a TikTok account'}
          </DialogTitle>
          <DialogDescription>
            {step === 'select-account'
              ? 'Every new reel from the TikTok account will be reposted to this Threads account automatically.'
              : `Reposting to ${selectedAccount?.displayName ?? 'your Threads account'}.`}
          </DialogDescription>
        </DialogHeader>

        {step === 'select-account' ? (
          <div className="flex flex-col gap-2">
            {accountsQuery.isPending ? (
              <p className="text-body text-ink-sub">Loading your Threads accounts…</p>
            ) : accountsQuery.isError ? (
              <p role="alert" className="text-body text-signal-critical">
                Couldn&apos;t load your Threads accounts. Please try again.
              </p>
            ) : accounts.length === 0 ? (
              <p className="text-body text-ink-sub">
                No Threads accounts connected yet. Connect one in Accounts first.
              </p>
            ) : (
              accounts.map((account) => {
                const selectable = account.status === 'active';
                return (
                  <button
                    key={account.id}
                    type="button"
                    disabled={!selectable}
                    onClick={() => {
                      setAccountId(account.id);
                      setInlineError(null);
                      setStep('username');
                    }}
                    className="w-full rounded-md border border-line bg-panel p-3 text-left disabled:opacity-50"
                  >
                    <span className="block truncate text-body font-bold text-ink">
                      {account.displayName}
                    </span>
                    <span className="block truncate text-metadata text-ink-sub">
                      {account.handle ? `@${account.handle}` : 'Threads account'}
                      {!selectable ? ' · Reconnect this account in Accounts to use it' : ''}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                setStep('select-account');
                setInlineError(null);
              }}
              className="flex w-fit items-center gap-1 text-metadata text-link"
            >
              <ArrowLeftIcon aria-hidden className="size-4" />
              <span>Back to accounts</span>
            </button>
            <label htmlFor="threads-mirror-username" className="text-body font-bold text-ink">
              TikTok username
            </label>
            <Input
              id="threads-mirror-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="username (without @)"
              autoFocus
            />
            {inlineError ? (
              <p role="alert" className="text-body text-signal-critical">
                {inlineError}
              </p>
            ) : null}
          </div>
        )}

        {step === 'username' ? (
          <DialogFooter>
            <Button
              type="button"
              disabled={!normalizedUsername || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Adding…' : 'Add Auto Repost'}
            </Button>
          </DialogFooter>
        ) : null}
        {step === 'select-account' && inlineError ? (
          <p role="alert" className="text-body text-signal-critical">
            {inlineError}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
