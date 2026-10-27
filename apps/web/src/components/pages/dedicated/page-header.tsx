'use client';

/**
 * Dedicated Page identity header — redesigned top section.
 *
 * Contains ONLY the items Shahzeb listed for the top section: back link,
 * page name + live link, icon+text status mark (never a dot), connected
 * account (with account picture when available), Added date, follower
 * count + gained + category, Create Posts button, a three-dots menu
 * holding Pause/Resume posting and Disconnect Page, and Mark Verified &
 * Reactivate Page in the checkpoint state only. The Queue Post button
 * and Copy Page ID were removed with this redesign. Disconnect Page in
 * the menu opens a confirmation dialogue (the Settings tab's
 * AlertDialog pattern) — it never disconnects at once.
 *
 * Data notes:
 * - Added date and followers gained reuse the list card's helpers
 *   (`formatAddedDate`, `computeFollowersGained`,
 *   `formatFollowersGained`) so the header can never disagree with the
 *   card about the same page.
 * - The header holds NO fetch of its own; reactivation and pause/resume
 *   go through the frame's status mutation via `onStatusToggle`.
 * - Account picture: `FacebookPageItem` carries no account picture field
 *   (only `accountDisplayName`), so the connected account renders an
 *   initials avatar. Surfacing a real account picture is a follow-up
 *   that needs an API/contract field — it is NOT expanded here.
 * - Create Posts is rendered only: `onCreatePosts` is optional and the
 *   shell leaves it unhandled, so clicking the button does nothing yet.
 *   The Create Posts dialogue is separate later work, by Shahzeb's
 *   scoping — the no-op is intentional, not a bug.
 */

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  ChevronLeftIcon,
  ExternalLinkIcon,
  MoreVerticalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/shared/ui/menu';
import { cn } from '@/lib/utils';
import { getUserInitials } from '@/lib/user-initials';
import type { FacebookPageItem } from '../page-card';
import {
  computeFollowersGained,
  formatAddedDate,
  formatFollowersGained,
  PageStatusMark,
} from '../page-card';

export interface DedicatedPageHeaderProps {
  page: FacebookPageItem;
  subdomain: string;
  onStatusToggle: (nextStatus: 'active' | 'paused') => Promise<void>;
  onDisconnectRequest: () => void | Promise<void>;
  /** Optional for now: the shell leaves this unhandled, so the Create
   * Posts button intentionally does nothing until the dialogue work
   * lands. */
  onCreatePosts?: (() => void) | undefined;
}

interface PageStatusDetails {
  isPaused: boolean;
  statusLabel: string;
  ringClass: string;
}

function resolvePageStatus(status: FacebookPageItem['status']): PageStatusDetails {
  if (
    status === 'invalid_token' ||
    status === 'page_checkpoint' ||
    status === 'fb_rate_limited'
  ) {
    return {
      isPaused: false,
      statusLabel: 'Needs Attention',
      ringClass: 'ring-signal-critical',
    };
  }

  if (status === 'paused') {
    return {
      isPaused: true,
      statusLabel: 'Paused',
      ringClass: 'ring-signal-queued',
    };
  }

  if (status === 'active') {
    return {
      isPaused: false,
      statusLabel: 'Active',
      ringClass: 'ring-signal-operational',
    };
  }

  return {
    isPaused: false,
    statusLabel: 'Active',
    ringClass: 'ring-line',
  };
}

function DedicatedAvatar({
  page,
  ringClass,
  monogram,
}: Readonly<{ page: FacebookPageItem; ringClass: string; monogram: string }>) {
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);

  if (page.profilePictureUrl && failedAvatarUrl !== page.profilePictureUrl) {
    return (
      <Image
        src={page.profilePictureUrl}
        alt={page.pageName}
        data-testid="dedicated-page-avatar"
        width={56}
        height={56}
        onError={() => setFailedAvatarUrl(page.profilePictureUrl ?? '__error__')}
        className={cn('size-14 shrink-0 rounded-full object-cover ring-2', ringClass)}
      />
    );
  }

  return (
    <div
      data-testid="dedicated-page-avatar-fallback"
      className={cn(
        'flex size-14 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-brand-gold ring-2',
        ringClass
      )}
    >
      {monogram}
    </div>
  );
}

