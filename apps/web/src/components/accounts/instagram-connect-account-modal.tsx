'use client';

/**
 * Instagram connect account modal — Facebook's `ConnectAccountModal`
 * pattern exactly (shared/ui `Dialog`, choose view with two option
 * buttons, magic view with copy + countdown, polling of the accounts
 * list, and connected / already-connected / reconnected-mismatch
 * notices with the same Option-B dialogue: no success view, no
 * auto-close timer — the modal closes at once and the shell confirms
 * via toast (success) or a persistent banner (mismatch), with the
 * account name in every message, and the just-connected card
 * flash-highlighted).
 *
 * Instagram adaptations:
 * - Direct view navigates to the dedicated Instagram initiate route
 *   (`/api/auth/instagram`), Facebook's `/api/auth/facebook`
 *   equivalent: session + BYOC + signed OAuth state, no picker.
 * - Magic view generates a 15-minute Instagram magic link
 *   (`POST /instagram/accounts/magic-link`) and polls while the link
 *   is live, exactly like Facebook's magic view.
 * - Polling also runs while the modal is open in the choose view: if
 *   an account appears or refreshes while the modal is open — e.g.
 *   completed in another tab — the modal closes with the matching
 *   notice.
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
import { Input } from '@/components/shared/ui/input';
import { api, buildTenantApiPath } from '@/lib/api';
import { ListInstagramAccountsResponseSchema } from '@fbuploadpro/contracts';
import { MagicLinkResponseSchema } from '@/lib/api/schemas/accounts';
import { reportError } from '@/lib/report-error';
import { cn } from '@/lib/utils';

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

function formatTimer(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export function buildInstagramDirectConnectUrl(
  reconnectingAccount?: InstagramConnectAccountModalProps['reconnectingAccount']
): string {
  if (!reconnectingAccount) {
    return '/api/auth/instagram';
  }
  const params = new URLSearchParams();
  if (reconnectingAccount.externalAccountId) {
    params.set('expectedInstagramAccountId', reconnectingAccount.externalAccountId);
  }
  params.set('expectedDisplayName', reconnectingAccount.displayName);
  return `/api/auth/instagram?${params.toString()}`;
}

interface InstagramMagicLinkViewProps {
  magicUrl: string | null;
  remainingSeconds: number;
  copySuccess: boolean;
  isGeneratingMagic: boolean;
  onCopyLink: () => void;
  onRegenerateLink: () => void;
}

export function InstagramMagicLinkView({
  magicUrl,
  remainingSeconds,
  copySuccess,
  isGeneratingMagic,
  onCopyLink,
  onRegenerateLink,
}: Readonly<InstagramMagicLinkViewProps>) {
  const isExpired = remainingSeconds <= 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-body leading-body text-ink-sub">
        Open this link in the browser or mobile window where your Instagram account is currently logged in. Once you approve access there, this window will update automatically.
      </p>

      {isExpired ? (
        <Button
          type="button"
          data-testid="instagram-magic-regenerate-button"
          disabled={isGeneratingMagic}
          onClick={onRegenerateLink}
          className="w-full"
        >
          {isGeneratingMagic ? 'Generating Magic Link...' : 'Link expired — Generate a new link'}
        </Button>
      ) : (
        <div className="flex items-center gap-1">
          <Input
            type="text"
            readOnly
            data-testid="instagram-magic-url-input"
            value={magicUrl ?? ''}
            onClick={onCopyLink}
            className="flex-1 cursor-pointer bg-canvas font-mono"
          />

          <Button
            type="button"
            data-testid="instagram-magic-copy-button"
            onClick={onCopyLink}
            className={cn(copySuccess && 'bg-brand-emerald hover:bg-brand-emerald')}
          >
            {copySuccess ? 'Copied!' : 'Copy Link'}
          </Button>
        </div>
      )}

      {/* Countdown & Status — text only, no status dot (no-dots rule). */}
      <div className="flex items-center justify-between rounded-sm bg-subtle px-3.5 py-2.5 text-metadata text-ink-dim">
        <span>{isExpired ? 'Magic link expired' : 'Waiting for Instagram approval...'}</span>

        <span data-testid="instagram-magic-countdown" className="font-medium">
          {isExpired ? 'Link expired' : `Link expires in ${formatTimer(remainingSeconds)}`}
        </span>
      </div>
    </div>
  );
}

