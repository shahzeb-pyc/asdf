'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';
import Image from 'next/image';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  ListInstagramAccountsResponseSchema,
  type InstagramAccountView,
} from '@fbuploadpro/contracts';
import { CreateMirrorResponseSchema } from '@/lib/api/schemas/tiktok-mirrors';
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
 * Add Instagram Auto Repost dialog — the Facebook Add Auto Repost
 * flow's shape with the target swapped: pick one Instagram account,
 * then enter a TikTok username, then Connect. There is deliberately
 * no page-discovery step: an Instagram account IS its destination,
 * so nothing further needs choosing. No timezone or posting-times
 * steps either (Auto Repost has no schedule). Expired or disconnected
 * accounts are shown disabled — reconnect them in Accounts first —
 * because the server refuses non-active accounts loudly.
 *
 * On Connect the server verifies the username's feed, then posts
 * the account's latest reel right away; a feed that cannot be
 * fetched shows an inline error and creates nothing.
 */

type AddStep = 'select-account' | 'username';

export interface IgAddMirrorDialogProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: ((mirrorId: string) => void) | undefined;
}

export function IgAddMirrorDialog({
  subdomain,
  open,
  onOpenChange,
  onSuccess,
}: Readonly<IgAddMirrorDialogProps>) {
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
    queryKey: tenant.instagramAutoRepost.list,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/instagram/accounts'), {
        schema: ListInstagramAccountsResponseSchema,
        signal,
      }),
    enabled: open,
  });

  const accounts = accountsQuery.data?.accounts ?? [];
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;

  const createMutation = useMutation({
    mutationFn: () =>
      api.post(
        buildTenantApiPath(subdomain, '/tiktok-mirrors'),
        {
          accountId,
          targetExternalId: selectedAccount?.externalAccountId,
          targetPlatform: 'instagram',
          sourceUsername: username,
        },
        { schema: CreateMirrorResponseSchema }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: tenant.instagramAutoRepost.list });
      const immediate = data.immediatePost;
      if (immediate?.attempted && immediate.status === 'pending') {
        toast.warning(
          'Auto Repost added, but the latest reel could not be posted yet — it stays pending and the mirror shows an error.'
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
          setInlineError('This TikTok account is already reposted to this Instagram account.');
          return;
        }
        if (error.code === 'TIKTOK_FEED_UNAVAILABLE') {
          setInlineError(
            error.message ||
              "Could not fetch that TikTok account's feed. Check the username and try again."
          );
          return;
        }
        if (error.code === 'ACCOUNT_EXPIRED') {
          setInlineError('This Instagram account is expired. Reconnect it in Accounts and try again.');
          return;
        }
      }
      setInlineError('Could not add this mirror. Please try again.');
    },
  });

  const handleSelectAccount = (account: InstagramAccountView) => {
    setAccountId(account.id);
    setInlineError(null);
    setStep('username');
  };

  const handleBackToAccounts = () => {
    setStep('select-account');
    setAccountId(null);
    setInlineError(null);
  };

  const canConnect =
    accountId !== null &&
    selectedAccount !== null &&
    username.trim().length > 0 &&
    !createMutation.isPending;

  const headerTitle =
    step === 'select-account' ? 'Select an Instagram Account' : 'Add Auto Repost';
  const headerSubtitle =
    step === 'select-account'
      ? 'Pick the Instagram account that will receive the reels.'
      : 'Enter the TikTok username to repost. Every new reel from this account will be posted to the Instagram account as a reel.';

  const displayError = inlineError ?? (accountsQuery.isError ? "Couldn't load your Instagram accounts. Please try again." : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-135" data-testid="ig-add-mirror-dialog">
        <DialogHeader>
          <div className="flex items-start gap-2">
            {step === 'username' && (
              <button
                type="button"
                data-testid="ig-add-mirror-back-to-accounts"
                onClick={handleBackToAccounts}
                aria-label="Back to account selection"
                className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xs text-ink-sub outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
              >
                <ArrowLeftIcon className="size-4" aria-hidden />
              </button>
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle>{headerTitle}</DialogTitle>
              <DialogDescription>{headerSubtitle}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div>
          {displayError && (
            <div
              data-testid="ig-add-mirror-error"
              role="alert"
              className="mb-4 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2 text-body text-signal-critical-on-tint"
            >
              {displayError}
            </div>
          )}

          {step === 'select-account' && (
            <div className="flex flex-col gap-2">
              {accountsQuery.isPending && (
                <div
                  data-testid="ig-add-mirror-loading-state"
                  className="p-6 text-center text-body text-ink-sub"
                >
                  Loading Instagram accounts...
                </div>
              )}
              {!accountsQuery.isPending && !accountsQuery.isError && accounts.length === 0 && (
                <div
                  data-testid="ig-add-mirror-no-accounts-state"
                  className="p-6 text-center text-body text-ink-sub"
                >
                  No Instagram accounts connected yet. Connect one in Accounts first.
                </div>
              )}
              {!accountsQuery.isPending && !accountsQuery.isError && accounts.length > 0 && (
                <div
                  data-testid="ig-add-mirror-accounts-list"
                  className="flex max-h-85 flex-col overflow-y-auto border-t border-line"
                >
                  {accounts.map((account) => {
                    const isActive = account.status === 'active';
                    return (
                      <button
                        key={account.id}
                        type="button"
                        data-testid={`ig-add-mirror-account-${account.id}`}
                        disabled={!isActive}
                        onClick={() => handleSelectAccount(account)}
                        className="flex items-center gap-4 rounded-xs border-b border-line px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60"
                      >
                        {account.profilePictureUrl ? (
                          <Image
                            src={account.profilePictureUrl}
                            alt=""
                            width={40}
                            height={40}
                            className="size-10 shrink-0 rounded-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink"
                          >
                            {(account.displayName[0] ?? '?').toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-body font-semibold text-ink">
                            {account.displayName}
                          </div>
                          <div className="mt-0.5 text-metadata text-ink-sub">
                            {isActive
                              ? 'Connected'
                              : account.status === 'expired'
                                ? 'Expired — reconnect in Accounts'
                                : 'Disconnected — reconnect in Accounts'}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {step === 'username' && selectedAccount && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-4 rounded-xs border border-line px-3 py-2.5">
                {selectedAccount.profilePictureUrl ? (
                  <Image
                    src={selectedAccount.profilePictureUrl}
                    alt=""
                    width={40}
                    height={40}
                    className="size-10 shrink-0 rounded-full object-cover"
                    unoptimized
                  />
                ) : (
                  <span
                    aria-hidden
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink"
                  >
                    {(selectedAccount.displayName[0] ?? '?').toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold text-ink">
                    {selectedAccount.displayName}
                  </div>
                </div>
              </div>
              <p className="text-body text-ink-sub">
                On connect, the account&apos;s latest reel is posted right away.
              </p>
              <label className="flex flex-col gap-1.5" htmlFor="ig-add-mirror-username">
                <span className="text-body font-medium text-ink">TikTok username</span>
                <Input
                  id="ig-add-mirror-username"
                  data-testid="ig-add-mirror-username-input"
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setInlineError(null);
                  }}
                  placeholder="@username"
                  autoComplete="off"
                />
              </label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {step === 'username' && (
            <Button
              type="button"
              data-testid="ig-add-mirror-connect-btn"
              disabled={!canConnect}
              onClick={() => {
                setInlineError(null);
                createMutation.mutate();
              }}
            >
              {createMutation.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
