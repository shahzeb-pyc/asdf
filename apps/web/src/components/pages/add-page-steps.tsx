'use client';

/**
 * Add Page flow steps (spec 131 PR-131-2, spec §8.4 decomposition) —
 * the two step bodies of the Add Page dialog, extracted from the
 * former 1,233-line modal and rebuilt on the shared/ui primitives
 * (token-backed utilities only, avatars on `next/image`, the page
 * picker on the shared `Checkbox`). All copy, testids, and per-row
 * states are preserved verbatim, including the spec 109 duplicate-
 * name disambiguation (same-named pages are told apart by the
 * Page ID suffix line — never silently merged).
 */
import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import { Input } from '@/components/shared/ui/input';
import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import type { FacebookAccountItem } from '@/components/accounts/account-card';
import { formatPageIdSuffix } from '@/components/pages/page-card';

import {
  buildAccountsHref,
  buildSettingsFacebookHref,
  filterDiscoveredPages,
  getSelectablePageIds,
  type DiscoveredPageItem,
} from './add-page-helpers';

/* ------------------------------------------------------------------ */
/* Avatars                                                             */
/* ------------------------------------------------------------------ */

function AccountAvatar({
  account,
}: Readonly<{ account: FacebookAccountItem }>) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImg =
    Boolean(account.profilePictureUrl) && failedUrl !== account.profilePictureUrl;
  const trimmedName = account.displayName.trim();
  const initials = trimmedName ? getUserInitials(trimmedName) : 'FB';

  if (showImg) {
    return (
      <Image
        src={account.profilePictureUrl!}
        alt={account.displayName}
        width={36}
        height={36}
        onError={() => setFailedUrl(account.profilePictureUrl ?? '__error__')}
        className="size-9 shrink-0 rounded-full border border-line object-cover"
      />
    );
  }
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-body font-bold text-ink">
      {initials}
    </div>
  );
}

export function DiscoveredPageAvatar({
  pageName,
  profilePictureUrl,
}: Readonly<{
  pageName: string;
  profilePictureUrl?: string | null | undefined;
}>) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImg = Boolean(profilePictureUrl) && failedUrl !== profilePictureUrl;
  const trimmedName = pageName.trim();
  const initials = trimmedName ? getUserInitials(trimmedName) : 'PG';

  if (showImg) {
    return (
      <Image
        src={profilePictureUrl!}
        alt={pageName}
        width={36}
        height={36}
        onError={() => setFailedUrl(profilePictureUrl ?? '__error__')}
        className="size-9 shrink-0 rounded-full border border-line object-cover"
      />
    );
  }

  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-metadata font-bold text-ink">
      {initials}
    </div>
  );
}

function pagesLinkedLabel(account: FacebookAccountItem): string {
  return `${account.connectedPagesCount} ${
    account.connectedPagesCount === 1 ? 'page linked' : 'pages linked'
  }`;
}

/* ------------------------------------------------------------------ */
/* Step 1 — select account                                             */
/* ------------------------------------------------------------------ */

export interface SelectAccountStepProps {
  subdomain: string;
  isLoadingAccounts: boolean;
  activeAccounts: FacebookAccountItem[];
  expiredAccounts: FacebookAccountItem[];
  /**
   * K9: error-health (wire disconnected) accounts. They used to
   * vanish here entirely; they render below with the same
   * reconnect recovery as expired accounts, plus a link to the
   * Accounts surface via the existing Go-to-Accounts action.
   */
  errorAccounts?: FacebookAccountItem[] | undefined;
  showMissingAppGuidance: boolean;
  /** Audit UX5: the app-setup check is still running. */
  showByocChecking?: boolean | undefined;
  /** Audit UX5: the app-setup check failed (not known missing). */
  showByocCheckFailed?: boolean | undefined;
  /** Audit UX5: Reconnect must look disabled while the check runs. */
  isReconnectDisabled?: boolean | undefined;
  onSelectAccount: (account: FacebookAccountItem) => void;
  onReconnectAccount: (account: FacebookAccountItem) => void;
  onGoToAccounts: () => void;
  onGoToSettingsFacebook: () => void;
}

