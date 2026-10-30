'use client';

/**
 * Instagram connect account modal — Facebook's `ConnectAccountModal`
 * pattern exactly (shared/ui `Dialog`, choose view with two option
 * buttons, polling of the accounts list, and connected /
 * already-connected / reconnected-mismatch notices with the same
 * Option-B dialogue: no success view, no auto-close timer — the modal
 * closes at once and the shell confirms via toast (success) or a
 * persistent banner (mismatch), with the account name in every message,
 * and the just-connected card flash-highlighted).
 *
 * Instagram adaptations, all honest, none silent:
 * - Direct view navigates to the existing Instagram initiate route
 *   (`/api/connect/instagram?subdomain=…`). The framework initiate
 *   ignores Facebook-style `expected*` params, so none are appended:
 *   mismatch detection is by polling (target id + status/updatedAt),
 *   not by a server-carried expected id.
 * - Magic link: NO Instagram magic-link route exists (searched
 *   `apps/web/src/app/api` — only Facebook's
 *   `/accounts/magic-link` exists), and building one is a new OAuth
 *   flow, not a UI port. The option is therefore shown DISABLED with
 *   the reason in its own text ("Magic link isn't available for
 *   Instagram yet — use This Browser for now"), preserving the
 *   choose-view layout without faking a link.
 * - Polling runs while the modal is open (Facebook polls only in its
 *   magic view, which Instagram has no equivalent of): if an account
 *   appears or refreshes while the modal is open — e.g. completed in
 *   another tab — the modal closes with the matching notice.
 */
import * as React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { LinkIcon, MonitorIcon } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Button } from '@/components/shared/ui/button';
import { api, buildTenantApiPath } from '@/lib/api';
import { ListInstagramAccountsResponseSchema } from '@fbuploadpro/contracts';
import { reportError } from '@/lib/report-error';

export interface InstagramAccountStateRecord {
  status?: string | undefined;
  updatedAt?: string | undefined;
}

export interface InstagramAccountSnapshot {
  id: string;
  externalAccountId?: string | undefined;
  displayName?: string | undefined;
  status?: string | undefined;
  updatedAt?: string | undefined;
}

export interface InstagramConnectAccountModalProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccountConnected: () => void;
  onConnectionNotice?: (notice: {
    type: 'success' | 'error';
    message: string;
    /** Id of the account that was connected/refreshed, when known — used to highlight its card. */
    accountId?: string | undefined;
  }) => void;
  existingAccountIds?: string[];
  reconnectingAccount?: {
    id: string;
    externalAccountId?: string | undefined;
    displayName: string;
    status?: string | undefined;
    updatedAt?: string | undefined;
  } | null;
  initialAccounts?: InstagramAccountSnapshot[];
}

export type InstagramPollOutcome =
  | { matched: false }
  | {
      matched: true;
      kind: 'connected';
      accountId: string;
      accountName?: string | undefined;
    }
  | {
      matched: true;
      kind: 'already_connected';
      accountId: string;
      accountName: string;
    }
  | {
      matched: true;
      kind: 'reconnected_mismatch';
      accountId: string;
      newAccountName: string;
      expectedAccountName: string;
    };

function isAccountUpdatedInSnapshot(
  acc: InstagramAccountSnapshot,
  initialIds: Set<string>,
  initialStates: Map<string, InstagramAccountStateRecord>
): boolean {
  if (!initialIds.has(acc.id)) {
    return true;
  }
  const prevState = initialStates.get(acc.id);
  if (!prevState) {
    return false;
  }
  if (prevState.status === 'expired' && acc.status === 'active') {
    return true;
  }
  return Boolean(acc.updatedAt && prevState.updatedAt && acc.updatedAt !== prevState.updatedAt);
}

function isTargetReconnected(
  acc: InstagramAccountSnapshot,
  reconnectingAccount: NonNullable<InstagramConnectAccountModalProps['reconnectingAccount']>,
  initialStates: Map<string, InstagramAccountStateRecord>
): boolean {
  const isMatchingId =
    acc.id === reconnectingAccount.id ||
    Boolean(
      reconnectingAccount.externalAccountId &&
        acc.externalAccountId === reconnectingAccount.externalAccountId
    );
  if (!isMatchingId) {
    return false;
  }
  const prevState = initialStates.get(acc.id);
  const prevStatus = prevState?.status ?? reconnectingAccount.status ?? 'expired';
  if (prevStatus === 'expired' && acc.status === 'active') {
    return true;
  }
  const prevUpdatedAt = prevState?.updatedAt ?? reconnectingAccount.updatedAt;
  return Boolean(acc.updatedAt && prevUpdatedAt && acc.updatedAt !== prevUpdatedAt);
}

