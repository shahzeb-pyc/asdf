'use client';

/**
 * Platform credentials — "One more step" card and guide primitives
 * (spec 135 PR-135-3, spec §8.2).
 *
 * The setup card shows the address (or addresses) the user must paste
 * into the platform's own settings, each with a Copy button and its
 * helper line — the same research setup/address pattern as the
 * Facebook tab's card (§6.5), generalised to the per-platform address
 * lists Instagram and Threads supply. The card is mounted by the
 * container only in the add/edit states, never in the connected
 * state (§5.3/§5.4 visibility rule).
 *
 * The guide-step primitives (`SettingsGuideStep`, `GuideDivider`,
 * `MetaDashboardLink`) are consumed by the per-platform views, whose
 * approved guide copy (§5.3/§5.4) renders through them verbatim.
 * Restyled onto tokens/primitives — the legacy inline styles and
 * `lib/theme` presets are deleted with the old shared file.
 */

import * as React from 'react';

/** How long the "Copied" feedback stays visible (as shipped). */
const COPY_FEEDBACK_DURATION_MS = 2000;

const LABEL_CLASS_NAME =
  'text-metadata font-medium tracking-caption text-ink-dim uppercase';

export function SettingsGuideStep({
  number,
  title,
  children,
}: Readonly<{ number: number; title: string; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-metadata font-semibold text-ink-sub"
        >
          {number}
        </span>
        <h4 className="text-body font-semibold text-ink">{title}</h4>
      </div>
      <div className="pl-8 text-body text-ink-sub">{children}</div>
    </div>
  );
}

export function GuideDivider() {
  return <div aria-hidden="true" className="h-px w-full bg-line" />;
}

/** Link to the Meta App Dashboard, styled like the Facebook guide's link. */
export function MetaDashboardLink({
  testIdPrefix,
}: Readonly<{ testIdPrefix: string }>) {
  return (
    <a
      href="https://developers.facebook.com"
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`${testIdPrefix}-meta-dashboard-link`}
      className="font-semibold text-link hover:underline"
    >
      Meta App Dashboard →
    </a>
  );
}

export interface SetupAddress {
  key: string;
  label: string;
  url: string;
  helper?: string | undefined;
}

/**
 * The "One more step" card: shows the address (or addresses) the user must
 * paste into the platform's own settings, each with a Copy button.
 *
 * `bare` (2026-10-25 redesign): render without the card chrome — no
 * border, background, padding, or shadow — for tabs whose panel already
 * provides the card, where the step is folded into that panel instead
 * of floating as a separate card. Classic tabs omit `bare` and keep
 * the card exactly as before.
 */
export function PlatformSetupCard({
  testIdPrefix,
  description,
  addresses,
  bare = false,
}: Readonly<{
  testIdPrefix: string;
  description: string;
  addresses: SetupAddress[];
  bare?: boolean;
}>) {
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const feedbackTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    },
    []
  );

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(
        () => setCopiedKey(null),
        COPY_FEEDBACK_DURATION_MS
      );
    } catch {
      // Clipboard unavailable; the address stays visible for manual copying.
      setCopiedKey(null);
    }
  };

  return (
    <section
      data-testid={`${testIdPrefix}-one-more-step-card`}
      aria-labelledby={`${testIdPrefix}-one-more-step-heading`}
      className={
        bare
          ? 'flex flex-col gap-4'
          : 'flex flex-col gap-6 rounded-md border border-line bg-panel p-6 shadow-card'
      }
    >
      <div>
        <h3
          id={`${testIdPrefix}-one-more-step-heading`}
          className="text-lg font-semibold text-ink"
        >
          One more step
        </h3>
        <p className="mt-1 text-body text-ink-sub">{description}</p>
      </div>

      {addresses.map((address) => (
        <div key={address.key} className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS_NAME}>{address.label}</span>
          <div className="flex items-center justify-between gap-4 border-t border-line py-2">
            <span
              data-testid={`${testIdPrefix}-setup-address-${address.key}`}
              className="min-w-0 font-mono text-metadata break-all text-link"
            >
              {address.url}
            </span>
            <button
              type="button"
              data-testid={`${testIdPrefix}-copy-${address.key}-btn`}
              onClick={() => void handleCopy(address.key, address.url)}
              className="flex min-h-11 shrink-0 items-center px-2 text-metadata font-medium text-ink-sub transition-colors hover:text-ink"
            >
              {copiedKey === address.key ? 'Copied' : 'Copy'}
            </button>
          </div>
          {address.helper && (
            <span className="text-metadata text-ink-dim">{address.helper}</span>
          )}
        </div>
      ))}
    </section>
  );
}
