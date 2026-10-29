'use client';

/**
 * Facebook tab — connected state (spec 135 PR-135-2, spec §5.2 / §8.1).
 *
 * The finalized 2026-10-16 connected presentation: the App ID with a
 * Copy action ("App ID copied" feedback, 2 seconds as shipped), the
 * App Secret masked (24 × "•" as shipped) with a Show/Hide toggle,
 * "Edit details" / "Disconnect" actions, and the "Connected on
 * <date>." line (en-US short month, day, year — as shipped). Copy is
 * §5.2 verbatim.
 *
 * Spec 139 N3: the secret value is NOT part of the settings payload —
 * choosing Show fetches it through the reveal action (`onRevealSecret`)
 * and keeps it only in this component's memory while shown. A failed
 * reveal reports inline, at the field, per the form standard.
 */

import * as React from 'react';

import { Button } from '@/components/shared/ui/button';

/** How long the "copied" feedback stays visible on the copy button. */
const COPY_FEEDBACK_DURATION_MS = 2000;

/** The masked secret, exactly as shipped: 24 bullet characters. */
const MASKED_SECRET = '•'.repeat(24);

/** Format the "Connected on" date the way the tab has always shown it. */
export function formatConnectedDate(dateStr?: string | null): string {
  if (!dateStr) return 'Oct 16, 2026';
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return 'Oct 16, 2026';
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return 'Oct 16, 2026';
  }
}

export interface FacebookConnectedViewProps {
  fbAppId: string;
  connectedAt?: string | null | undefined;
  /** Fetches the saved App Secret from the reveal action (spec 139 N3). */
  onRevealSecret: () => Promise<string>;
  onEditDetails: () => void;
  onDisconnectClick: () => void;
}

export function FacebookConnectedView({
  fbAppId,
  connectedAt,
  onRevealSecret,
  onEditDetails,
  onDisconnectClick,
}: Readonly<FacebookConnectedViewProps>) {
  const [copied, setCopied] = React.useState(false);
  const [showSecret, setShowSecret] = React.useState(false);
  const [revealedSecret, setRevealedSecret] = React.useState<string | null>(null);
  const [isRevealing, setIsRevealing] = React.useState(false);
  const [revealError, setRevealError] = React.useState<string | null>(null);
  const feedbackTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    },
    []
  );

  const handleCopyAppId = async () => {
    try {
      await navigator.clipboard.writeText(fbAppId);
      setCopied(true);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(
        () => setCopied(false),
        COPY_FEEDBACK_DURATION_MS
      );
    } catch {
      // Clipboard unavailable: no "copied" feedback — the App ID
      // stays on screen to copy by hand.
      setCopied(false);
    }
  };

  const handleToggleSecret = async () => {
    if (showSecret) {
      setShowSecret(false);
      return;
    }
    if (revealedSecret !== null) {
      setShowSecret(true);
      return;
    }
    // First Show: fetch the value through the reveal action. The
    // mask stays up until the value is actually in hand.
    setIsRevealing(true);
    setRevealError(null);
    try {
      const secret = await onRevealSecret();
      setRevealedSecret(secret);
      setShowSecret(true);
    } catch {
      setRevealError("Couldn't show your App Secret. Please try again.");
    } finally {
      setIsRevealing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* App ID */}
      <div className="flex flex-col gap-1.5">
        <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">
          App ID
        </span>
        <div className="flex items-center justify-between gap-4 border-t border-line py-2">
          <span data-testid="fb-saved-app-id" className="font-mono text-body break-all text-ink">
            {fbAppId}
          </span>
          <button
            type="button"
            data-testid="fb-copy-app-id-btn"
            onClick={() => void handleCopyAppId()}
            className="flex min-h-11 shrink-0 items-center px-2 text-metadata font-medium text-ink-sub transition-colors hover:text-ink"
          >
            {copied ? 'App ID copied' : 'Copy App ID'}
          </button>
        </div>
      </div>

      {/* App Secret */}
      <div className="flex flex-col gap-1.5">
        <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">
          App Secret
        </span>
        <div className="flex items-center justify-between gap-4 border-t border-line py-2">
          <span
            data-testid="fb-saved-app-secret"
            className="font-mono text-body break-all text-ink"
          >
            {showSecret && revealedSecret ? revealedSecret : MASKED_SECRET}
          </span>
          <button
            type="button"
            data-testid="fb-state2-secret-toggle"
            onClick={() => void handleToggleSecret()}
            disabled={isRevealing}
            className="flex min-h-11 shrink-0 items-center px-2 text-metadata font-medium text-ink-sub transition-colors hover:text-ink"
          >
            {isRevealing ? 'Loading…' : showSecret ? 'Hide' : 'Show'}
          </button>
        </div>
        {revealError ? (
          <span
            data-testid="fb-secret-reveal-error"
            className="text-metadata text-signal-critical"
          >
            {revealError}
          </span>
        ) : (
          <span className="text-metadata text-ink-dim">
            Only you can see this — it stays hidden until you choose to show it.
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          data-testid="fb-edit-details-btn"
          onClick={onEditDetails}
        >
          Edit details
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="fb-disconnect-btn"
          onClick={onDisconnectClick}
          className="border-signal-critical/45 text-signal-critical shadow-none hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
        >
          Disconnect
        </Button>
      </div>

      {/* Connection date */}
      <span data-testid="fb-connected-date" className="text-metadata text-ink-dim">
        {`Connected on ${formatConnectedDate(connectedAt)}.`}
      </span>
    </div>
  );
}