export function evaluateInstagramConnectionPoll(
  accounts: InstagramAccountSnapshot[],
  initialIds: Set<string>,
  initialStates: Map<string, InstagramAccountStateRecord>,
  reconnectingAccount?: InstagramConnectAccountModalProps['reconnectingAccount']
): InstagramPollOutcome {
  if (reconnectingAccount) {
    const targetAcc = accounts.find((acc) =>
      isTargetReconnected(acc, reconnectingAccount, initialStates)
    );
    if (targetAcc) {
      return {
        matched: true,
        kind: 'connected',
        accountId: targetAcc.id,
        accountName: targetAcc.displayName,
      };
    }
    const differentAcc = accounts.find(
      (acc) =>
        acc.id !== reconnectingAccount.id &&
        isAccountUpdatedInSnapshot(acc, initialIds, initialStates)
    );
    if (differentAcc) {
      return {
        matched: true,
        kind: 'reconnected_mismatch',
        accountId: differentAcc.id,
        newAccountName: differentAcc.displayName || 'another account',
        expectedAccountName: reconnectingAccount.displayName,
      };
    }
    return { matched: false };
  }

  const newAcc = accounts.find((acc) => !initialIds.has(acc.id));
  if (newAcc) {
    return {
      matched: true,
      kind: 'connected',
      accountId: newAcc.id,
      accountName: newAcc.displayName,
    };
  }

  const refreshedAcc = accounts.find((acc) =>
    isAccountUpdatedInSnapshot(acc, initialIds, initialStates)
  );
  if (refreshedAcc) {
    return {
      matched: true,
      kind: 'already_connected',
      accountId: refreshedAcc.id,
      accountName: refreshedAcc.displayName || 'Account',
    };
  }

  return { matched: false };
}

const EMPTY_IDS: string[] = [];
const EMPTY_ACCOUNTS: InstagramAccountSnapshot[] = [];
/** How often to poll for a connection completed while the modal is open. */
const INSTAGRAM_POLL_INTERVAL_MS = 3000;

interface InstagramConnectOptionButtonProps {
  testId: string;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  actionHint?: string | undefined;
}

function InstagramConnectOptionButton({
  testId,
  disabled,
  onClick,
  icon,
  title,
  description,
  actionHint,
}: Readonly<InstagramConnectOptionButtonProps>) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-md border border-line px-6 py-4 text-left transition-colors outline-none hover:border-link hover:bg-subtle focus-visible:outline-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex shrink-0 items-center justify-center text-link">{icon}</div>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-body font-semibold text-ink">{title}</div>
        <div className="text-body leading-body text-ink-sub">{description}</div>
        {actionHint && <div className="mt-1 text-metadata text-ink-dim">{actionHint}</div>}
      </div>

      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0 text-ink-dim"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}

