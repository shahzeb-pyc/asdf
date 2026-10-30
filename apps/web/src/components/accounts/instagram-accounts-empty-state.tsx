'use client';

/**
 * Instagram accounts empty state — Facebook's `AccountsEmptyState`
 * panel geometry exactly (`mx-auto my-10 max-w-xl` panel + `first-use`
 * EmptyState), with Instagram copy: title "Connect your first Instagram
 * account", the placeholder's own description verbatim in the
 * description slot, "Connect Instagram" button with Facebook's
 * disabled-while-credentials-missing behaviour + reason + Settings link,
 * and a permissions footnote in the same slot, adapted to Instagram's
 * real requested scopes (`instagram_business_basic`,
 * `instagram_business_content_publish`, `instagram_business_manage_comments`:
 * profile access, content publishing, comment management).
 */
import * as React from 'react';
import Link from 'next/link';
import { PlusIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';

export const INSTAGRAM_ACCOUNTS_EMPTY_DESCRIPTION =
  'Connect your Instagram account to schedule and publish posts from one place. Your workspace uses its own Instagram app details, so your accounts stay yours.';

interface InstagramAccountsEmptyStateProps {
  onConnect: () => void;
  /** Disable the connect action (for example while credentials are checked). */
  isConnectDisabled?: boolean | undefined;
  /** The workspace's Instagram App ID and Secret are known to be missing. */
  credentialsMissing?: boolean | undefined;
  /** Where to add the missing App ID and Secret (Settings → Instagram App). */
  settingsHref?: string | undefined;
}

export function InstagramAccountsEmptyState({
  onConnect,
  isConnectDisabled = false,
  credentialsMissing = false,
  settingsHref,
}: Readonly<InstagramAccountsEmptyStateProps>) {
  const isDisabled = isConnectDisabled || credentialsMissing;
  return (
    <div className="mx-auto my-10 w-full max-w-xl rounded-md border border-line bg-panel shadow-card">
      <EmptyState
        type="first-use"
        data-testid="instagram-accounts-empty-state"
        icon={
          <div
            aria-hidden
            className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary text-xl font-bold text-on-primary select-none"
          >
            IG
          </div>
        }
        title="Connect your first Instagram account"
        description={INSTAGRAM_ACCOUNTS_EMPTY_DESCRIPTION}
        action={
          <Button
            type="button"
            size="lg"
            data-testid="instagram-empty-connect-button"
            onClick={onConnect}
            disabled={isDisabled}
            aria-describedby={
              credentialsMissing ? 'instagram-empty-connect-disabled-reason' : undefined
            }
          >
            <PlusIcon aria-hidden />
            <span>Connect Instagram</span>
          </Button>
        }
      />
      <div className="flex flex-col items-center px-6 pb-12 text-center">
        {credentialsMissing && (
          <p
            id="instagram-empty-connect-disabled-reason"
            data-testid="instagram-empty-connect-disabled-reason"
            className="-mt-8 max-w-105 text-body leading-body text-ink-sub"
          >
            Add your Instagram App ID and App Secret first — connecting is
            paused until they are saved.{' '}
            {settingsHref && (
              <Link
                href={settingsHref}
                data-testid="instagram-empty-connect-settings-link"
                className="font-semibold text-link underline"
              >
                Add them in Settings
              </Link>
            )}
          </p>
        )}

        <p className="mt-4 max-w-105 text-metadata leading-body text-ink-dim">
          We only request permissions to access your Instagram profile, publish content, and manage comments
        </p>
      </div>
    </div>
  );
}