const EMPTY_IDS: string[] = [];
const EMPTY_ACCOUNTS: InstagramAccountSnapshot[] = [];
/** How long the "copied" feedback stays visible on copy buttons. */
const COPY_FEEDBACK_DURATION_MS = 2000;
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
  const [view, setView] = useState<'choose' | 'magic'>('choose');
  const [isDirectConnecting, setIsDirectConnecting] = useState(false);
  const [magicUrl, setMagicUrl] = useState<string | null>(null);
  const [isGeneratingMagic, setIsGeneratingMagic] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(900); // 15 minutes
  const [magicError, setMagicError] = useState<string | null>(null);

  const wasOpenRef = useRef(false);
  const initialAccountIdsRef = useRef<Set<string>>(new Set(existingAccountIds));
  const initialAccountStatesRef = useRef<Map<string, InstagramAccountStateRecord>>(
    new Map()
  );

  // Reset state when modal transitions to open, and snapshot the
  // accounts present at open so polling can tell new/refreshed apart.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setView('choose');
      setIsDirectConnecting(false);
      setMagicUrl(null);
      setCopySuccess(false);
      setRemainingSeconds(900);
      setMagicError(null);

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

  // Handle Direct Connection redirect (dedicated Instagram OAuth
  // initiate, Facebook's `/api/auth/facebook` equivalent).
  const handleDirectConnect = () => {
    setIsDirectConnecting(true);
    window.location.href = buildInstagramDirectConnectUrl(reconnectingAccount);
  };

  // Generate Magic Link
  const handleStartMagicLink = async () => {
    setIsGeneratingMagic(true);
    setMagicError(null);
    try {
      const body = reconnectingAccount
        ? {
            expectedInstagramAccountId: reconnectingAccount.externalAccountId,
            expectedDisplayName: reconnectingAccount.displayName,
          }
        : undefined;
      const data = await api.post(
        buildTenantApiPath(subdomain, '/instagram/accounts/magic-link'),
        body,
        { schema: MagicLinkResponseSchema }
      );
      setMagicUrl(data.magicUrl);
      setRemainingSeconds(data.expiresInSeconds);
      setView('magic');
    } catch (error) {
      reportError(error, { source: 'instagram-connect-account-magic-link' });
      setMagicError("Couldn't generate the magic link. Please try again.");
    } finally {
      setIsGeneratingMagic(false);
    }
  };

  // Copy to clipboard
  const handleCopyLink = async () => {
    if (!magicUrl) return;
    try {
      await navigator.clipboard.writeText(magicUrl);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), COPY_FEEDBACK_DURATION_MS);
    } catch {
      // Clipboard write failure falls back to manual link selection.
      setCopySuccess(false);
    }
  };

  const isLinkExpired = remainingSeconds <= 0;

  // Live countdown timer for Magic Link
  useEffect(() => {
    if (view !== 'magic' || !open || isLinkExpired) return;
    const interval = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [view, open, isLinkExpired]);

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
            {view === 'choose' && 'Choose where your Instagram account is currently logged in:'}
            {view === 'magic' && 'Open this link in the browser or mobile device where you are logged into Instagram.'}
          </DialogDescription>
        </DialogHeader>

        <div>
          {magicError && (
            <div className="mb-4 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2 text-body text-signal-critical-on-tint">
              {magicError}
            </div>
          )}

          {view === 'choose' && (
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
                disabled={isGeneratingMagic}
                onClick={() => {
                  void handleStartMagicLink();
                }}
                title={isGeneratingMagic ? 'Generating Secure Link...' : 'Different Browser or Phone'}
                description="Choose this if your Instagram account is open in another browser, private window, or on your mobile device."
                actionHint="Generates a secure link you can open on any device (valid for 15 minutes)"
                icon={<LinkIcon className="size-5.5" aria-hidden />}
              />
            </div>
          )}

          {view === 'magic' && (
            <InstagramMagicLinkView
              magicUrl={magicUrl}
              remainingSeconds={remainingSeconds}
              copySuccess={copySuccess}
              isGeneratingMagic={isGeneratingMagic}
              onCopyLink={() => {
                void handleCopyLink();
              }}
              onRegenerateLink={() => {
                void handleStartMagicLink();
              }}
            />
          )}
        </div>

        <DialogFooter>
          {view === 'magic' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setView('choose')}
              className="mr-auto"
            >
              Back
            </Button>
          )}

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