export function InstagramConnectAccountModal({
  subdomain,
  open,
  onOpenChange,
  onAccountConnected,
  onConnectionNotice,
  existingAccountIds = EMPTY_IDS,
  reconnectingAccount = null,
  initialAccounts = EMPTY_ACCOUNTS,
}: Readonly<InstagramConnectAccountModalProps>) {
  const [isDirectConnecting, setIsDirectConnecting] = useState(false);

  const wasOpenRef = useRef(false);
  const initialAccountIdsRef = useRef<Set<string>>(new Set(existingAccountIds));
  const initialAccountStatesRef = useRef<Map<string, InstagramAccountStateRecord>>(
    new Map()
  );

  // Reset state when modal transitions to open, and snapshot the
  // accounts present at open so polling can tell new/refreshed apart.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setIsDirectConnecting(false);

      const ids = new Set<string>(existingAccountIds);
      const stateMap = new Map<string, InstagramAccountStateRecord>();
      for (const acc of initialAccounts) {
        ids.add(acc.id);
        stateMap.set(acc.id, { status: acc.status, updatedAt: acc.updatedAt });
      }
      if (reconnectingAccount) {
        ids.add(reconnectingAccount.id);
        stateMap.set(reconnectingAccount.id, {
          status: reconnectingAccount.status ?? 'expired',
          updatedAt: reconnectingAccount.updatedAt,
        });
      }
      initialAccountIdsRef.current = ids;
      initialAccountStatesRef.current = stateMap;
    }
    wasOpenRef.current = open;
  }, [open, existingAccountIds, initialAccounts, reconnectingAccount]);

  // Handle Direct Connection redirect (existing Instagram flow).
  const handleDirectConnect = () => {
    setIsDirectConnecting(true);
    window.location.href = `/api/connect/instagram?subdomain=${encodeURIComponent(subdomain)}`;
  };

  // Check for newly connected or reconnected account.
  const pollAccounts = useCallback(async () => {
    try {
      const data = await api.get(buildTenantApiPath(subdomain, '/instagram/accounts'), {
        schema: ListInstagramAccountsResponseSchema,
      });
      const accounts: InstagramAccountSnapshot[] = (data.accounts || []).map((a) => ({
        id: a.id,
        externalAccountId: a.externalAccountId,
        displayName: a.displayName,
        status: a.status,
        updatedAt: a.updatedAt ? new Date(a.updatedAt).toISOString() : undefined,
      }));

      const outcome = evaluateInstagramConnectionPoll(
        accounts,
        initialAccountIdsRef.current,
        initialAccountStatesRef.current,
        reconnectingAccount
      );

      if (outcome.matched) {
        if (outcome.kind === 'reconnected_mismatch') {
          onConnectionNotice?.({
            type: 'error',
            message: `You signed into ${outcome.newAccountName} instead of ${outcome.expectedAccountName}. ${outcome.expectedAccountName} still needs to be reconnected.`,
            accountId: outcome.accountId,
          });
        } else if (outcome.kind === 'already_connected') {
          onConnectionNotice?.({
            type: 'success',
            message: `${outcome.accountName} already connected — session refreshed`,
            accountId: outcome.accountId,
          });
        } else {
          onConnectionNotice?.({
            type: 'success',
            message: `${outcome.accountName ?? 'Instagram account'} connected`,
            accountId: outcome.accountId,
          });
        }

        onAccountConnected();
        onOpenChange(false);
      }
    } catch (error) {
      // Polling failures are reported and retried on the next cycle.
      reportError(error, { source: 'instagram-connect-account-poll' });
    }
  }, [subdomain, onAccountConnected, onConnectionNotice, onOpenChange, reconnectingAccount]);

  // Poll while the modal is open (Instagram has no magic view to stay
  // in, so the open modal itself is the polling window).
  useEffect(() => {
    if (!open) return;
    const pollInterval = setInterval(() => {
      void pollAccounts();
    }, INSTAGRAM_POLL_INTERVAL_MS);
    return () => clearInterval(pollInterval);
  }, [open, pollAccounts]);

  const modalTitle = reconnectingAccount
    ? `Reconnect ${reconnectingAccount.displayName}`
    : 'Connect Instagram Account';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-125" data-testid="instagram-connect-account-modal">
        <DialogHeader>
          <DialogTitle>{modalTitle}</DialogTitle>
          <DialogDescription>
            Choose where your Instagram account is currently logged in:
          </DialogDescription>
        </DialogHeader>

        <div>
          <div className="flex flex-col gap-4">
            <InstagramConnectOptionButton
              testId="instagram-connect-option-direct"
              disabled={isDirectConnecting}
              onClick={handleDirectConnect}
              title={isDirectConnecting ? 'Redirecting to Instagram...' : 'This Browser'}
              description="Choose this if you are already logged into Instagram in this browser window."
              actionHint="Direct Instagram authorization in this window"
              icon={<MonitorIcon className="size-5.5" aria-hidden />}
            />

            <InstagramConnectOptionButton
              testId="instagram-connect-option-magic"
              disabled
              onClick={() => undefined}
              title="Different Browser or Phone"
              description="Choose this if your Instagram account is open in another browser, private window, or on your mobile device."
              actionHint="Magic link isn't available for Instagram yet — use This Browser for now."
              icon={<LinkIcon className="size-5.5" aria-hidden />}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="instagram-connect-close-btn"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
