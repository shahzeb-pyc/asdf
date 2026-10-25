'use client';

/**
 * Platform credentials — local status mark (2026-10-25 redesign).
 *
 * Per Shahzeb's standing rule, a redesigned tab NEVER uses a dot for
 * status: connected is a tick in a green circle, not connected is a
 * cross in a red circle. This mark is deliberately LOCAL to the
 * redesigned platform tabs — the shared `StatusDot` primitive is
 * untouched, so every other surface that uses it keeps its existing
 * presentation. Colours come from the design-system signal tokens, so
 * the mark works in light and dark themes; the icon colour is the
 * neutral white used for icons on coloured fills elsewhere in the app.
 * The container renders this mark only for tabs that opt into the
 * two-column variant; classic tabs keep `StatusDot` unchanged.
 */

import * as React from 'react';

import { CheckIcon, XIcon } from 'lucide-react';

export function PlatformStatusMark({
  testIdPrefix,
  connected,
}: Readonly<{ testIdPrefix: string; connected: boolean }>) {
  const label = connected ? 'Connected' : 'Not connected';
  return (
    <span
      data-testid={`${testIdPrefix}-status-mark`}
      data-status={connected ? 'connected' : 'not-connected'}
      role="status"
      aria-label={label}
      className="inline-flex items-center gap-2 text-body font-semibold text-ink"
    >
      <span
        aria-hidden
        className={`flex size-5.5 shrink-0 items-center justify-center rounded-full ${
          connected ? 'bg-signal-operational' : 'bg-signal-critical'
        } text-neutral-white`}
      >
        {connected ? (
          <CheckIcon aria-hidden className="size-3.5" />
        ) : (
          <XIcon aria-hidden className="size-3.5" />
        )}
      </span>
      <span>{label}</span>
    </span>
  );
}