export function SelectAccountStep({
  subdomain,
  isLoadingAccounts,
  activeAccounts,
  expiredAccounts,
  errorAccounts = [],
  showMissingAppGuidance,
  showByocChecking = false,
  showByocCheckFailed = false,
  isReconnectDisabled = false,
  onSelectAccount,
  onReconnectAccount,
  onGoToAccounts,
  onGoToSettingsFacebook,
}: Readonly<SelectAccountStepProps>) {
  const hasAnyAccounts =
    activeAccounts.length > 0 ||
    expiredAccounts.length > 0 ||
    errorAccounts.length > 0;
  const accountsHref = buildAccountsHref(subdomain);
  const settingsFacebookHref = buildSettingsFacebookHref(subdomain);

  return (
    <div>
      {showMissingAppGuidance && (
        <div
          data-testid="facebook-app-guidance"
          className="mb-4 rounded-sm border border-link/25 bg-link/10 px-3 py-2.5 text-body leading-body text-ink"
        >
          <p className="mb-1">
            Before you can connect an account, add your Facebook App ID and
            App Secret in Workspace Settings, under Facebook. Then come back
            here to connect your account.
          </p>
          <Link
            href={settingsFacebookHref}
            data-testid="go-to-settings-facebook-link"
            onClick={onGoToSettingsFacebook}
            className="font-semibold text-link underline"
          >
            Add App ID and Secret in Settings
          </Link>
        </div>
      )}

      {/* Audit UX5: while the app-setup check runs or has failed,
          the modal must say so instead of showing only "No active
          accounts" with no guidance. A failed check is not a
          known-missing claim — it points at Accounts, not Settings. */}
      {showByocChecking && (
        <div
          data-testid="byoc-checking-notice"
          className="mb-4 rounded-sm border border-brand-gold/25 bg-brand-gold/10 px-3 py-2.5 text-body leading-body text-ink"
        >
          Checking your Facebook app setup…
        </div>
      )}
      {showByocCheckFailed && (
        <div
          data-testid="byoc-check-failed-notice"
          className="mb-4 rounded-sm border border-brand-gold/25 bg-brand-gold/10 px-3 py-2.5 text-body leading-body text-ink"
        >
          <p className="mb-1">
            Couldn’t check your Facebook app setup. Open Facebook Accounts
            to check the connection there.
          </p>
          <Link
            href={accountsHref}
            data-testid="byoc-check-failed-accounts-link"
            onClick={onGoToAccounts}
            className="font-semibold text-link underline"
          >
            Go to Facebook Accounts
          </Link>
        </div>
      )}

      {isLoadingAccounts && (
        <div
          data-testid="loading-accounts-state"
          className="p-6 text-center text-body text-ink-sub"
        >
          Loading connected Facebook accounts...
        </div>
      )}

      {!isLoadingAccounts && !hasAnyAccounts && (
        <div
          data-testid="no-active-accounts-notice"
          className="flex flex-col items-center p-6 text-center"
        >
          <div className="mb-1 text-body font-semibold text-ink">
            No active Facebook accounts connected
          </div>
          <p className="mb-4 max-w-80 text-body leading-body text-ink-sub">
            Connect a Facebook account first so you can discover and add its
            pages to your workspace.
          </p>
          <Button asChild>
            <Link
              href={accountsHref}
              data-testid="go-to-accounts-btn"
              onClick={onGoToAccounts}
            >
              Go to Facebook Accounts
            </Link>
          </Button>
        </div>
      )}

      {!isLoadingAccounts && activeAccounts.length > 0 && (
        <div data-testid="select-account-list" className="flex flex-col gap-1">
          {activeAccounts.map((account) => (
            <button
              key={account.id}
              type="button"
              data-testid={`select-account-${account.id}`}
              onClick={() => {
                onSelectAccount(account);
              }}
              className="flex min-h-11 w-full items-center justify-between gap-4 rounded-sm px-3.5 py-3 text-left outline-none transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-link"
            >
              <div className="flex min-w-0 items-center gap-4">
                <AccountAvatar account={account} />
                <div className="min-w-0">
                  <div className="truncate text-body font-semibold text-ink">
                    {account.displayName}
                  </div>
                  <div className="mt-0.5 text-metadata text-ink-sub">
                    {pagesLinkedLabel(account)}
                  </div>
                </div>
              </div>
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 shrink-0 text-ink-dim"
              />
            </button>
          ))}
        </div>
      )}

      {!isLoadingAccounts && errorAccounts.length > 0 && (
        <div
          data-testid="error-accounts-list"
          className={cn(
            'flex flex-col gap-1',
            (activeAccounts.length > 0 || expiredAccounts.length > 0) &&
              'mt-4'
          )}
        >
          {errorAccounts.map((account) => (
            <div
              key={account.id}
              data-testid={`error-account-${account.id}`}
              className="flex items-center justify-between gap-4 rounded-sm px-3.5 py-3 opacity-55"
            >
              <div className="flex min-w-0 items-center gap-4">
                <AccountAvatar account={account} />
                <div className="min-w-0">
                  <div className="truncate text-body font-semibold text-ink">
                    {account.displayName}
                  </div>
                  <div className="mt-0.5 text-metadata text-ink-sub">
                    {pagesLinkedLabel(account)} · Connection issue
                  </div>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`reconnect-account-${account.id}`}
                onClick={() => onReconnectAccount(account)}
                className="shrink-0 border-signal-critical/35 font-semibold text-signal-critical hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
              >
                Reconnect
              </Button>
            </div>
          ))}
        </div>
      )}

      {!isLoadingAccounts && expiredAccounts.length > 0 && (
        <div
          data-testid="expired-accounts-list"
          className={cn(
            'flex flex-col gap-1',
            (activeAccounts.length > 0 || errorAccounts.length > 0) &&
              'mt-4'
          )}
        >
          {expiredAccounts.map((account) => (
            <div
              key={account.id}
              data-testid={`expired-account-${account.id}`}
              className="flex items-center justify-between gap-4 rounded-sm px-3.5 py-3 opacity-55"
            >
              <div className="flex min-w-0 items-center gap-4">
                <AccountAvatar account={account} />
                <div className="min-w-0">
                  <div className="truncate text-body font-semibold text-ink">
                    {account.displayName}
                  </div>
                  <div className="mt-0.5 text-metadata text-ink-sub">
                    {pagesLinkedLabel(account)} · Session expired
                  </div>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`reconnect-account-${account.id}`}
                onClick={() => onReconnectAccount(account)}
                disabled={isReconnectDisabled}
                title={isReconnectDisabled ? 'Checking app setup…' : undefined}
                className="shrink-0 border-signal-critical/35 font-semibold text-signal-critical hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
              >
                {isReconnectDisabled ? 'Checking…' : 'Reconnect'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 — select pages                                               */
/* ------------------------------------------------------------------ */

export interface SelectPagesStepProps {
  isDiscovering: boolean;
  discoveredPages: DiscoveredPageItem[];
  selectedPageIds: string[];
  pageSearchQuery: string;
  onPageSearchChange: (value: string) => void;
  onTogglePage: (fbPageId: string) => void;
  onSelectAll: () => void;
  /**
   * K9: a failed discover renders an error + Retry here — never
   * the "no discovered pages" empty state alongside an error,
   * which reads as "this account has no pages" when the load
   * simply failed.
   */
  discoverError?: string | null | undefined;
  onRetryDiscover?: (() => void) | undefined;
  /** R14/K9: the last successful discover was capped or partial. */
  listTruncated?: boolean | undefined;
  listPartial?: boolean | undefined;
  /** K9: Graph nodes the discover filter dropped (see route). */
  droppedCount?: number | undefined;
}

export function SelectPagesStep({
  isDiscovering,
  discoveredPages,
  selectedPageIds,
  pageSearchQuery,
  onPageSearchChange,
  onTogglePage,
  onSelectAll,
  discoverError = null,
  onRetryDiscover,
  listTruncated = false,
  listPartial = false,
  droppedCount = 0,
}: Readonly<SelectPagesStepProps>) {
  const selectableIds = getSelectablePageIds(discoveredPages);
  const allSelectableChecked =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedPageIds.includes(id));

  const filteredDiscoveredPages = React.useMemo(
    () => filterDiscoveredPages(discoveredPages, pageSearchQuery),
    [discoveredPages, pageSearchQuery]
  );

  // Completeness notes for a successful-but-incomplete discover:
  // shown above the list (or the empty state, when every node was
  // dropped) so a partial list is never presented as complete.
  const completenessNotes: React.ReactNode =
    !isDiscovering && !discoverError ? (
      <>
        {listTruncated && (
          <div
            data-testid="discover-truncated-warning"
            role="status"
            className="rounded-sm border border-link/25 bg-link/10 px-3 py-2 text-body leading-body text-ink"
          >
            Only the first 500 pages from this account are shown —
            this account has more pages on Facebook, so the list
            below may not include every page.
          </div>
        )}
        {listPartial && (
          <div
            data-testid="discover-partial-warning"
            role="status"
            className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-link/25 bg-link/10 px-3 py-2 text-body leading-body text-ink"
          >
            <span>
              Some pages couldn&apos;t be loaded from Facebook, so
              this list may be incomplete.
            </span>
            {onRetryDiscover && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="discover-retry-btn"
                onClick={onRetryDiscover}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        {droppedCount > 0 && (
          <div
            data-testid="discover-dropped-note"
            role="status"
            className="rounded-sm border border-link/25 bg-link/10 px-3 py-2 text-body leading-body text-ink"
          >
            {droppedCount}{' '}
            {droppedCount === 1 ? 'item' : 'items'} from Facebook
            {droppedCount === 1 ? ' was' : ' were'} left out —{' '}
            {droppedCount === 1 ? 'it had' : 'they had'} no category
            or page tasks, so {droppedCount === 1 ? 'it may' : 'they may'}{' '}
            not be a page.
          </div>
        )}
      </>
    ) : null;

  return (
    <div className="flex flex-col gap-2">
      {isDiscovering && (
        <div
          data-testid="discovering-pages-state"
          className="p-6 text-center text-body text-ink-sub"
        >
          Finding Facebook Pages on this account...
        </div>
      )}

      {!isDiscovering && discoverError && (
        <div
          data-testid="discover-error-state"
          role="alert"
          className="flex flex-col items-center gap-4 p-6 text-center"
        >
          <p className="m-0 text-body leading-body text-signal-critical">
            {discoverError}
          </p>
          {onRetryDiscover && (
            <Button
              type="button"
              variant="outline"
              data-testid="discover-retry-btn"
              onClick={onRetryDiscover}
            >
              Retry
            </Button>
          )}
        </div>
      )}

      {!isDiscovering && !discoverError && discoveredPages.length === 0 && (
        <>
          {completenessNotes}
          <div
            data-testid="no-discovered-pages-state"
            className="p-6 text-center text-body text-ink-sub"
          >
            No Facebook Pages were found on this account.
          </div>
        </>
      )}

      {!isDiscovering && !discoverError && discoveredPages.length > 0 && (
        <>
          {completenessNotes}
          <div className="mb-1 flex flex-wrap items-center justify-between gap-4 px-0.5">
            <div className="relative flex max-w-60 flex-1 items-center">
              <SearchIcon
                className="pointer-events-none absolute left-2.5 size-3.5 text-ink-dim"
                aria-hidden
              />
              <Input
                type="text"
                data-testid="modal-page-search-input"
                value={pageSearchQuery}
                onChange={(e) => onPageSearchChange(e.target.value)}
                placeholder="Filter pages..."
                aria-label="Filter pages"
                className="border-line bg-canvas pl-8 shadow-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-metadata text-ink-sub">
                {discoveredPages.length}{' '}
                {discoveredPages.length === 1 ? 'page found' : 'pages found'}
              </span>

              {selectableIds.length > 0 && (
                <button
                  type="button"
                  data-testid="select-all-pages-btn"
                  aria-pressed={allSelectableChecked}
                  onClick={onSelectAll}
                  className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                >
                  {allSelectableChecked ? 'Deselect All' : 'Select All'}
                </button>
              )}
            </div>
          </div>

          <div
            data-testid="discovered-pages-list"
            className="flex max-h-85 flex-col overflow-y-auto border-t border-line"
          >
            {filteredDiscoveredPages.map((page) => {
              const isChecked =
                page.isImported || selectedPageIds.includes(page.fbPageId);
              const followers =
                page.currentFollowers ?? page.followersCount ?? 0;
              const isSelected = !page.isImported && isChecked;

              return (
                <label
                  key={page.fbPageId}
                  data-testid={`discovered-page-row-${page.fbPageId}`}
                  className={cn(
                    'flex items-center gap-4 rounded-xs border-b border-line px-3 py-2.5 transition-colors',
                    isSelected ? 'bg-subtle' : 'bg-transparent',
                    page.isImported
                      ? 'cursor-default opacity-60'
                      : 'cursor-pointer hover:bg-hover'
                  )}
                >
                  <Checkbox
                    data-testid={`discovered-page-checkbox-${page.fbPageId}`}
                    checked={isChecked}
                    disabled={page.isImported}
                    onCheckedChange={() => {
                      if (!page.isImported) {
                        onTogglePage(page.fbPageId);
                      }
                    }}
                  />

                  <DiscoveredPageAvatar
                    pageName={page.pageName}
                    profilePictureUrl={page.profilePictureUrl}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-semibold text-ink">
                      {page.pageName}
                    </div>
                    <div className="mt-0.5 text-metadata text-ink-sub">
                      {page.category || 'Facebook Page'} •{' '}
                      {followers.toLocaleString('en-US')} followers
                      {formatPageIdSuffix(page.fbPageId)
                        ? ` · Page ID ${formatPageIdSuffix(page.fbPageId)}`
                        : ''}
                    </div>
                  </div>

                  {page.isImported && (
                    <span
                      data-testid={`already-added-${page.fbPageId}`}
                      className="shrink-0 text-metadata font-medium text-ink-dim"
                    >
                      Already added
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
