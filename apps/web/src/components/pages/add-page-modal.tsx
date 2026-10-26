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
import type { FacebookAccountItem } from '@/components/accounts/account-card';

import {
  computeConfirmButtonText,
  computeHeaderSubtitle,
  getActiveAccounts,
  getExpiredAccounts,
  toggleSelectAllPages,
  type AddPageStep,
  type DiscoveredPageItem,
} from './add-page-helpers';
import { SelectAccountStep, SelectPagesStep } from './add-page-steps';

export type { DiscoveredPageItem } from './add-page-helpers';
export {
  buildAccountsHref,
  buildSettingsFacebookHref,
  computeConfirmButtonText,
  computeHeaderSubtitle,
  filterDiscoveredPages,
  getActiveAccounts,
  getExpiredAccounts,
  getSelectablePageIds,
  toggleSelectAllPages,
} from './add-page-helpers';

export interface AddPageModalProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts?: FacebookAccountItem[] | undefined;
  onSuccess?:
    | ((result: { importedCount: number; importedPageIds: string[] }) => void)
    | undefined;
  onNavigateToAccounts?: (() => void) | undefined;
  /**
   * Whether the workspace's Facebook App ID and Secret are configured.
   * `false` = known missing (show guidance at the point of need);
   * `undefined` = not checked yet (show no guidance claim).
   */
  facebookAppConfigured?: boolean | undefined;
  onNavigateToSettingsFacebook?: (() => void) | undefined;
  onReconnectAccount?: ((account: FacebookAccountItem) => void) | undefined;
  initialStep?: AddPageStep | undefined;
  initialSelectedAccount?: FacebookAccountItem | null | undefined;
  initialDiscoveredPages?: DiscoveredPageItem[] | undefined;
  initialSelectedPageIds?: string[] | undefined;
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
      error: null,
    };
  } catch (error) {
    reportError(error, { source: 'add-page-discover' });
    return {
      success: false as const,
      pages: [] as DiscoveredPageItem[],
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
  selectedPageIds: string[]
) {
  try {
    const data = await api.post(
      buildTenantApiPath(subdomain, '/pages/import'),
      { accountId, selectedPageIds },
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
  onSuccess,
  onNavigateToAccounts,
  facebookAppConfigured,
  onNavigateToSettingsFacebook,
  onReconnectAccount,
  initialStep = 'select-account',
  initialSelectedAccount = null,
  initialDiscoveredPages = [],
  initialSelectedPageIds = [],
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
  const [selectedPageIds, setSelectedPageIds] = React.useState<string[]>(
    initialSelectedPageIds
  );
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const effectiveAccounts = fetchedAccounts ?? accounts ?? [];
  const activeAccounts = getActiveAccounts(effectiveAccounts);
  const expiredAccounts = getExpiredAccounts(effectiveAccounts);

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

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStep('select-account');
      setSelectedAccount(null);
      setDiscoveredPages([]);
      setSelectedPageIds([]);
      setPageSearchQuery('');
      setErrorMessage(null);
      setIsSubmitting(false);
    }
    onOpenChange(nextOpen);
  };

  const handleSelectAccount = async (account: FacebookAccountItem) => {
    setSelectedAccount(account);
    setStep('select-pages');
    setDiscoveredPages([]);
    setSelectedPageIds([]);
    setPageSearchQuery('');
    setErrorMessage(null);
    setIsDiscovering(true);

    const result = await executeDiscoverPages(subdomain, account.id);
    if (!result.success) {
      setErrorMessage(result.error);
    } else {
      setDiscoveredPages(result.pages);
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

  const handleConfirmImport = async () => {
    if (!selectedAccount || selectedPageIds.length === 0 || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);

    const result = await executeImportPages(
      subdomain,
      selectedAccount.id,
      selectedPageIds
    );
    if (!result.success) {
      setErrorMessage(result.error);
    } else {
      onSuccess?.({
        importedCount: result.importedCount,
        importedPageIds: result.importedPageIds,
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

  const handleReconnectAccount = (account: FacebookAccountItem) => {
    if (onReconnectAccount) {
      onReconnectAccount(account);
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
      : 'Select Facebook Pages to Add';

  const headerSubtitle = computeHeaderSubtitle(
    step,
    selectedAccount?.displayName,
    discoveredPages.length
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
                className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xs text-ink-sub outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-gold"
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
              className="mb-4 rounded-sm border border-brand-rose/25 bg-brand-rose/10 px-3 py-2 text-body text-brand-rose"
            >
              {errorMessage}
            </div>
          )}

          {step === 'select-account' && (
            <SelectAccountStep
              subdomain={subdomain}
              isLoadingAccounts={isLoadingAccounts}
              activeAccounts={activeAccounts}
              expiredAccounts={expiredAccounts}
              showMissingAppGuidance={showMissingAppGuidance}
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
              data-testid="confirm-add-pages-btn"
              disabled={selectedPageIds.length === 0 || isSubmitting}
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
