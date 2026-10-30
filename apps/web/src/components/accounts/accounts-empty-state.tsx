'use client';

/**
 * Accounts empty state (spec 131 PR-131-1) — rebuilt as a typed
 * shared/ui `EmptyState` (type `first-use`: one primary action, per
 * UI Rule 23 / UX Rule 6) inside the same panel geometry. Copy,
 * testids, and the BYOC disabled-with-reason behaviour (UX Rule 19)
 * are preserved verbatim.
 */
import * as React from 'react';
import Link from 'next/link';
import { PlusIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';

interface AccountsEmptyStateProps {
  onConnect: () => void;
  /** Disable the connect action (for example while credentials are checked). */
  isConnectDisabled?: boolean | undefined;
  /** The workspace's Facebook App ID and Secret are known to be missing. */
  credentialsMissing?: boolean | undefined;
  /** The credentials check is still running (button disabled, reason shown). */
  isCheckingCredentials?: boolean | undefined;
  /** Where to add the missing App ID and Secret (Settings → Facebook). */
  settingsHref?: string | undefined;
}

export function AccountsEmptyState({
  onConnect,
  isConnectDisabled = false,
  credentialsMissing = false,
  isCheckingCredentials = false,
  settingsHref,
}: Readonly<AccountsEmptyStateProps>) {
  const isDisabled = isConnectDisabled || credentialsMissing;
  return (
    <div className="mx-auto my-10 w-full max-w-xl rounded-md border border-line bg-panel shadow-card">
      <EmptyState
        type="first-use"
        data-testid="accounts-empty-state"
        icon={
          <div
            aria-hidden
            className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary text-xl font-bold text-on-primary select-none"
          >
            FB
          </div>
        }
        title="Connect your first Facebook account"
        description="Link your Facebook Account to import pages"
        action={
          <Button
            type="button"
            size="lg"
            data-testid="empty-connect-button"
            onClick={onConnect}
            disabled={isDisabled}
            aria-describedby={
              credentialsMissing
                ? 'empty-connect-disabled-reason'
                : isCheckingCredentials
                  ? 'empty-connect-checking-reason'
                  : undefined
            }
          >
            <PlusIcon aria-hidden />
            <span>Connect Facebook Account</span>
          </Button>
        }
      />
      <div className="flex flex-col items-center px-6 pb-12 text-center">
        {/* Audit UX4: while the check is loading the button is
            disabled with no explanation at all — say so. */}
        {!credentialsMissing && isCheckingCredentials && (
          <p
            id="empty-connect-checking-reason"
            data-testid="empty-connect-checking-reason"
            className="-mt-8 max-w-105 text-body leading-body text-ink-sub"
          >
            Checking your Facebook app setup…
          </p>
        )}
        {credentialsMissing && (
          <p
            id="empty-connect-disabled-reason"
            data-testid="empty-connect-disabled-reason"
            className="-mt-8 max-w-105 text-body leading-body text-ink-sub"
          >
            Add your Facebook App ID and App Secret first — connecting is
            paused until they are saved.{' '}
            {settingsHref && (
              <Link
                href={settingsHref}
                data-testid="empty-connect-settings-link"
                className="font-semibold text-link underline"
              >
                Add them in Settings
              </Link>
            )}
          </p>
        )}

        <p className="mt-4 max-w-105 text-metadata leading-body text-ink-dim">
          We only request permissions to publish reels and manage your pages
        </p>
      </div>
    </div>
  );
}