export function DedicatedPageHeader({
  page,
  subdomain,
  onStatusToggle,
  onDisconnectRequest,
  onCreatePosts,
}: Readonly<DedicatedPageHeaderProps>) {
  const router = useRouter();
  const [isUpdatingStatus, setIsUpdatingStatus] = React.useState(false);
  const [isDisconnectDialogOpen, setIsDisconnectDialogOpen] = React.useState(false);
  const [isDisconnecting, setIsDisconnecting] = React.useState(false);

  const statusInfo = resolvePageStatus(page.status);
  const monogram = (page.pageName || 'P').slice(0, 2).toUpperCase();
  const fbPageUrl = `https://facebook.com/${page.fbPageId}`;

  const isCheckpoint =
    page.status === 'page_checkpoint' ||
    (page.status as string) === 'checkpoint_required';

  const addedDate = formatAddedDate(page.createdAt);
  const gained = computeFollowersGained(page);
  const formattedGained = formatFollowersGained(gained);
  const gainedClass =
    gained > 0
      ? 'text-brand-emerald'
      : gained < 0
        ? 'text-brand-rose'
        : 'text-ink-sub';

  const handleStatusAction = async () => {
    setIsUpdatingStatus(true);
    try {
      await onStatusToggle(statusInfo.isPaused ? 'active' : 'paused');
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleReactivate = async () => {
    setIsUpdatingStatus(true);
    try {
      await onStatusToggle('active');
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  // Disconnect confirmation — the Settings tab's AlertDialog pattern.
  // The menu item only opens the dialogue; only the confirm click calls
  // onDisconnectRequest, and the shell owns the disconnect semantics
  // (page → disconnected, queued items cancelled, redirect on success).
  const handleConfirmDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await onDisconnectRequest();
      setIsDisconnectDialogOpen(false);
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <div data-testid="dedicated-page-header" className="mb-6">
      {/* Quiet back link */}
      <div className="mb-4">
        <button
          type="button"
          data-testid="back-to-pages-link"
          onClick={() => router.push(`/tenant/${subdomain}/pages`)}
          className="inline-flex min-h-11 items-center gap-1 px-1 text-body font-medium text-ink-sub transition-colors hover:text-ink"
        >
          <ChevronLeftIcon className="size-4" aria-hidden />
          <span>Facebook Pages</span>
        </button>
      </div>

      {/* Checkpoint reactivation banner — checkpoint state only */}
      {isCheckpoint && (
        <div className="mb-4 overflow-hidden rounded-md border border-line">
          <Banner
            variant="warning"
            data-testid="checkpoint-reactivation-banner"
            title="Facebook Checkpoint Verification Required"
            description="Facebook requires verification in the mobile app or browser before automated publishing can resume."
            action={
              <Button
                type="button"
                data-testid="reactivate-page-btn"
                disabled={isUpdatingStatus}
                onClick={() => void handleReactivate()}
              >
                {isUpdatingStatus ? 'Reactivating...' : 'Mark Verified & Reactivate Page'}
              </Button>
            }
          />
        </div>
      )}

      {/* Main header: identity on top, actions below on narrow
          screens (the old flex-wrap row let identity + actions squash
          side-by-side at ~320px instead of stacking); side-by-side
          again from sm up. The 56px round picture is kept at all
          widths — stacking removes the squeeze that threatened it. */}
      <div data-testid="header-main-row" className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex w-full min-w-0 items-center gap-3 sm:flex-1">
          <DedicatedAvatar page={page} ringClass={statusInfo.ringClass} monogram={monogram} />

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1
                data-testid="dedicated-page-heading"
                className="m-0 truncate text-xxl font-bold tracking-h1 text-ink"
              >
                {page.pageName}
              </h1>
              <a
                href={fbPageUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="page-live-link"
                title="View live Page on Facebook"
                aria-label={`View ${page.pageName} live on Facebook`}
                className="inline-flex size-11 shrink-0 items-center justify-center text-ink-dim transition-colors hover:text-ink"
              >
                <ExternalLinkIcon className="size-4" aria-hidden />
              </a>
            </div>

            {/* Sub-row: status mark + account + Added date + followers + gained + category */}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-body text-ink-sub">
              <span data-testid="dedicated-page-status" className="inline-flex items-center">
                <PageStatusMark
                  status={page.status}
                  label={statusInfo.statusLabel}
                />
              </span>

              {page.accountDisplayName && (
                <>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
                  <span
                    data-testid="dedicated-account"
                    className="inline-flex items-center gap-1.5"
                  >
                    <span
                      data-testid="dedicated-account-avatar"
                      aria-hidden
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-bold text-brand-gold"
                    >
                      {getUserInitials(page.accountDisplayName)}
                    </span>
                    <span>Connected via {page.accountDisplayName}</span>
                  </span>
                </>
              )}

              {addedDate && (
                <>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
                  <span data-testid="dedicated-page-added">Added {addedDate}</span>
                </>
              )}

              <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
              <span data-testid="dedicated-page-followers">
                <span className="font-semibold text-ink">
                  {page.currentFollowers.toLocaleString('en-US')}
                </span>{' '}
                followers
              </span>

              {gained !== 0 && (
                <>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
                  <span
                    data-testid="dedicated-page-followers-gained"
                    className={cn('shrink-0 tabular-nums', gainedClass)}
                  >
                    {formattedGained} gained
                  </span>
                </>
              )}

              {page.category && (
                <>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
                  <span>{page.category}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Actions cluster: Create Posts first, then a three-dots menu
            holding Pause/Resume posting and Disconnect Page. Full
            width on narrow screens (Create Posts stretches, the menu
            button keeps its fixed size); compact row from sm up.
            Buttons keep the default h-control 44px touch height and
            never wrap mid-label (Button base: whitespace-nowrap). */}
        <div data-testid="header-actions" className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            type="button"
            data-testid="header-create-posts-btn"
            className="flex-1 sm:flex-none"
            onClick={() => onCreatePosts?.()}
          >
            <PlusIcon aria-hidden />
            <span>Create Posts</span>
          </Button>

          <Menu>
            <MenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                data-testid="header-settings-dropdown-btn"
                aria-label="Page actions menu"
              >
                <MoreVerticalIcon aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                data-testid="header-menu-pause-resume-btn"
                disabled={isUpdatingStatus}
                onSelect={() => void handleStatusAction()}
              >
                {statusInfo.isPaused ? (
                  <PlayIcon aria-hidden />
                ) : (
                  <PauseIcon aria-hidden />
                )}
                <span>
                  {isUpdatingStatus
                    ? 'Updating...'
                    : statusInfo.isPaused
                      ? 'Resume posting'
                      : 'Pause posting'}
                </span>
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                data-testid="header-menu-disconnect-btn"
                onSelect={() => setIsDisconnectDialogOpen(true)}
              >
                <PowerIcon aria-hidden />
                <span>Disconnect Page</span>
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>

      {/* Disconnect confirmation — alert-dialog pattern (UI Rule 3).
          Testids are header-scoped: the Settings tab renders its own
          disconnect dialogue with the unscoped testids, and both can
          mount on the same dedicated page. */}
      <AlertDialog open={isDisconnectDialogOpen} onOpenChange={setIsDisconnectDialogOpen}>
        <AlertDialogContent data-testid="header-disconnect-modal">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {page.pageName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect the Facebook Page from your workspace. Any queued posts will be cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="header-cancel-disconnect-btn" disabled={isDisconnecting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="header-confirm-disconnect-btn"
              disabled={isDisconnecting}
              onClick={(event) => {
                // Keep the dialogue open until the disconnect settles
                // (facebook-disconnect-dialog pattern): without this,
                // Radix closes the dialogue at once and the
                // Disconnecting state is never visible.
                event.preventDefault();
                void handleConfirmDisconnect();
              }}
            >
              {isDisconnecting ? 'Disconnecting...' : 'Yes, Disconnect Page'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
