'use client';

/**
 * Connect account modal (spec 131 PR-131-1, spec §8.2) — rebuilt on
 * the shared/ui `Dialog` primitive (the legacy ui dialog
 * import is deleted) with token-backed utilities only. Its two raw
 * fetches (magic-link generation + connection polling) now go through
 * the typed API client with zod schemas (spec §8.1); the poll outcome
 * helpers (`evaluateAccountConnectionPoll`, `buildDirectConnectUrl`)
 * and all copy/testids are preserved verbatim for parity.
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
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  ListFacebookAccountsResponseSchema,
  MagicLinkResponseSchema,
} from '@/lib/api/schemas/accounts';
import { reportError } from '@/lib/report-error';
import { cn } from '@/lib/utils';

// Audit BG15/BG19: the pure poll helpers live in ./connect-poll
// (unit-testable without mounting the dialog) and are re-exported
// here so existing imports keep working.
import {
  evaluateAccountConnectionPoll,
  fetchAllAccountsForPoll,
  type AccountSnapshot,
  type AccountStateRecord,
} from '@/components/accounts/connect-poll';
export {
  evaluateAccountConnectionPoll,
  isAccountConnectionEvent,
  type AccountSnapshot,
  type AccountStateRecord,
  type PollOutcome,
  type ReconnectingAccount,
} from '@/components/accounts/connect-poll';

export interface ConnectAccountModalProps {
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccountConnected: () => void;
  onConnectionNotice?: (notice: {
    type: 'success' | 'error';
    message: string;
    /** Id of the account that was connected/refreshed, when known — used to highlight its card. */
    accountId?: string | undefined;
    /** BL2 fix: display name of the expected account on a mismatch, when known. */
    expectedAccountName?: string | undefined;
  }) => void;
  existingAccountIds?: string[];
  reconnectingAccount?: {
    id: string;
    fbAccountId?: string | undefined;
    displayName: string;
    status?: string | undefined;
    updatedAt?: string | undefined;
  } | null;
  initialAccounts?: AccountSnapshot[];
}

