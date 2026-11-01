'use client';

/**
 * Shared platform accounts shell (spec 131 PR-131-5, audit #12).
 *
 * One shell for the five platform account routes (Instagram, Threads,
 * TikTok, X, YouTube): each route is a thin wrapper passing its platform
 * config — name, icon, verbatim description, and the connect area where
 * the platform has one today — to this component. It replaces the five
 * duplicate route shells and the legacy
 * `components/workspace/platform-placeholder-accounts.tsx`, which is
 * deleted in this PR (its last consumers were these routes).
 *
 * Presentation is the typed setup-incomplete state (UX Rule 6): a
 * shared/ui `EmptyState` (`first-use`) inside the panel geometry, built
 * clean-room from the research standards on the shared/ui primitives and
 * token-backed utilities — zero inline styles. Content is today's
 * content, verbatim: the heading, the testing notice
 * (`testing-placeholder-notice`), the platform description, the connect
 * area, and the "Return to Overview" action all carry over unchanged;
 * only the presentation system changed.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { TESTING_PLACEHOLDER_TEXT } from '@/components/workspace/platform-nav-config';
import { buildTenantHref, isTenantSubdomainHost } from '@/lib/tenant-href';

export interface PlatformAccountsShellProps {
  platformName: string;
  subdomain: string;
  icon?: React.ReactNode;
  /** Overrides the default body copy (e.g. the platform's connect model). */
  description?: string;
  /** Optional connect area rendered above the return button (e.g. a gated connect action). */
  connectArea?: React.ReactNode;
}

export function PlatformAccountsShell({
  platformName,
  subdomain,
  icon,
  description,
  connectArea,
}: Readonly<PlatformAccountsShellProps>) {
  const router = useRouter();

  const handleReturnHome = () => {
    router.push(buildTenantHref(subdomain, ``, isTenantSubdomainHost(window.location.hostname, subdomain)));
  };

  return (
    <div
      data-slot="platform-accounts-shell"
      data-testid="platform-placeholder-accounts"
      className="flex flex-1 flex-col items-center justify-center px-6 py-6 text-center"
    >
      <div className="flex w-full max-w-120 flex-col items-center gap-4 rounded-md border border-line bg-panel px-6 py-8 shadow-card">
        <EmptyState
          type="first-use"
          className="gap-1 px-0 py-0"
          icon={
            icon ? (
              <div
                data-slot="platform-icon-container"
                aria-hidden
                className="mb-3 flex size-12 items-center justify-center rounded-md border border-line bg-active text-primary"
              >
                {icon}
              </div>
            ) : undefined
          }
          title={`${platformName} Accounts`}
        />
        <p
          data-testid="testing-placeholder-notice"
          className="m-0 text-metadata leading-relaxed font-medium text-ink-dim"
        >
          {TESTING_PLACEHOLDER_TEXT}
        </p>
        <p className="m-0 max-w-95 text-body leading-relaxed text-ink-sub">
          {description ??
            `${platformName} integration is currently undergoing testing and verification. Account connectivity and publishing tools for this channel will be enabled once public validation completes.`}
        </p>

        {connectArea}

        <div className="mt-2 w-full">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={handleReturnHome}
          >
            Return to Overview
          </Button>
        </div>
      </div>
    </div>
  );
}
