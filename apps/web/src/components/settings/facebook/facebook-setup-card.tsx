'use client';

/**
 * Facebook tab — "One more step" sign-in-address card (spec 135
 * PR-135-2, spec §5.2 / §8.1).
 *
 * Shown ONLY while the workspace has no saved Facebook app details or
 * while those details are being edited; the connected view never
 * mounts it (the visibility rule is the container's, §5.2). The
 * address comes from the existing callback-URL helper
 * (`lib/platforms/callback-urls`) — the value is computed from the
 * app origin, never hard-coded here, so the address shown can never
 * drift from the address the connect flow actually uses.
 *
 * Copy is spec §5.2 verbatim, including Meta's own field name
 * ("Valid OAuth Redirect URIs"), carried like "App ID" / "App Secret".
 */

import * as React from 'react';

import { getPlatformCallbackUrl } from '@/lib/platforms/callback-urls';

/** How long the "Copied" feedback stays visible (as shipped). */
const COPY_FEEDBACK_DURATION_MS = 2000;

export function FacebookSetupCard() {
  const callbackUrl = getPlatformCallbackUrl('facebook', 'signIn');
  const [copied, setCopied] = React.useState(false);
  const feedbackTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    },
    []
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(
        () => setCopied(false),
        COPY_FEEDBACK_DURATION_MS
      );
    } catch {
      // Clipboard unavailable (permissions / insecure context): no
      // "copied" feedback — the address stays on screen for the user
      // to copy by hand.
      setCopied(false);
    }
  };

  return (
    <section
      data-testid="fb-one-more-step-card"
      aria-labelledby="fb-one-more-step-heading"
      className="flex flex-col gap-4"
    >
      <div>
        <h3 id="fb-one-more-step-heading" className="text-lg font-semibold text-ink">
          One more step
        </h3>
        <p className="mt-1 text-body text-ink-sub">
          Add this address to your Meta app so Facebook can bring you back here after you
          sign in.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">
          Sign-in address
        </span>
        <div className="flex items-center justify-between gap-4 border-t border-line py-2">
          <span
            id="fb-callback-url-display"
            data-testid="fb-signin-address"
            className="min-w-0 break-all font-mono text-metadata text-link"
          >
            {callbackUrl}
          </span>
          <button
            type="button"
            data-testid="fb-copy-callback-btn"
            onClick={() => void handleCopy()}
            className="flex min-h-11 shrink-0 items-center px-2 text-metadata font-medium text-ink-sub transition-colors hover:text-ink"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <span className="text-metadata text-ink-dim">
          {'Paste this into the "Valid OAuth Redirect URIs" field in your Meta app.'}
        </span>
      </div>
    </section>
  );
}
