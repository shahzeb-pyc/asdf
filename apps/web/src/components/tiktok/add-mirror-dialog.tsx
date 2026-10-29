'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import {
  DiscoverPagesResponseSchema,
  type DiscoveredPage,
} from '@/lib/api/schemas/pages';
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
import { Skeleton } from '@/components/shared/ui/skeleton';
import { toast } from '@/components/shared/ui/toast';

/**
 * Add TikTok mirror dialog — mirrors the Pages add flow with the
 * username step replacing timezone/posting-times: pick account →
 * pick page → enter TikTok username → Connect. On Connect the
 * server verifies the username's feed with tikwm; a feed that
 * cannot be fetched shows an inline error and creates nothing.
 */

type AddStep = 'select-account' | 'select-page' | 'username';

export interface AddMirrorDialogProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: ((mirrorId: string) => void) | undefined;
}

export function AddMirrorDialog({
  subdomain,
  open,
  onOpenChange,
  onSuccess,
}: Readonly<AddMirrorDialogProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);

  const [step, setStep] = React.useState<AddStep>('select-account');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [fbPageId, setFbPageId] = React.useState<string | null>(null);
  const [username, setUsername] = React.useState('');
  const [inlineError, setInlineError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    setStep('select-account');
    setAccountId(null);
    setFbPageId(null);
    setUsername('');
    setInlineError(null);
  }, []);

  const accountsQuery = useQuery({
    queryKey: tenant.accounts.list,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/accounts'), {
        schema: ListFacebookAccountsResponseSchema,
        signal,
      }),
    enabled: open,
  });

  const discoverQuery = useQuery({
    queryKey: [...tenant.accounts.list, 'discover', accountId] as const,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, `/accounts/${accountId}/pages/discover`), {
        schema: DiscoverPagesResponseSchema,
        signal,
      }),
    enabled: open && step !== 'select-account' && accountId !== null,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post(
        buildTenantApiPath(subdomain, '/tiktok-mirrors'),
        { accountId, targetExternalId: fbPageId, sourceUsername: username },
        { schema: CreateMirrorResponseSchema }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: tenant.tiktokMirrors.list });
      const immediate = data.immediatePost;
      if (immediate?.attempted && immediate.status === 'pending') {
        toast.warning(
          'Mirror added, but the latest reel could not be posted yet — it will retry on the next hourly check.'
        );
      } else {
        toast.success('Auto Repost added');
      }
      onSuccess?.(data.mirror.id);
      reset();
      onOpenChange(false);
    },
    onError: (error) => {
      // The typed client surfaces the server's error code + message
      // on the ApiError itself (no raw body).
      if (isApiError(error) && error.kind === 'http') {
        if (error.code === 'DUPLICATE_MIRROR') {
          setInlineError('This TikTok account is already reposted to this Facebook page.');
          return;
        }
        if (error.code === 'TIKTOK_FEED_UNAVAILABLE') {
          setInlineError(
            error.message ||
              "Could not fetch that TikTok account's feed. Check the username and try again."
          );
          return;
        }
      }
      setInlineError('Could not add this mirror. Please try again.');
    },
  });

  const accounts = accountsQuery.data?.accounts ?? [];
  const discoveredPages: DiscoveredPage[] = discoverQuery.data?.pages ?? [];
  const selectedPage = discoveredPages.find((p) => p.fbPageId === fbPageId) ?? null;

  const canConnect =
    accountId !== null &&
    fbPageId !== null &&
    username.trim().length > 0 &&
    !createMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="add-mirror-dialog">
        <DialogHeader>
          <DialogTitle>Add Auto Repost</DialogTitle>
          <DialogDescription>
            {step === 'select-account' &&
              'Pick the Facebook account whose page will receive the reels.'}
            {step === 'select-page' && 'Pick the Facebook page that will receive the reels.'}
            {step === 'username' &&
              'Enter the TikTok username to repost. Every new reel from this account will be posted to the page as a Facebook Reel.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'select-account' && (
          <div className="flex flex-col gap-2">
            {accountsQuery.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : accounts.length === 0 ? (
              <p className="text-body text-ink-sub">
                Connect a Facebook account first so you can pick its pages.
              </p>
            ) : (
              accounts.map((account) => (
                <Button
                  key={account.id}
                  type="button"
                  variant="outline"
                  data-testid={`add-mirror-account-${account.id}`}
                  className="justify-start"
                  onClick={() => {
                    setAccountId(account.id);
                    setStep('select-page');
                  }}
                >
                  {account.displayName}
                </Button>
              ))
            )}
          </div>
        )}

        {step === 'select-page' && (
          <div className="flex flex-col gap-2">
            {discoverQuery.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : discoverQuery.isError ? (
              <p className="text-body text-ink-sub">
                Couldn&apos;t load pages from this Facebook account. Please try again.
              </p>
            ) : discoveredPages.length === 0 ? (
              <p className="text-body text-ink-sub">
                This account has no Facebook pages to mirror to.
              </p>
            ) : (
              discoveredPages.map((page) => (
                <Button
                  key={page.fbPageId}
                  type="button"
                  variant="outline"
                  data-testid={`add-mirror-page-${page.fbPageId}`}
                  className="justify-start"
                  onClick={() => {
                    setFbPageId(page.fbPageId);
                    setStep('username');
                  }}
                >
                  {page.pageName}
                </Button>
              ))
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep('select-account')}
            >
              Back to accounts
            </Button>
          </div>
        )}

        {step === 'username' && (
          <div className="flex flex-col gap-3">
            <p className="text-metadata text-ink-sub">
              Mirroring to <strong className="text-ink">{selectedPage?.pageName}</strong>.
              On connect, the account&apos;s latest reel is posted right away.
            </p>
            <label className="flex flex-col gap-1.5" htmlFor="add-mirror-username">
              <span className="text-body font-medium text-ink">TikTok username</span>
              <Input
                id="add-mirror-username"
                data-testid="add-mirror-username-input"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setInlineError(null);
                }}
                placeholder="@username"
                autoComplete="off"
              />
            </label>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep('select-page')}
            >
              Back to pages
            </Button>
          </div>
        )}

        {inlineError ? (
          <p role="alert" data-testid="add-mirror-error" className="text-body text-signal-critical">
            {inlineError}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {step === 'username' && (
            <Button
              type="button"
              data-testid="add-mirror-connect-btn"
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
