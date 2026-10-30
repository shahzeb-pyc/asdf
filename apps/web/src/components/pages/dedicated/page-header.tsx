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
 * AlertDialog pattern) — it never disconnects at once. Attention
 * states explain themselves with a banner above the header: the
 * checkpoint banner (explanation + reactivate action), a Rate Limited
 * banner (no action — it auto-resumes), and a Token Expired banner
 * (action links to the workspace's Facebook Accounts section).
 * Active, paused, and disconnected pages show no banner.
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
 * - Create Posts opens the Create Posts dialogue (wired by the shell);
 *   `onCreatePosts` is optional only so the header can render without
 *   a handler in tests.
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
import { resolveFormatLabel } from './posting-times/posting-time-utils';
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
  /** Opens the Create Posts dialogue; optional only for test renders. */
  onCreatePosts?: (() => void) | undefined;
}

interface PageStatusDetails {
  isPaused: boolean;
  statusLabel: string;
  ringClass: string;
}

function resolvePageStatus(status: FacebookPageItem['status']): PageStatusDetails {
  if (status === 'invalid_token') {
    return {
      isPaused: false,
      statusLabel: 'Token Expired',
      ringClass: 'ring-signal-critical',
    };
  }

  if (status === 'page_checkpoint') {
    return {
      isPaused: false,
      statusLabel: 'Identity Checkpoint',
      ringClass: 'ring-signal-critical',
    };
  }

  if (status === 'fb_rate_limited') {
    return {
      isPaused: false,
      statusLabel: 'Rate Limited',
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

  if (status === 'disconnected') {
    return {
      isPaused: false,
      statusLabel: 'Disconnected',
      ringClass: 'ring-signal-critical',
    };
  }

  // Unknown statuses must never read as healthy: an unexpected wire
  // value is a needs-attention state, not 'Active'.
  return {
    isPaused: false,
    statusLabel: 'Needs Attention',
    ringClass: 'ring-signal-critical',
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
        'flex size-14 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-link ring-2',
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
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const [isDisconnectDialogOpen, setIsDisconnectDialogOpen] = React.useState(false);
  const [isDisconnecting, setIsDisconnecting] = React.useState(false);
  const [failedAccountAvatarUrl, setFailedAccountAvatarUrl] =
    React.useState<string | null>(null);

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
        ? 'text-signal-critical'
        : 'text-ink-sub';

  // Pause/resume feedback: the menu is controlled and stays open while
  // the mutation runs (Radix would otherwise close it the instant the
  // item is clicked, hiding the "Updating..." state), and closes once
  // the mutation settles. The shell's success/error toasts remain the
  // completion feedback — no extra toasts are added here.
  const handleStatusAction = async () => {
    setIsUpdatingStatus(true);
    try {
      await onStatusToggle(statusInfo.isPaused ? 'active' : 'paused');
    } finally {
      setIsUpdatingStatus(false);
      setIsMenuOpen(false);
    }
  };

  const handleMenuOpenChange = (open: boolean) => {
    // Never let the menu close while the status mutation is running —
    // that would hide the in-menu "Updating..." state again.
    if (!open && isUpdatingStatus) return;
    setIsMenuOpen(open);
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
  // R22: the dialogue closes ONLY on success. On failure the shell
  // already toasts the error, and the dialogue stays open so the user
  // can retry without reopening menu + dialogue. The shell's
  // disconnect handler now propagates its error (instead of swallowing
  // it), so this catch is what distinguishes failure from success.
  const handleConfirmDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await onDisconnectRequest();
      setIsDisconnectDialogOpen(false);
    } catch {
      // Error toast is the shell's; keep the dialogue open for retry
      // by explicitly re-affirming it (a comment-only catch is banned
      // by the silent-failure guardrail).
      setIsDisconnectDialogOpen(true);
    } finally {
      setIsDisconnecting(false);
    }
  };

  // Status family 1A: Pause/Resume live ONLY in the three-dots menu
  // for active (Pause) and paused (Resume) pages. Checkpoint,
  // expired-token, rate-limited, disconnected, and unknown pages
  // show no Pause/Resume item at all — their recovery paths are the
  // banners (Mark Verified, Reconnect, wait/auto-resume), not a menu
  // Resume that would silently clear those states. The server PATCH
  // gate enforces the same rule; this is the UI half.
  const showStatusAction = page.status === 'active' || page.status === 'paused';

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

      {/* Rate-limited attention banner — rate-limited state only. No
          action: Facebook lifts the restriction on its own (the
          description says so), so there is nothing to click. */}
      {page.status === 'fb_rate_limited' && (
        <div className="mb-4 overflow-hidden rounded-md border border-line">
          <Banner
            variant="warning"
            data-testid="rate-limited-banner"
            title="Rate Limited"
            description="Facebook temporarily restricted posting (auto-resumes after 3 days)."
          />
        </div>
      )}

      {/* Unmatched-posts banner — active pages only. The stored flag
          survives pausing and every other state change, but the
          banner itself shows only while status is active: while
          paused (or rate-limited, or expired) the status banner
          above is the explanation, and waiting posts resume with
          the page. Adding a matching posting time clears the flag
          and the waiting posts join the flow automatically. */}
      {page.status === 'active' &&
        Array.isArray(page.unmatchedPostTypes) &&
        page.unmatchedPostTypes.length > 0 && (
          <div className="mb-4 overflow-hidden rounded-md border border-line">
            <Banner
              variant="warning"
              data-testid="unmatched-post-types-banner"
              title="Some queued posts have no posting time"
              description={`You have queued ${page.unmatchedPostTypes.map((format) => resolveFormatLabel(format)).join(', ')} posts, but no active posting time allows them. They will wait in the queue until you add a posting time that allows them.`}
            />
          </div>
        )}

      {/* Token-expired attention banner — invalid-token state only. Its
          action links to the Facebook Accounts section for this
          workspace, where the parent account is reconnected. */}
      {page.status === 'invalid_token' && (
        <div className="mb-4 overflow-hidden rounded-md border border-line">
          <Banner
            variant="critical"
            data-testid="token-expired-banner"
            title="Token Expired"
            description="Reconnect the parent Facebook account to resume publishing."
            action={
              <Button
                type="button"
                data-testid="reconnect-account-btn"
                onClick={() => router.push(`/tenant/${subdomain}/accounts`)}
              >
                Open Facebook Accounts
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

              {/* Backup feedback that survives any menu behaviour: while a
                  status mutation runs, the header itself says so. */}
              {isUpdatingStatus && (
                <span
                  data-testid="header-status-updating"
                  aria-live="polite"
                  className="text-body text-ink-sub"
                >
                  Updating...
                </span>
              )}

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
                      className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-subtle text-xs font-bold text-link"
                    >
                      {page.accountPictureUrl &&
                      failedAccountAvatarUrl !== page.accountPictureUrl ? (
                        <Image
                          src={page.accountPictureUrl}
                          alt=""
                          width={20}
                          height={20}
                          onError={() =>
                            setFailedAccountAvatarUrl(
                              page.accountPictureUrl ?? '__error__'
                            )
                          }
                          className="size-5 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        getUserInitials(page.accountDisplayName)
                      )}
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

          <Menu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
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
              {showStatusAction && (
                <>
                  <MenuItem
                    data-testid="header-menu-pause-resume-btn"
                    disabled={isUpdatingStatus}
                    onSelect={(event) => {
                      // Prevent Radix closing the menu on select so the
                      // "Updating..." state stays visible until the
                      // mutation settles (handleStatusAction closes it).
                      event.preventDefault();
                      void handleStatusAction();
                    }}
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
                </>
              )}
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
