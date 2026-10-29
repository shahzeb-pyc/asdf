'use client';

/**
 * Pages empty state (spec 131 PR-131-2) — rebuilt as a typed
 * shared/ui `EmptyState` (type `first-use`: one primary action, per
 * UI Rule 23 / UX Rule 6) inside the same panel geometry. Copy,
 * testids, and the point-of-need Facebook-app guidance (shown only
 * when the App ID and Secret are known to be missing) are preserved
 * verbatim.
 */
import * as React from 'react';
import Link from 'next/link';
import { PlusIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';

export interface PagesEmptyStateProps {
  onAddPage: () => void;
  /** Workspace subdomain, used for the Settings → Facebook link. */
  subdomain?: string | undefined;
  /**
   * Whether the workspace's Facebook App ID and Secret are configured.
   * `false` = known missing (show guidance); `undefined` = not checked yet.
   */
  facebookAppConfigured?: boolean | undefined;
}

export function PagesEmptyState({
  onAddPage,
  subdomain,
  facebookAppConfigured,
}: Readonly<PagesEmptyStateProps>) {
  const showMissingAppGuidance =
    facebookAppConfigured === false && Boolean(subdomain);
  return (
    <div className="mx-auto my-10 w-full max-w-140 rounded-md border border-line bg-panel shadow-card">
      <EmptyState
        type="first-use"
        data-testid="pages-empty-state"
        className="px-6 pt-16 pb-2"
        icon={
          <div
            aria-hidden
            className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary text-xl font-bold text-on-primary select-none"
          >
            PG
          </div>
        }
        title="No Facebook Pages added yet"
        description="Choose one of your connected Facebook accounts and select the pages you want to manage and publish posts to — text, photos, videos, reels, and stories."
      />
      <div className="flex flex-col items-center px-6 pb-16">
        {showMissingAppGuidance && (
          <div
            data-testid="pages-empty-facebook-app-guidance"
            className="mb-6 w-full max-w-105 rounded-sm border border-link/25 bg-link/10 px-3 py-2.5 text-center text-body leading-body text-ink"
          >
            <p className="mb-1">
              No account connected yet? First add your Facebook App ID and App
              Secret in Workspace Settings, under Facebook. Then connect your
              account and add its pages here.
            </p>
            <Link
              href={`/tenant/${subdomain}/settings?tab=byoc`}
              data-testid="pages-empty-settings-facebook-link"
              className="font-semibold text-link underline"
            >
              Add App ID and Secret in Settings
            </Link>
          </div>
        )}
        <Button
          type="button"
          size="lg"
          data-testid="empty-state-add-page-btn"
          onClick={onAddPage}
        >
          <PlusIcon aria-hidden />
          <span>Add Page</span>
        </Button>
      </div>
    </div>
  );
}
