'use client';

/**
 * Point-of-need credentials gate (Spec 123, Part C — the PR #641 pattern,
 * generalised from the Facebook Accounts gate).
 *
 * Wraps a connect action for a BYOC platform (Instagram / Threads). The
 * gate blocks ONLY when the workspace's app details are known to be
 * missing: while the check is running, and when the check itself fails,
 * the connect action renders as normal (fail open — the Accounts-side
 * check in PR #641 behaves the same way, and the connect route re-checks
 * server-side anyway).
 *
 * Spec 131 PR-131-4: presentation rebuilt on the design system (Banner
 * primitive + token-backed utilities, zero inline styles). Gating
 * semantics are byte-equivalent to before (spec §6.2.2): the exported
 * helpers, step copy, and check behaviour are unchanged.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';

import { Banner } from '@/components/shared/ui/banner';

export type ByocGatePlatform = 'instagram' | 'threads';

export interface ByocGateStatus {
  isLoading: boolean;
  hasCredentials: boolean;
  error: string | null;
}

/**
 * Mirrors isConnectGatedByMissingCredentials from the Facebook Accounts
 * page: gated only when details are known to be missing — not while the
 * check runs, and not when the check failed.
 */
export function isByocGateBlocking(status: ByocGateStatus): boolean {
  return !status.isLoading && !status.hasCredentials && !status.error;
}

export const INSTAGRAM_SETUP_STEPS: string[] = [
  'Create a Meta app for your business.',
  'Add Instagram to the app and finish the Instagram sign-in setup.',
  'Copy the redirect address shown in Settings into your app.',
  'Paste your App ID and App Secret in Settings.',
];

export const THREADS_SETUP_STEPS: string[] = [
  'Open your Meta app and add the Threads use case.',
  'Find the Threads App ID and Threads App Secret — this pair is different from your main app pair, and using the main pair will not work.',
  'Paste the three addresses shown in Settings into the Threads settings.',
  'Save the Threads App ID and App Secret in Settings.',
];

export function defaultSetupSteps(platform: ByocGatePlatform): string[] {
  return platform === 'threads' ? THREADS_SETUP_STEPS : INSTAGRAM_SETUP_STEPS;
}

export interface ByocGatePromptProps {
  platform: ByocGatePlatform;
  platformName: string;
  subdomain: string;
  setupSteps?: string[];
}

export function ByocGatePrompt({
  platform,
  platformName,
  subdomain,
  setupSteps,
}: Readonly<ByocGatePromptProps>) {
  const steps = setupSteps ?? defaultSetupSteps(platform);
  const settingsHref = `/tenant/${subdomain}/settings?tab=${platform}`;
  return (
    <div data-testid="byoc-gate-prompt" className="max-w-140 text-left">
      <Banner
        variant="warning"
        title={`Add your ${platformName} app details first`}
        description={`Before you can connect ${platformName} accounts, your workspace needs its own ${platformName} app details saved in Settings. It only takes a few minutes:`}
      />
      <ol
        data-testid="byoc-gate-steps"
        className="my-2 flex flex-col gap-1 pl-6 text-body leading-relaxed text-ink"
      >
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <Link
        href={settingsHref}
        data-testid="byoc-gate-settings-link"
        className="inline-flex h-11 items-center justify-center rounded-sm border border-line bg-panel px-4 text-body font-medium text-ink shadow-card outline-none transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
      >
        Add app details in Settings
      </Link>
    </div>
  );
}

/**
 * Checks the workspace's app details for a platform through Part A's
 * credentials route. A failed request is reported as an error status —
 * callers fail open on it (see isByocGateBlocking).
 */
export async function checkByocCredentials(
  subdomain: string,
  platform: ByocGatePlatform,
  fetcher: typeof fetch = fetch
): Promise<ByocGateStatus> {
  try {
    const res = await fetcher(
      `/api/tenant/${subdomain}/settings/platform-credentials/${platform}`
    );
    if (!res.ok) {
      return {
        isLoading: false,
        hasCredentials: false,
        error: "Couldn't verify your app details just now.",
      };
    }
    const data = (await res.json()) as {
      hasSecret?: boolean;
      appId?: string | null;
    };
    return {
      isLoading: false,
      hasCredentials: Boolean(data.appId && data.hasSecret),
      error: null,
    };
  } catch {
    return {
      isLoading: false,
      hasCredentials: false,
      error: "Couldn't verify your app details just now.",
    };
  }
}

export interface ByocGateProps {
  platform: ByocGatePlatform;
  platformName: string;
  subdomain: string;
  setupSteps?: string[];
  children: React.ReactNode;
  /** Test seam: skips the network check and renders from this status. */
  initialStatus?: ByocGateStatus;
}

export function ByocGate({
  platform,
  platformName,
  subdomain,
  setupSteps,
  children,
  initialStatus,
}: Readonly<ByocGateProps>) {
  const [status, setStatus] = useState<ByocGateStatus>(
    initialStatus ?? { isLoading: true, hasCredentials: false, error: null }
  );

  useEffect(() => {
    if (initialStatus || !subdomain) return;
    let isMounted = true;
    void checkByocCredentials(subdomain, platform).then((result) => {
      if (isMounted) setStatus(result);
    });
    return () => {
      isMounted = false;
    };
  }, [initialStatus, subdomain, platform]);

  if (isByocGateBlocking(status)) {
    return (
      <ByocGatePrompt
        platform={platform}
        platformName={platformName}
        subdomain={subdomain}
        {...(setupSteps ? { setupSteps } : {})}
      />
    );
  }

  return <>{children}</>;
}
