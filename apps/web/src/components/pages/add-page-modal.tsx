'use client';

/**
 * Add Page modal (spec 131 PR-131-2, spec §8.2/§8.4) — the former
 * 1,233-line hand-rolled overlay, decomposed: the pure computations
 * live in `add-page-helpers.ts`, the two flow-step bodies in
 * `add-page-steps.tsx`, and this file is the flow state machine on
 * the shared/ui `Dialog` primitive (focus trap, Esc, focus return
 * per UI Rule 18; the legacy ui/dialog import — the last of spec
 * 131's three — is deleted).
 *
 * Its three raw fetches (accounts fallback load, page discovery,
 * page import) now go through the typed API client with zod schemas
 * (spec §8.1), following PR-131-1's connect-modal precedent; the
 * parent surface invalidates the pages/accounts query keys when the
 * import succeeds. Failures are reported (never silent) and surface
 * as the flow's inline error state with the previous copy verbatim.
 * Step behaviour, the spec 109 duplicate-name disambiguation, and
 * the finish outcome (the dialog closes and the list shows the
 * "<n> Facebook Page(s) added" summary banner) are preserved.
 */
import * as React from 'react';
import { ArrowLeftIcon } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Button } from '@/components/shared/ui/button';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  DiscoverPagesResponseSchema,
  ImportPagesResponseSchema,
} from '@/lib/api/schemas/pages';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import { reportError } from '@/lib/report-error';
import { buildDirectConnectUrl } from '@/components/accounts/connect-account-modal';
import { getAccountHealth } from '@/components/accounts/account-health';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

import {
  canAddAnotherPostingTime,
  computeConfirmButtonText,
  computeHeaderSubtitle,
  createAddPagePostingTime,
  findFreeAddPagePostingTime,
  getActiveAccounts,
  getErrorAccounts,
  getExpiredAccounts,
  isAddPageScheduleValid,
  sortAddPageFormats,
  toggleSelectAllPages,
  type AddPagePostingTime,
  type AddPageStep,
  type DiscoveredPageItem,
} from './add-page-helpers';
import { SelectAccountStep, SelectPagesStep } from './add-page-steps';
import dynamic from 'next/dynamic';
// Steps 3–4 load on demand, not in the Pages route's first-load
// bundle: the timezone directory and posting-times UI are only
// needed once a user reaches them inside the dialogue.
const SelectTimezoneStep = dynamic(() =>
  import('./add-page-schedule-steps').then((m) => m.SelectTimezoneStep)
);
const SelectPostingTimesStep = dynamic(() =>
  import('./add-page-schedule-steps').then((m) => m.SelectPostingTimesStep)
);

export type { DiscoveredPageItem } from './add-page-helpers';
export {
  buildAccountsHref,
  buildSettingsFacebookHref,
  canAddAnotherPostingTime,
  computeConfirmButtonText,
  computeHeaderSubtitle,
  createAddPagePostingTime,
  filterDiscoveredPages,
  findFreeAddPagePostingTime,
  getActiveAccounts,
  getErrorAccounts,
  getExpiredAccounts,
  getSelectablePageIds,
  isAddPageScheduleValid,
  nextAddPagePostingTime,
  sortAddPageFormats,
  toggleSelectAllPages,
} from './add-page-helpers';
export type { AddPagePostingTime } from './add-page-helpers';

export interface AddPageModalProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts?: FacebookAccountItem[] | undefined;
  /**
   * R17: whether the parent's accounts read is still pending. The
   * shell passes an (initially empty) accounts array, so without
   * this flag the modal cannot tell "loading" from "none" and
   * renders the dead-end "No active Facebook accounts connected"
   * notice while accounts are still loading. The modal's own
   * fallback fetch respects the same flag via the combined
   * loading state below.
   */
  accountsPending?: boolean | undefined;
  onSuccess?:
    | ((result: {
        importedCount: number;
        importedPageIds: string[];
        accountId?: string | undefined;
      }) => void)
    | undefined;
  onNavigateToAccounts?: (() => void) | undefined;
  /**
   * Whether the workspace's Facebook App ID and Secret are configured.
   * `false` = known missing (show guidance at the point of need);
   * `undefined` = not checked yet (show no guidance claim).
   */
  facebookAppConfigured?: boolean | undefined;
  /** Audit UX5: the app-setup check is still running. */
  byocPending?: boolean | undefined;
  /** Audit UX5: the app-setup check failed (not known missing). */
  byocError?: boolean | undefined;
  onNavigateToSettingsFacebook?: (() => void) | undefined;
  onReconnectAccount?: ((account: FacebookAccountItem) => void) | undefined;
  initialStep?: AddPageStep | undefined;
  initialSelectedAccount?: FacebookAccountItem | null | undefined;
  initialDiscoveredPages?: DiscoveredPageItem[] | undefined;
  initialSelectedPageIds?: string[] | undefined;
  initialSelectedTimezone?: string | null | undefined;
  initialPostingTimes?: AddPagePostingTime[] | undefined;
}

