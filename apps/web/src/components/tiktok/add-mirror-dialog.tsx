'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, SearchIcon } from 'lucide-react';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import {
  DiscoverPagesResponseSchema,
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
import { toast } from '@/components/shared/ui/toast';
import { buildDirectConnectUrl } from '@/components/accounts/connect-account-modal';
import type { FacebookAccountItem } from '@/components/accounts/account-card';
import { formatPageIdSuffix } from '@/components/pages/page-card';
import {
  filterDiscoveredPages,
  getActiveAccounts,
  getExpiredAccounts,
} from '@/components/pages/add-page-helpers';
import {
  DiscoveredPageAvatar,
  SelectAccountStep,
} from '@/components/pages/add-page-steps';
import type { DiscoveredPageItem } from '@/components/pages/add-page-helpers';

/**
 * Add Auto Repost dialog — built on the Add Page flow's pieces:
 * the shared SelectAccountStep for accounts, the same rich page
 * rows (single-select, click-to-advance) for pages, the header
 * back arrow, per-step titles, and the rose error banner.
 * Flow: pick account → pick page → enter TikTok username →
 * Connect. On Connect the server verifies the username's feed
 * with tikwm; a feed that cannot be fetched shows an inline error
 * and creates nothing.
 *
 * Deliberately different from Add Page: no timezone or
 * posting-times steps (Auto Repost has no schedule), one page
 * instead of multi-select (no checkboxes / Select All), and
 * duplicate detection stays server-side — a mirror duplicate is
 * defined by (username + page) and the username is only known at
 * step 3, so it cannot be pre-marked like an imported page.
 */

type AddStep = 'select-account' | 'select-page' | 'username';

export interface AddMirrorDialogProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: ((mirrorId: string) => void) | undefined;
}