function formatTimer(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export function buildDirectConnectUrl(
  reconnectingAccount?: ConnectAccountModalProps['reconnectingAccount']
): string {
  if (!reconnectingAccount) {
    return '/api/auth/facebook';
  }
  const params = new URLSearchParams();
  if (reconnectingAccount.fbAccountId) {
    params.set('expectedFbAccountId', reconnectingAccount.fbAccountId);
  }
  params.set('expectedDisplayName', reconnectingAccount.displayName);
  return `/api/auth/facebook?${params.toString()}`;
}

interface ConnectOptionButtonProps {
  testId: string;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  actionHint?: string | undefined;
}

function ConnectOptionButton({
  testId,
  disabled,
  onClick,
  icon,
  title,
  description,
  actionHint,
}: Readonly<ConnectOptionButtonProps>) {
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

interface MagicLinkViewProps {
  magicUrl: string | null;
  remainingSeconds: number;
  copySuccess: boolean;
  isGeneratingMagic: boolean;
  onCopyLink: () => void;
  onRegenerateLink: () => void;
  /** Audit UX3: visible poll-failure surface, when present. */
  pollNotice?:
    | { kind: 'transient' | 'signed-out'; message: string }
    | null
    | undefined;
}

export function MagicLinkView({
  magicUrl,
  remainingSeconds,
  copySuccess,
  isGeneratingMagic,
  onCopyLink,
  onRegenerateLink,
  pollNotice,
}: Readonly<MagicLinkViewProps>) {
  const isExpired = remainingSeconds <= 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-body leading-body text-ink-sub">
        Open this link in the browser or mobile window where your Facebook account is currently logged in. Once you approve access there, this window will update automatically.
      </p>

      {isExpired ? (
        <Button
          type="button"
          data-testid="magic-regenerate-button"
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
            data-testid="magic-url-input"
            value={magicUrl ?? ''}
            onClick={onCopyLink}
            className="flex-1 cursor-pointer bg-canvas font-mono"
          />

          <Button
            type="button"
            data-testid="magic-copy-button"
            onClick={onCopyLink}
            className={cn(copySuccess && 'bg-brand-emerald hover:bg-brand-emerald')}
          >
            {copySuccess ? 'Copied!' : 'Copy Link'}
          </Button>
        </div>
      )}

      {/* Countdown & Status — text only, no status dot (no-dots rule). */}
      <div className="flex items-center justify-between rounded-sm bg-subtle px-3.5 py-2.5 text-metadata text-ink-dim">
        <span>{isExpired ? 'Magic link expired' : 'Waiting for Facebook approval...'}</span>

        <span data-testid="magic-countdown" className="font-medium">
          {isExpired ? 'Link expired' : `Link expires in ${formatTimer(remainingSeconds)}`}
        </span>
      </div>

      {/* Audit UX3: poll failures used to be silent — a signed-out
          session or repeated check failures now say so in the open
          modal instead of waiting unexplained until minute 15. */}
      {pollNotice ? (
        <div
          role={pollNotice.kind === 'signed-out' ? 'alert' : 'status'}
          data-testid="magic-poll-notice"
          className={
            pollNotice.kind === 'signed-out'
              ? 'rounded-sm border border-brand-rose/25 bg-brand-rose/10 px-3 py-2 text-body text-brand-rose'
              : 'rounded-sm border border-brand-gold/25 bg-brand-gold/10 px-3 py-2 text-body text-ink-dim'
          }
        >
          {pollNotice.message}
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_IDS: string[] = [];
const EMPTY_ACCOUNTS: AccountSnapshot[] = [];

/** How long the "copied" feedback stays visible on copy buttons. */
const COPY_FEEDBACK_DURATION_MS = 2000;
/** How often to poll for magic-link connection status. */
const MAGIC_LINK_POLL_INTERVAL_MS = 3000;

export function ConnectAccountModal({
  subdomain,
  open,
  onOpenChange,
  onAccountConnected,
  onConnectionNotice,
  existingAccountIds = EMPTY_IDS,
  reconnectingAccount = null,
  initialAccounts = EMPTY_ACCOUNTS,
}: Readonly<ConnectAccountModalProps>) {
  const [view, setView] = useState<'choose' | 'magic'>('choose');
  const [isDirectConnecting, setIsDirectConnecting] = useState(false);
  const [magicUrl, setMagicUrl] = useState<string | null>(null);
  const [isGeneratingMagic, setIsGeneratingMagic] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(900); // 15 minutes
  const [magicError, setMagicError] = useState<string | null>(null);
  // Audit UX3: visible poll-failure surface. A 401 stops polling
  // (the session is gone; retrying cannot succeed), while repeated
  // transient failures warn but keep waiting.
  const [pollNotice, setPollNotice] = useState<{
    kind: 'transient' | 'signed-out';
    message: string;
  } | null>(null);
  const [pollStopped, setPollStopped] = useState(false);
  const pollFailuresRef = useRef(0);

  const wasOpenRef = useRef(false);
  const initialAccountIdsRef = useRef<Set<string>>(new Set(existingAccountIds));
  // Audit BG15: whether the full-list poll baseline has been
  // established for this open (reset in the open effect below).
  const baselineReadyRef = useRef(false);
  const initialAccountStatesRef = useRef<Map<string, AccountStateRecord>>(
    new Map()
  );

  // Reset state when modal transitions to open
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setView('choose');
      setIsDirectConnecting(false);
      setMagicUrl(null);
      setCopySuccess(false);
      setRemainingSeconds(900);
      setMagicError(null);
      // Audit UX3: a fresh open clears any stale poll notice/stop.
      setPollNotice(null);
      setPollStopped(false);
      pollFailuresRef.current = 0;

      const ids = new Set<string>(existingAccountIds);
      const stateMap = new Map<string, AccountStateRecord>();
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
      // Audit BG15: the full-list baseline is (re)established
      // on the first magic-view tick of this open, never reused
      // from a previous open.
      baselineReadyRef.current = false;
    }
    wasOpenRef.current = open;
  }, [open, existingAccountIds, initialAccounts, reconnectingAccount]);

  // Handle Direct Connection redirect
  const handleDirectConnect = () => {
    setIsDirectConnecting(true);
    window.location.href = buildDirectConnectUrl(reconnectingAccount);
  };

  // Generate Magic Link
  const handleStartMagicLink = async () => {
    setIsGeneratingMagic(true);
    setMagicError(null);
    try {
      const body = reconnectingAccount
        ? {
            expectedFbAccountId: reconnectingAccount.fbAccountId,
            expectedDisplayName: reconnectingAccount.displayName,
          }
        : undefined;
      const data = await api.post(
        buildTenantApiPath(subdomain, '/accounts/magic-link'),
        body,
        { schema: MagicLinkResponseSchema }
      );
      setMagicUrl(data.magicUrl);
      setRemainingSeconds(data.expiresInSeconds);
      // Audit UX3: a fresh link resets the poll-failure surface.
      setPollNotice(null);
      setPollStopped(false);
      pollFailuresRef.current = 0;
      setView('magic');
    } catch (error) {
      reportError(error, { source: 'connect-account-magic-link' });
      // Audit UX6: a BYOC failure must keep its reason and its
      // Settings pointer — the API's 422 message already names
      // both, so surface it verbatim instead of the generic copy
      // (which is what the direct flow's Settings redirect gives).
      setMagicError(
        isApiError(error) && error.status === 422 && error.message
          ? error.message
          : "Couldn't generate the magic link. Please try again."
      );
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

  // Audit BG15: the poll sees the WHOLE list, not just page 1,
  // and its baseline is the full list too. The shell's
  // initialAccounts prop is only its current page slice, so a
  // page-2 account would otherwise read as "newly connected"
  // on the first tick. The first tick in magic view therefore
  // only establishes the full baseline and never matches: a
  // connection landing in the open→first-tick window is
  // absorbed into the baseline (a seconds-long window, versus
  // the old always-broken >30-account case), and every later
  // tick evaluates the full list against it.
  // Check for newly connected or reconnected account
  const pollAccounts = useCallback(async () => {
    try {
      // A signed-out poll stays stopped until a fresh link is made.
      if (pollStopped) return;
      const accounts: AccountSnapshot[] = await fetchAllAccountsForPoll(
        async (page, limit) => {
          const data = await api.get(
            buildTenantApiPath(subdomain, `/accounts?limit=${limit}&page=${page}`),
            { schema: ListFacebookAccountsResponseSchema }
          );
          return {
            accounts: data.accounts as AccountSnapshot[],
            totalPages: data.totalPages ?? 1,
          };
        }
      );

      // A successful tick clears the transient-failure surface.
      pollFailuresRef.current = 0;
      setPollNotice(null);

      if (!baselineReadyRef.current) {
        const ids = new Set<string>(initialAccountIdsRef.current);
        const stateMap = new Map(initialAccountStatesRef.current);
        for (const acc of accounts) {
          ids.add(acc.id);
          stateMap.set(acc.id, { status: acc.status, updatedAt: acc.updatedAt });
        }
        initialAccountIdsRef.current = ids;
        initialAccountStatesRef.current = stateMap;
        baselineReadyRef.current = true;
        return;
      }

      const outcome = evaluateAccountConnectionPoll(
        accounts,
        initialAccountIdsRef.current,
        initialAccountStatesRef.current,
        reconnectingAccount
      );

      if (outcome.matched) {
        // Option B dialogue: no success view and no auto-close timer —
        // the modal closes at once and the shell confirms via toast
        // (success) or a persistent banner (mismatch), with the account
        // name in every message. The mismatched account IS connected
        // (it was upserted by the callback); only the expected account
        // still needs reconnecting.
        if (outcome.kind === 'reconnected_mismatch') {
          // BL2 fix: same two-part copy as the redirect surfaces — the
          // mismatched account IS connected as a separate account.
          onConnectionNotice?.({
            type: 'error',
            message: `${outcome.newAccountName} is now connected as a separate account. ${outcome.expectedAccountName} still needs to be reconnected.`,
            accountId: outcome.accountId,
            expectedAccountName: outcome.expectedAccountName,
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
            message: `${outcome.accountName ?? 'Facebook account'} connected`,
            accountId: outcome.accountId,
          });
        }

        onAccountConnected();
        onOpenChange(false);
      }
    } catch (error) {
      // Audit UX3: poll failures are no longer silent. A 401 means
      // the session died (logout in another tab, session revoked)
      // — polling cannot recover, so it stops with an explicit
      // signed-out notice instead of waiting until minute 15.
      // Transient failures warn after the second consecutive miss
      // but keep polling; a later success clears the warning.
      reportError(error, { source: 'connect-account-poll' });
      if (isApiError(error) && error.status === 401) {
        setPollNotice({
          kind: 'signed-out',
          message:
            'Your session ended, so this window can no longer check for the new connection. Please sign in again, then reopen this dialog.',
        });
        setPollStopped(true);
      } else {
        pollFailuresRef.current += 1;
        if (pollFailuresRef.current >= 2) {
          setPollNotice({
            kind: 'transient',
            message:
              'Having trouble checking for the new connection — still waiting. Check your connection and keep this dialog open.',
          });
        }
      }
    }
  }, [subdomain, onAccountConnected, onConnectionNotice, onOpenChange, reconnectingAccount, pollStopped]);

  // Pure automatic polling every 3 seconds while in magic view and link is not expired
  useEffect(() => {
    if (view !== 'magic' || !open || isLinkExpired || pollStopped) return;

    const pollInterval = setInterval(() => {
      void pollAccounts();
    }, MAGIC_LINK_POLL_INTERVAL_MS);

    return () => clearInterval(pollInterval);
  }, [view, open, isLinkExpired, pollAccounts, pollStopped]);

  const modalTitle = reconnectingAccount
    ? `Reconnect ${reconnectingAccount.displayName}`
    : 'Connect Facebook Account';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-125" data-testid="connect-account-modal">
        <DialogHeader>
          <DialogTitle>{modalTitle}</DialogTitle>
          <DialogDescription>
            {view === 'choose' && 'Choose where your Facebook account is currently logged in:'}
            {view === 'magic' && 'Open this link in the browser or mobile device where you are logged into Facebook.'}
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
              <ConnectOptionButton
                testId="connect-option-direct"
                disabled={isDirectConnecting}
                onClick={handleDirectConnect}
                title={isDirectConnecting ? 'Redirecting to Facebook...' : 'This Browser'}
                description="Choose this if you are already logged into Facebook in this browser window."
                actionHint="Direct Facebook authorization in this window"
                icon={<MonitorIcon className="size-5.5" aria-hidden />}
              />

              <ConnectOptionButton
                testId="connect-option-magic"
                disabled={isGeneratingMagic}
                onClick={() => {
                  void handleStartMagicLink();
                }}
                title={isGeneratingMagic ? 'Generating Secure Link...' : 'Different Browser or Phone'}
                description="Choose this if your Facebook account is open in another browser, private window, or on your mobile device."
                actionHint="Generates a secure link you can open on any device (valid for 15 minutes)"
                icon={<LinkIcon className="size-5.5" aria-hidden />}
              />
            </div>
          )}

          {view === 'magic' && (
            <MagicLinkView
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
              pollNotice={pollNotice}
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
            data-testid="connect-close-btn"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