async function executeDiscoverPages(subdomain: string, accountId: string) {
  try {
    const data = await api.get(
      buildTenantApiPath(subdomain, `/accounts/${accountId}/pages/discover`),
      { schema: DiscoverPagesResponseSchema }
    );
    return {
      success: true as const,
      pages: data.pages as DiscoveredPageItem[],
      // R14/K9: a capped or mid-list-failed fetch is still a
      // successful response — but the list it carries is not the
      // account's complete list, and the step must say so. The
      // capped/partial/dropped warnings render inside
      // SelectPagesStep (listTruncated/listPartial/droppedCount);
      // the old generic BG6 banner above the step was removed as
      // superseded by those specific warnings (same coverage:
      // a warning shows whenever the list is incomplete).
      truncated: data.truncated,
      partial: data.partial,
      droppedCount: data.droppedCount,
      error: null,
    };
  } catch (error) {
    reportError(error, { source: 'add-page-discover' });
    return {
      success: false as const,
      pages: [] as DiscoveredPageItem[],
      truncated: false,
      partial: false,
      droppedCount: 0,
      error:
        isApiError(error) && error.kind === 'http'
          ? "Couldn't load pages from this Facebook account. Please check the account connection and try again."
          : 'An error occurred while loading pages from Facebook. Please try again.',
    };
  }
}

async function executeImportPages(
  subdomain: string,
  accountId: string,
  selectedPageIds: string[],
  timezone: string | null,
  postingTimes: AddPagePostingTime[]
) {
  try {
    const data = await api.post(
      buildTenantApiPath(subdomain, '/pages/import'),
      {
        accountId,
        selectedPageIds,
        // The schedule travels with the import, so the server applies
        // the same timezone + times to every imported page in the
        // same operation — there is no separate post-import step
        // that could leave a page half-configured.
        ...(timezone
          ? {
              timezone,
              postingTimes: postingTimes.map((postingTime) => ({
                slotTime: postingTime.slotTime,
                allowedFormats: postingTime.allowedFormats,
              })),
            }
          : {}),
      },
      { schema: ImportPagesResponseSchema }
    );
    return {
      success: true as const,
      importedCount: data.importedCount,
      importedPageIds: data.pages.map((p) => p.id),
      error: null,
    };
  } catch (error) {
    reportError(error, { source: 'add-page-import' });
    // A schedule failure carries its own server signal and message:
    // the timezone and times are kept for retry, so the user must
    // hear that, not the generic import failure. A partial import
    // (BG8) likewise names the pages that were not added, so its
    // server message is passed through verbatim. Anything else
    // keeps the generic import message.
    if (
      isApiError(error) &&
      error.kind === 'http' &&
      (error.code === 'SCHEDULE_FAILED' ||
        error.code === 'PARTIAL_IMPORT')
    ) {
      return {
        success: false as const,
        importedCount: 0,
        importedPageIds: [] as string[],
        error: error.message,
      };
    }
    return {
      success: false as const,
      importedCount: 0,
      importedPageIds: [] as string[],
      error:
        isApiError(error) && error.kind === 'http'
          ? "Couldn't add the selected pages. Please try again."
          : 'An error occurred while adding your pages. Please try again.',
    };
  }
}