function pageSubline(page: DiscoveredPageItem): string {
  const followers = page.currentFollowers ?? page.followersCount ?? 0;
  const suffix = formatPageIdSuffix(page.fbPageId);
  return `${page.category || 'Facebook Page'} • ${followers.toLocaleString('en-US')} followers${suffix ? ` · Page ID ${suffix}` : ''}`;
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
  const [pageSearchQuery, setPageSearchQuery] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [inlineError, setInlineError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    setStep('select-account');
    setAccountId(null);
    setFbPageId(null);
    setPageSearchQuery('');
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

  // Same cast Add Page uses: the list response carries every
  // FacebookAccountItem field.
  const accounts = (accountsQuery.data?.accounts ?? []) as FacebookAccountItem[];
  const discoveredPages = (discoverQuery.data?.pages ?? []) as DiscoveredPageItem[];
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;
  const selectedPage = discoveredPages.find((p) => p.fbPageId === fbPageId) ?? null;
  const filteredPages = React.useMemo(
    () => filterDiscoveredPages(discoveredPages, pageSearchQuery),
    [discoveredPages, pageSearchQuery]
  );

  const handleSelectAccount = (account: FacebookAccountItem) => {
    setAccountId(account.id);
    setFbPageId(null);
    setPageSearchQuery('');
    setInlineError(null);
    setStep('select-page');
  };

  const handleBackToAccounts = () => {
    setStep('select-account');
    setAccountId(null);
    setFbPageId(null);
    setPageSearchQuery('');
    setInlineError(null);
  };

  const handleBackToPages = () => {
    setStep('select-page');
    setFbPageId(null);
    setInlineError(null);
  };

  const handleReconnectAccount = (account: FacebookAccountItem) => {
    if (typeof window !== 'undefined') {
      window.location.href = buildDirectConnectUrl({
        id: account.id,
        fbAccountId: account.fbAccountId,
        displayName: account.displayName,
        status: account.status,
        updatedAt: account.updatedAt,
      });
    }
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const canConnect =
    accountId !== null &&
    fbPageId !== null &&
    username.trim().length > 0 &&
    !createMutation.isPending;

  const headerTitle =
    step === 'select-account'
      ? 'Select a Facebook Account'
      : step === 'select-page'
        ? 'Select Facebook Page'
        : 'Add Auto Repost';
  const headerSubtitle =
    step === 'select-account'
      ? 'Pick the Facebook account whose page will receive the reels.'
      : step === 'select-page'
        ? `${selectedAccount?.displayName ?? 'Connected Account'} · ${discoveredPages.length} ${discoveredPages.length === 1 ? 'page available' : 'pages available'}`
        : 'Enter the TikTok username to repost. Every new reel from this account will be posted to the page as a Facebook Reel.';

  // A discover failure surfaces in the same banner as submit errors,
  // never as a bare line inside the step body.
  const displayError = inlineError ??
    (discoverQuery.isError
      ? "Couldn't load pages from this Facebook account. Please check the account connection and try again."
      : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-135" data-testid="add-mirror-dialog">
        <DialogHeader>
          <div className="flex items-start gap-2">
            {step === 'select-page' && (
              <button
                type="button"
                data-testid="add-mirror-back-to-accounts"
                onClick={handleBackToAccounts}
                aria-label="Back to account selection"
                className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xs text-ink-sub outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
              >
                <ArrowLeftIcon className="size-4" aria-hidden />
              </button>
            )}

            {step === 'username' && (
              <button
                type="button"
                data-testid="add-mirror-back-to-pages"
                onClick={handleBackToPages}
                aria-label="Back to page selection"
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
              data-testid="add-mirror-error"
              role="alert"
              className="mb-4 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2 text-body text-signal-critical-on-tint"
            >
              {displayError}
            </div>
          )}

          {step === 'select-account' && (
            <SelectAccountStep
              subdomain={subdomain}
              isLoadingAccounts={accountsQuery.isPending}
              activeAccounts={getActiveAccounts(accounts)}
              expiredAccounts={getExpiredAccounts(accounts)}
              showMissingAppGuidance={false}
              onSelectAccount={handleSelectAccount}
              onReconnectAccount={handleReconnectAccount}
              onGoToAccounts={handleClose}
              onGoToSettingsFacebook={handleClose}
            />
          )}

          {step === 'select-page' && (
            <div className="flex flex-col gap-2">
              {discoverQuery.isPending && (
                <div
                  data-testid="add-mirror-discovering-state"
                  className="p-6 text-center text-body text-ink-sub"
                >
                  Finding Facebook Pages on this account...
                </div>
              )}

              {!discoverQuery.isPending &&
                !discoverQuery.isError &&
                discoveredPages.length === 0 && (
                  <div
                    data-testid="add-mirror-no-pages-state"
                    className="p-6 text-center text-body text-ink-sub"
                  >
                    No Facebook Pages were found on this account.
                  </div>
                )}

              {!discoverQuery.isPending &&
                !discoverQuery.isError &&
                discoveredPages.length > 0 && (
                  <>
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-4 px-0.5">
                      <div className="relative flex max-w-60 flex-1 items-center">
                        <SearchIcon
                          className="pointer-events-none absolute left-2.5 size-3.5 text-ink-dim"
                          aria-hidden
                        />
                        <Input
                          type="text"
                          data-testid="add-mirror-page-search-input"
                          value={pageSearchQuery}
                          onChange={(e) => setPageSearchQuery(e.target.value)}
                          placeholder="Filter pages..."
                          aria-label="Filter pages"
                          className="border-line bg-canvas pl-8 shadow-none"
                        />
                      </div>

                      <span className="text-metadata text-ink-sub">
                        {discoveredPages.length}{' '}
                        {discoveredPages.length === 1 ? 'page found' : 'pages found'}
                      </span>
                    </div>

                    <div
                      data-testid="add-mirror-pages-list"
                      className="flex max-h-85 flex-col overflow-y-auto border-t border-line"
                    >
                      {filteredPages.map((page) => (
                        <button
                          key={page.fbPageId}
                          type="button"
                          data-testid={`add-mirror-page-${page.fbPageId}`}
                          onClick={() => {
                            setFbPageId(page.fbPageId);
                            setInlineError(null);
                            setStep('username');
                          }}
                          className="flex items-center gap-4 rounded-xs border-b border-line px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-link"
                        >
                          <DiscoveredPageAvatar
                            pageName={page.pageName}
                            profilePictureUrl={page.profilePictureUrl}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-body font-semibold text-ink">
                              {page.pageName}
                            </div>
                            <div className="mt-0.5 text-metadata text-ink-sub">
                              {pageSubline(page)}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
            </div>
          )}

          {step === 'username' && selectedPage && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-4 rounded-xs border border-line px-3 py-2.5">
                <DiscoveredPageAvatar
                  pageName={selectedPage.pageName}
                  profilePictureUrl={selectedPage.profilePictureUrl}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold text-ink">
                    {selectedPage.pageName}
                  </div>
                  <div className="mt-0.5 text-metadata text-ink-sub">
                    {pageSubline(selectedPage)}
                  </div>
                </div>
              </div>
              <p className="text-body text-ink-sub">
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
