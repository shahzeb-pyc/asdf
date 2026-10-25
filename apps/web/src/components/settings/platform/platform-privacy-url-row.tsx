'use client';

/**
 * Platform credentials — Privacy Policy URL row (2026-10-25 redesign).
 *
 * Shown in a redesigned tab's panel in BOTH connected and not-connected
 * states: Meta needs this URL regardless of connection state, so the
 * user can paste it into the Privacy Policy URL field of their Meta
 * app. Copy follows the same 2-second feedback pattern as the Copy App
 * ID and Copy callback buttons elsewhere in these tabs. The URL itself
 * is built by the caller from the workspace subdomain plus the root
 * domain — never hard-coded to one workspace.
 */

import * as React from 'react';

const COPY_FEEDBACK_DURATION_MS = 2000;

export function PlatformPrivacyUrlRow({
  testIdPrefix,
  privacyUrl,
}: Readonly<{ testIdPrefix: string; privacyUrl: string }>) {
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
      await navigator.clipboard.writeText(privacyUrl);
      setCopied(true);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(
        () => setCopied(false),
        COPY_FEEDBACK_DURATION_MS
      );
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="border-t border-line pt-6">
      <div className="flex flex-col gap-1.5">
        <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">
          Privacy Policy URL
        </span>
        <div className="flex items-center justify-between gap-4 border-t border-line py-2">
          <span
            data-testid={`${testIdPrefix}-privacy-url`}
            className="min-w-0 break-all font-mono text-metadata text-link"
          >
            {privacyUrl}
          </span>
          <button
            type="button"
            data-testid={`${testIdPrefix}-copy-privacy-url-btn`}
            onClick={() => void handleCopy()}
            className="flex min-h-11 shrink-0 items-center px-2 text-metadata font-medium text-ink-sub transition-colors hover:text-ink"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <span className="text-metadata text-ink-dim">
          Paste this into the Privacy Policy URL field in your Meta app.
        </span>
      </div>
    </div>
  );
}