export function AddPageModal({
  subdomain,
  open,
  onOpenChange,
  accounts,
  accountsPending = false,
  onSuccess,
  onNavigateToAccounts,
  facebookAppConfigured,
  byocPending = false,
  byocError = false,
  onNavigateToSettingsFacebook,
  onReconnectAccount,
  initialStep = 'select-account',
  initialSelectedAccount = null,
  initialDiscoveredPages = [],
  initialSelectedPageIds = [],
  initialSelectedTimezone = null,
  initialPostingTimes,
}: Readonly<AddPageModalProps>) {
  const [step, setStep] = React.useState<AddPageStep>(initialStep);
  const [fetchedAccounts, setFetchedAccounts] = React.useState<
    FacebookAccountItem[] | null
  >(null);
  const [isLoadingAccounts, setIsLoadingAccounts] = React.useState(false);

  const [selectedAccount, setSelectedAccount] =
    React.useState<FacebookAccountItem | null>(initialSelectedAccount);
  const [discoveredPages, setDiscoveredPages] = React.useState<DiscoveredPageItem[]>(
    initialDiscoveredPages
  );
  const [pageSearchQuery, setPageSearchQuery] = React.useState('');
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  // K9: a failed discover keeps its own error state (with Retry),
  // separate from the modal-wide error banner — so step 2 never
  // shows the misleading "no discovered pages" empty state
  // alongside an error. The R14/K9 list-completeness flags travel
  // with the last successful discover.
  const [discoverError, setDiscoverError] = React.useState<string | null>(null);
  const [discoverTruncated, setDiscoverTruncated] = React.useState(false);
  const [discoverPartial, setDiscoverPartial] = React.useState(false);
  const [discoverDroppedCount, setDiscoverDroppedCount] = React.useState(0);
  const [selectedPageIds, setSelectedPageIds] = React.useState<string[]>(
    initialSelectedPageIds
  );
  // Steps 3–4 state. The timezone starts blank (no default) and the
  // posting-times list starts with one time, all post types selected.
  // The schedule is account-independent, so it survives picking a
  // new account and going back to accounts — only Cancel or closing
  // the dialog resets it. The page selection, which is
  // account-specific, still resets on an account change.
  const [selectedTimezone, setSelectedTimezone] = React.useState<
    string | null
  >(initialSelectedTimezone);
  const [timezoneSearchQuery, setTimezoneSearchQuery] = React.useState('');
  const [postingTimes, setPostingTimes] = React.useState<AddPagePostingTime[]>(
    initialPostingTimes ?? [createAddPagePostingTime()]
  );
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const effectiveAccounts = fetchedAccounts ?? accounts ?? [];
  const activeAccounts = getActiveAccounts(effectiveAccounts);
  const expiredAccounts = getExpiredAccounts(effectiveAccounts);
  const errorAccounts = getErrorAccounts(effectiveAccounts);
  // R17: the step's loading state is the parent's pending flag OR
  // the modal's own fallback fetch — never just the fallback. The
  // shell passes accounts=[] while its query is pending, so the
  // fallback never runs there; without this combination the step
  // would show the dead-end notice during that window.
  const accountsLoading = isLoadingAccounts || accountsPending;

  const fetchAccountsIfNeeded = React.useCallback(async () => {
    if (!subdomain || accounts !== undefined) return;
    setIsLoadingAccounts(true);
    try {
      const data = await api.get(buildTenantApiPath(subdomain, '/accounts'), {
        schema: ListFacebookAccountsResponseSchema,
      });
      setFetchedAccounts((data.accounts ?? []) as FacebookAccountItem[]);
    } catch (error) {
      // Keep the fallback empty-accounts state; the failure is
      // reported, never silent (spec §8.1).
      reportError(error, { source: 'add-page-accounts-load' });
    } finally {
      setIsLoadingAccounts(false);
    }
  }, [subdomain, accounts]);

  React.useEffect(() => {
    if (open && accounts === undefined) {
      void fetchAccountsIfNeeded();
    }
  }, [open, accounts, fetchAccountsIfNeeded]);

  const resetSchedule = React.useCallback(() => {
    setSelectedTimezone(null);
    setTimezoneSearchQuery('');
    setPostingTimes([createAddPagePostingTime()]);
  }, []);

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStep('select-account');
      setSelectedAccount(null);
      setDiscoveredPages([]);
      setSelectedPageIds([]);
      setPageSearchQuery('');
      resetSchedule();
      setErrorMessage(null);
      setDiscoverError(null);
      setDiscoverTruncated(false);
      setDiscoverPartial(false);
      setDiscoverDroppedCount(0);
      setIsSubmitting(false);
    }
    onOpenChange(nextOpen);
  };

  // Audit UX9: when discovery or import fails on an account
  // whose connection is already expired or errored, say so and
  // point at Reconnect — the generic message alone sends the
  // user back out to find Reconnect elsewhere.
  const reconnectHintFor = (account: FacebookAccountItem): string => {
    const health = getAccountHealth(account);
    return health === 'expired' || health === 'error'
      ? " This account's connection may have expired — go back and use Reconnect on it, then try again."
      : '';
  };

  const handleSelectAccount = async (account: FacebookAccountItem) => {
    setSelectedAccount(account);
    setStep('select-pages');
    setDiscoveredPages([]);
    setSelectedPageIds([]);
    setPageSearchQuery('');
    setErrorMessage(null);
    setDiscoverError(null);
    setDiscoverTruncated(false);
    setDiscoverPartial(false);
    setDiscoverDroppedCount(0);
    setIsDiscovering(true);

    const result = await executeDiscoverPages(subdomain, account.id);
    if (!result.success) {
      // Both surfaces: the top alert (BG6/UX9, with the reconnect
      // hint for expired/error accounts) and the in-step error
      // (K9, with Retry). They carry the same message; Retry
      // clears both. Neither surface alone covers both audits'
      // asserted behaviour, so neither is dropped here.
      setErrorMessage(result.error + reconnectHintFor(account));
      setDiscoverError(result.error + reconnectHintFor(account));
    } else {
      setDiscoveredPages(result.pages);
      setDiscoverTruncated(result.truncated);
      setDiscoverPartial(result.partial);
      setDiscoverDroppedCount(result.droppedCount);
    }
    setIsDiscovering(false);
  };

  // K9 step 2 retry: re-runs discover for the already-selected
  // account, replacing the error (or the partial list) in place.
  // Clears both error surfaces; a failed retry sets both again.
  const handleRetryDiscover = async () => {
    if (!selectedAccount || isDiscovering) return;
    setIsDiscovering(true);
    setErrorMessage(null);
    setDiscoverError(null);
    const result = await executeDiscoverPages(subdomain, selectedAccount.id);
    if (!result.success) {
      setErrorMessage(result.error + reconnectHintFor(selectedAccount));
      setDiscoverError(result.error + reconnectHintFor(selectedAccount));
    } else {
      setDiscoveredPages(result.pages);
      setDiscoverTruncated(result.truncated);
      setDiscoverPartial(result.partial);
      setDiscoverDroppedCount(result.droppedCount);
    }
    setIsDiscovering(false);
  };

  const handleBackToAccounts = () => {
    setStep('select-account');
    setSelectedAccount(null);
    setDiscoveredPages([]);
    setSelectedPageIds([]);
    setPageSearchQuery('');
    setErrorMessage(null);
    setDiscoverError(null);
    setDiscoverTruncated(false);
    setDiscoverPartial(false);
    setDiscoverDroppedCount(0);
  };

  // Back between steps 2, 3 and 4 preserves the page selection, the
  // timezone, and the posting times — only the step changes.
  const handleBackToPages = () => {
    setStep('select-pages');
    setErrorMessage(null);
  };

  const handleBackToTimezone = () => {
    setStep('select-timezone');
    setErrorMessage(null);
  };

  const handleTogglePage = (fbPageId: string) => {
    setSelectedPageIds((prev) =>
      prev.includes(fbPageId)
        ? prev.filter((id) => id !== fbPageId)
        : [...prev, fbPageId]
    );
  };

  const handleSelectAll = () => {
    setSelectedPageIds((prev) => toggleSelectAllPages(discoveredPages, prev));
  };

  const isScheduleValid = isAddPageScheduleValid(
    selectedTimezone,
    postingTimes
  );

  const handleAddPostingTime = () => {
    setPostingTimes((prev) => {
      const next = findFreeAddPagePostingTime(prev);
      return next ? [...prev, next] : prev;
    });
  };

  const handleRemovePostingTime = (index: number) => {
    setPostingTimes((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev
    );
  };

  const handlePostingTimeChange = (index: number, slotTime: string) => {
    setPostingTimes((prev) =>
      prev.map((postingTime, i) =>
        i === index ? { ...postingTime, slotTime } : postingTime
      )
    );
  };

  const handleToggleFormat = (index: number, formatId: string) => {
    setPostingTimes((prev) =>
      prev.map((postingTime, i) => {
        if (i !== index) return postingTime;
        const toggled = postingTime.allowedFormats.includes(formatId)
          ? postingTime.allowedFormats.filter((format) => format !== formatId)
          : [...postingTime.allowedFormats, formatId];
        // Keep the canonical order: deselect-then-reselect must not
        // move a type to the end of the stored list.
        return { ...postingTime, allowedFormats: sortAddPageFormats(toggled) };
      })
    );
  };

  const handleConfirmImport = async () => {
    if (
      !selectedAccount ||
      selectedPageIds.length === 0 ||
      !selectedTimezone ||
      !isScheduleValid ||
      isSubmitting
    ) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);

    const result = await executeImportPages(
      subdomain,
      selectedAccount.id,
      selectedPageIds,
      selectedTimezone,
      postingTimes
    );
    if (!result.success) {
      // "Nothing finish": the dialog stays open on Step 4 with the
      // inline error, no success banner, no close. The user's
      // timezone and times are kept, so Retry re-sends the same
      // schedule and the server's slot upsert cannot duplicate it.
      // Audit UX9: same reconnect hint as discovery failures
      // (selectedAccount is non-null here — the import call above
      // already dereferenced it).
      setErrorMessage(result.error + reconnectHintFor(selectedAccount));
    } else {
      onSuccess?.({
        importedCount: result.importedCount,
        importedPageIds: result.importedPageIds,
        // K9: the shell lands the list on this account so the
        // imported cards are actually visible.
        accountId: selectedAccount.id,
      });
      handleDialogOpenChange(false);
    }
    setIsSubmitting(false);
  };

  // Navigation itself is the Link's href (in the step component) so it
  // cannot be lost when the dialog closes and unmounts the button; this
  // handler only closes the dialog and lets a parent-supplied
  // navigation hook run alongside.
  const handleGoToAccounts = () => {
    handleDialogOpenChange(false);
    onNavigateToAccounts?.();
  };

  const handleGoToSettingsFacebook = () => {
    handleDialogOpenChange(false);
    onNavigateToSettingsFacebook?.();
  };

  // Point-of-need guidance applies only when the user still needs to connect
  // or reconnect an account and the app details are known to be missing.
  const showMissingAppGuidance =
    step === 'select-account' &&
    facebookAppConfigured === false &&
    activeAccounts.length === 0;
  // Audit UX5: the checking/failed states get their own notices so
  // the modal never shows only "No active accounts" with no reason.
  const showByocChecking =
    step === 'select-account' && byocPending && activeAccounts.length === 0;
  const showByocCheckFailed =
    step === 'select-account' && !byocPending && byocError && activeAccounts.length === 0;

  const handleReconnectAccount = (account: FacebookAccountItem) => {
    // Audit UX5: while the check runs, Reconnect is visibly
    // disabled in the step list — this guard is only belt and
    // braces, never the sole (silent) behaviour.
    if (byocPending) return;
    if (onReconnectAccount) {
      onReconnectAccount(account);
      return;
    }
    // Audit N8: the fallback (no parent handler) must apply the
    // same BYOC gate the Pages shell applies — without app
    // credentials it routes to Settings instead of sending a
    // BYOC-less user straight into OAuth, which would fail
    // server-side. Unknown (undefined) counts as not configured
    // here, exactly as in the shell handler.
    if (!facebookAppConfigured) {
      if (onNavigateToSettingsFacebook) {
        onNavigateToSettingsFacebook();
      } else if (typeof window !== 'undefined') {
        window.location.href = `/tenant/${subdomain}/settings?tab=byoc`;
      }
      return;
    }
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

  const confirmButtonText = computeConfirmButtonText(
    isSubmitting,
    selectedPageIds.length
  );

  const headerTitle =
    step === 'select-account'
      ? 'Select a Facebook Account'
      : step === 'select-timezone'
        ? 'Select timezone'
        : step === 'select-posting-times'
          ? 'Set posting times'
          : 'Select Facebook Pages to Add';

  const headerSubtitle = computeHeaderSubtitle(
    step,
    selectedAccount?.displayName,
    step === 'select-pages' ? discoveredPages.length : selectedPageIds.length
  );

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-135" data-testid="add-page-modal">
        <DialogHeader>
          <div className="flex items-start gap-2">
            {step === 'select-pages' && (
              <button
                type="button"
                data-testid="change-account-btn"
                onClick={handleBackToAccounts}
                aria-label="Back to account selection"
                className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xs text-ink-sub outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
              >
                <ArrowLeftIcon className="size-4" aria-hidden />
              </button>
            )}

            {step === 'select-timezone' && (
              <button
                type="button"
                data-testid="back-to-pages-btn"
                onClick={handleBackToPages}
                aria-label="Back to page selection"
                className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xs text-ink-sub outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
              >
                <ArrowLeftIcon className="size-4" aria-hidden />
              </button>
            )}

            {step === 'select-posting-times' && (
              <button
                type="button"
                data-testid="back-to-timezone-btn"
                onClick={handleBackToTimezone}
                aria-label="Back to timezone selection"
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
          {errorMessage && (
            <div
              data-testid="add-page-error"
              role="alert"
              className="mb-4 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2 text-body text-signal-critical-on-tint"
            >
              {errorMessage}
            </div>
          )}

          {step === 'select-account' && (
            <SelectAccountStep
              subdomain={subdomain}
              isLoadingAccounts={accountsLoading}
              activeAccounts={activeAccounts}
              expiredAccounts={expiredAccounts}
              errorAccounts={errorAccounts}
              showMissingAppGuidance={showMissingAppGuidance}
              showByocChecking={showByocChecking}
              showByocCheckFailed={showByocCheckFailed}
              isReconnectDisabled={byocPending}
              onSelectAccount={(account) => {
                void handleSelectAccount(account);
              }}
              onReconnectAccount={handleReconnectAccount}
              onGoToAccounts={handleGoToAccounts}
              onGoToSettingsFacebook={handleGoToSettingsFacebook}
            />
          )}

          {step === 'select-pages' && (
            <SelectPagesStep
              isDiscovering={isDiscovering}
              discoveredPages={discoveredPages}
              selectedPageIds={selectedPageIds}
              pageSearchQuery={pageSearchQuery}
              onPageSearchChange={setPageSearchQuery}
              onTogglePage={handleTogglePage}
              onSelectAll={handleSelectAll}
              discoverError={discoverError}
              onRetryDiscover={() => {
                void handleRetryDiscover();
              }}
              listTruncated={discoverTruncated}
              listPartial={discoverPartial}
              droppedCount={discoverDroppedCount}
            />
          )}

          {step === 'select-timezone' && (
            <SelectTimezoneStep
              selectedTimezone={selectedTimezone}
              timezoneSearchQuery={timezoneSearchQuery}
              onTimezoneSearchChange={setTimezoneSearchQuery}
              onSelectTimezone={setSelectedTimezone}
            />
          )}

          {step === 'select-posting-times' && selectedTimezone && (
            <SelectPostingTimesStep
              timezone={selectedTimezone}
              postingTimes={postingTimes}
              canAddAnotherPostingTime={canAddAnotherPostingTime(postingTimes)}
              onChangeTimezone={handleBackToTimezone}
              onAddPostingTime={handleAddPostingTime}
              onRemovePostingTime={handleRemovePostingTime}
              onPostingTimeChange={handlePostingTimeChange}
              onToggleFormat={handleToggleFormat}
            />
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="cancel-add-pages-btn"
            onClick={() => handleDialogOpenChange(false)}
          >
            Cancel
          </Button>

          {step === 'select-pages' && (
            <Button
              type="button"
              data-testid="continue-to-timezone-btn"
              disabled={selectedPageIds.length === 0}
              onClick={() => setStep('select-timezone')}
            >
              Continue
            </Button>
          )}

          {step === 'select-timezone' && (
            <Button
              type="button"
              data-testid="continue-to-posting-times-btn"
              disabled={!selectedTimezone}
              onClick={() => setStep('select-posting-times')}
            >
              Continue
            </Button>
          )}

          {step === 'select-posting-times' && (
            <Button
              type="button"
              data-testid="confirm-add-pages-btn"
              disabled={!isScheduleValid || isSubmitting}
              onClick={() => {
                void handleConfirmImport();
              }}
            >
              {confirmButtonText}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
