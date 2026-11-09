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
 * states explain themselves with one banner above the header, from
 * the shared contracts alert (spec 155): checkpoint keeps Mark
 * Verified & Reactivate Page, invalid token links to Facebook
 * Accounts, rate-limited and the other Facebook error statuses
 * have no action. Active, paused, and disconnected pages show no banner.
 *
 * Data notes:
 * - Added date and followers gained reuse the list card's helpers
 *   (`formatAddedDate`, `computeFollowersGained`,
 *   `formatFollowersGained`) so the header can never disagree with the
 *   card about the same page.
 * - The header holds NO fetch of its own; reactivation and pause/resume
 *   go through the frame's status mutation via `onStatusToggle`.
 * - Account picture: when `accountPictureUrl` is present the
 *   connected account renders the real picture, falling back to an
 *   initials avatar when it is absent or fails to load (the old
 *   initials-only note above is stale and was corrected here).
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
import { buildTenantHref, isTenantSubdomainHost } from '@/lib/tenant-href';
import type { FacebookPageItem } from '../page-card';
import { resolveFormatLabel } from './posting-times/posting-time-utils';
import {
  computeFollowersGained,
  formatAddedDate,
  formatFollowersGained,
  getPageStatusLabel,
  getPageStatusMarkKind,
  PageStatusMark,
} from '../page-card';
import { getFacebookPageStatusAlert } from '@fbuploadpro/contracts';

export interface DedicatedPageHeaderProps {
  page: FacebookPageItem;
  subdomain: string;
  onStatusToggle: (nextStatus: 'active' | 'paused') => Promise<void>;
  /** Checkpoint banner path, when the shell supplies it: the shell
   *  then toasts "marked verified" instead of a plain resume.
   *  Optional so header-only renders keep calling onStatusToggle. */
  onMarkVerified?: (() => Promise<void>) | undefined;
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
  // Labels come from the card's single label switch (spec 155) so
  // the header can never disagree with the card about the same page;
  // the ring follows the same mark-kind rule.
  const kind = getPageStatusMarkKind(status);
  return {
    isPaused: status === 'paused',
    statusLabel: getPageStatusLabel(status),
    ringClass:
      kind === 'operational'
        ? 'ring-signal-operational'
        : kind === 'queued'
          ? 'ring-signal-queued'
          : 'ring-signal-critical',
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
  onMarkVerified,
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
  const fbPageUrl = `https://facebook.com/${encodeURIComponent(page.fbPageId)}`;

  // Spec 155: one banner per Facebook error status, from the shared
  // contracts alert (ADU wording, "turn posting back on" in place of
  // ADU's toggle phrase). Active, paused and disconnected show no
  // banner. The checkpoint banner keeps its Mark Verified action and
  // the token banner its Open Facebook Accounts action; the other
  // statuses have no action. Testids keep the historic names for the
  // three banners that existed before, so existing tests keep
  // addressing them; new statuses use `page-status-banner-<status>`.

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
      if (onMarkVerified) {
        await onMarkVerified();
      } else {
        await onStatusToggle('active');
      }
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
          onClick={() => router.push(buildTenantHref(subdomain, `/pages`, isTenantSubdomainHost(window.location.hostname, subdomain)))}
          className="inline-flex min-h-11 items-center gap-1 px-1 text-body font-medium text-ink-sub transition-colors hover:text-ink"
        >
          <ChevronLeftIcon className="size-4" aria-hidden />
          <span>Schedule</span>
        </button>
      </div>

      {/* Status attention banner — one per Facebook error status
          (spec 155, shared contracts alert). The checkpoint action
          is Mark Verified & Reactivate Page; the token action links
          to Facebook Accounts; rate-limited and the other error
          statuses have no action. */}
      {(() => {
        const alert = getFacebookPageStatusAlert(page.status);
        if (!alert) return null;
        const bannerTestId =
          page.status === 'page_checkpoint'
            ? 'checkpoint-reactivation-banner'
            : page.status === 'fb_rate_limited'
              ? 'rate-limited-banner'
              : page.status === 'invalid_token'
                ? 'token-expired-banner'
                : `page-status-banner-${page.status}`;
        return (
          <div className="mb-4 overflow-hidden rounded-md border border-line">
            <Banner
              variant={alert.variant}
              data-testid={bannerTestId}
              title={alert.title}
              description={alert.description}
              action={
                alert.action === 'mark_verified' ? (
                  <Button
                    type="button"
                    data-testid="reactivate-page-btn"
                    disabled={isUpdatingStatus || isDisconnecting}
                    onClick={() => void handleReactivate()}
                  >
                    {isUpdatingStatus ? 'Reactivating...' : 'Mark Verified & Reactivate Page'}
                  </Button>
                ) : alert.action === 'reconnect' ? (
                  <Button
                    type="button"
                    data-testid="reconnect-account-btn"
                    onClick={() => router.push(buildTenantHref(subdomain, `/accounts`, isTenantSubdomainHost(window.location.hostname, subdomain)))}
                  >
                    Open Facebook Accounts
                  </Button>
                ) : undefined
              }
            />
          </div>
        );
      })()}

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
                  {/* K11 mutual guard: Pause/Resume is disabled
                      while a disconnect is running, and Disconnect
                      below is disabled while a status update runs,
                      so the two mutations (and their toasts) can
                      never run at once. The server already no-ops a
                      late pause after disconnect — this is feedback
                      only, no data change. */}
                  <MenuItem
                    data-testid="header-menu-pause-resume-btn"
                    disabled={isUpdatingStatus || isDisconnecting}
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
                disabled={isUpdatingStatus || isDisconnecting}
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
              This disconnects only this Facebook Page, not the Facebook account — other pages from the same account stay connected, and the access token for this page is cleared. Queued posts are cancelled, but posts already publishing are untouched and will finish.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="header-cancel-disconnect-btn" disabled={isDisconnecting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="header-confirm-disconnect-btn"
              disabled={isDisconnecting || isUpdatingStatus}
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
