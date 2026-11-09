'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { MoveUpRightIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { getUserInitials } from '@/lib/user-initials';
import { formatAddedDate } from '@/components/pages/page-card';
import type { MirrorView } from '@/lib/api/schemas/tiktok-mirrors';
import {
  getFacebookPageStatusAlert,
  mapStoredMirrorErrorToDisplay,
  pageStatusFromMirrorFbStatus,
  resolveMirrorDisplayStatus,
} from '@fbuploadpro/contracts';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import {
  MIRROR_STATUS_RING_CLASSES,
  MirrorStatusCircle,
  mirrorDisplayMark,
} from './tiktok-card';

/**
 * Mirror detail header — the Pages dedicated header pattern for
 * mirrors, shared by the Facebook detail shell and the Instagram
 * Auto Repost detail shell (the Instagram shell previously kept
 * its own copy of the header; both now render this one component
 * so the two surfaces cannot drift apart again).
 *
 * The TARGET PAGE is the primary identity (avatar with status
 * ring, name, Added date, followers + category, account), exactly
 * like the Pages-style list card; the TikTok creator is secondary
 * (a muted `source: @username` line). The old creator-first header
 * plus the dashboard identity card repeated source identity,
 * status, and "Mirroring to…" twice — this header appears once,
 * and the dashboard tab no longer renders an identity card.
 *
 * Shown only when the underlying data exists: Added date,
 * followers, category, and account lines are omitted when the
 * destination row is gone (the mirror itself still renders), and
 * "+N gained" appears only when a valid starting-followers value
 * exists and the gain is nonzero — never computed against a
 * missing baseline. No totals live here: Posted / Failed /
 * Skipped totals belong in the Dashboard tab (a later job).
 * No published-post links: no verified URL format exists for
 * them in code, so none is guessed here.
 */

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Mirroring for …" from the mirror's own created date. */
function mirroringDuration(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return '';
  const days = Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000));
  if (days < 1) return 'less than a day';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/** Countdown text for a future next-check time; null when there
 *  is no future check (paused mirrors have nextCheckAt null, so
 *  they never render a bogus countdown). */
function nextCheckCountdown(nextCheckAt: string | null | undefined): string | null {
  if (!nextCheckAt) return null;
  const target = new Date(nextCheckAt).getTime();
  if (Number.isNaN(target)) return null;
  const minutes = Math.ceil((target - Date.now()) / 60000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

export interface MirrorDetailHeaderProps {
  mirror: MirrorView;
  /** Back link target (list route for the platform). */
  backHref: string;
  /** Pause/resume action (same PATCH behaviour as the old switch). */
  onPauseResume: () => void;
  pausePending: boolean;
  /** Opens the shell's delete confirmation dialog (never instant). */
  onDeleteRequest: () => void;
  /**
   * Spec 155: link to Facebook Accounts for the banner's reconnect
   * action. Supplied by the Facebook detail shell only — Instagram
   * mirrors never show the Facebook banner, so the Instagram shell
   * omits it.
   */
  accountsHref?: string;
}

export function MirrorDetailHeader({
  mirror,
  backHref,
  onPauseResume,
  pausePending,
  onDeleteRequest,
  accountsHref,
}: Readonly<MirrorDetailHeaderProps>) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Spec 155: Facebook mirrors show the resolved Facebook detail
  // (own fb_status, else the target's detail); Instagram mirrors
  // keep the coarse status exactly as before.
  const mark = mirrorDisplayMark(mirror);
  const ringClass = MIRROR_STATUS_RING_CLASSES[mark.kind];
  const isPaused = mirror.status === 'paused';
  const isFacebook = mirror.targetPlatform === 'facebook';
  // The banner only exists for a mapped Facebook error status.
  // `mark_verified` has no mirror-side action — reactivation lives
  // on the target Page itself — so the checkpoint banner renders
  // without a button; `reconnect` links to Facebook Accounts.
  // A generic `error` (no detail anywhere) maps to no wire status
  // and falls back to the raw-error box below.
  const wireStatus = isFacebook
    ? pageStatusFromMirrorFbStatus(mark.displayStatus)
    : null;
  const fbAlert = wireStatus
    ? getFacebookPageStatusAlert(wireStatus, 'mirrors')
    : null;
  // Spec 155 (owner default 4): Resume is DISABLED, not hidden,
  // while the mirror is paused and a Facebook error is present —
  // the target is down (live target detail) or the mirror carries
  // its own stamped detail. Pause stays available, and Delete
  // always stays available. An errored-but-active mirror shows
  // Pause (available); the lock only ever disables Resume.
  const resumeLocked =
    isFacebook &&
    isPaused &&
    (mirror.fbStatus != null || mirror.targetFbStatus != null);
  const facebookUrl = isFacebook
    ? `https://facebook.com/${mirror.targetExternalId}`
    : null;
  const targetInitials = getUserInitials(mirror.targetDisplayName);
  const sourceInitial = (mirror.sourceUsername[0] ?? '?').toUpperCase();
  const addedDate = mirror.targetAddedAt ? formatAddedDate(mirror.targetAddedAt) : '';
  const mirrorAddedDate = formatAddedDate(mirror.createdAt);
  const duration = mirroringDuration(mirror.createdAt);
  const countdown = nextCheckCountdown(mirror.nextCheckAt);
  const followers = mirror.targetFollowers ?? null;
  const starting = mirror.targetStartingFollowers ?? null;
  const gained =
    followers !== null && starting !== null ? followers - starting : null;
  const showGained = gained !== null && gained !== 0;

  return (
    <div data-testid="mirror-detail-header">
      {/* Spec 155: a Facebook mirror with a mapped error status
          shows the shared ADU banner (mirrors wording) instead of
          the raw stored error. The raw-error box stays for
          Instagram mirrors (unchanged) and for a Facebook mirror
          in generic error with no detail anywhere. */}
      {fbAlert ? (
        <div className="mb-6 overflow-hidden rounded-md border border-line">
          <Banner
            variant={fbAlert.variant}
            data-testid={`mirror-status-banner-${mark.displayStatus}`}
            title={fbAlert.title}
            description={fbAlert.description}
            action={
              fbAlert.action === 'reconnect' && accountsHref ? (
                <Button type="button" asChild data-testid="mirror-reconnect-account-btn">
                  <Link href={accountsHref}>Open Facebook Accounts</Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : mirror.lastError ? (
        <div
          role="alert"
          data-testid="tiktok-detail-error"
          className="mb-6 rounded-md border border-signal-critical bg-panel p-4 text-body text-signal-critical"
        >
          {mapStoredMirrorErrorToDisplay(mirror.lastError)}
        </div>
      ) : null}

      <Link
        href={backHref}
        data-testid="mirror-detail-back-link"
        className="mb-4 inline-flex min-h-11 items-center gap-1 text-body font-medium text-ink-sub hover:text-ink"
      >
        ‹ Auto Repost
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {mirror.targetAvatarUrl ? (
            <Image
              src={mirror.targetAvatarUrl}
              alt=""
              width={56}
              height={56}
              data-testid="mirror-detail-target-avatar-img"
              className={cn('size-14 shrink-0 rounded-full object-cover', ringClass)}
              unoptimized
            />
          ) : (
            <span
              aria-hidden
              data-testid="mirror-detail-target-avatar-initials"
              className={cn(
                'flex size-14 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink',
                ringClass
              )}
            >
              {targetInitials}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1
                data-testid="mirror-detail-target-name"
                className="truncate text-xxl font-bold tracking-h1 text-ink"
              >
                {mirror.targetDisplayName}
              </h1>
              {facebookUrl ? (
                <a
                  data-testid="mirror-detail-facebook-link"
                  href={facebookUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 truncate text-metadata text-brand-facebook hover:underline"
                >
                  View on Facebook{' '}
                  <MoveUpRightIcon aria-hidden className="inline size-3 shrink-0" />
                </a>
              ) : null}
              <span
                data-testid="mirror-detail-platform-tag"
                className="shrink-0 rounded-full border border-brand-gold px-2.5 py-0.5 text-metadata font-bold text-brand-gold"
              >
                {isFacebook ? 'Facebook' : 'Instagram'}
              </span>
            </div>

            <div
              data-testid="mirror-detail-meta"
              className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-metadata text-ink-dim"
            >
              <MirrorStatusCircle status={mark.displayStatus} label={mark.label} />
              {mirror.targetAccountDisplayName ? (
                <>
                  <span aria-hidden className="text-line">|</span>
                  <span className="inline-flex items-center gap-1.5">
                    {mirror.targetAccountAvatarUrl ? (
                      <Image
                        src={mirror.targetAccountAvatarUrl}
                        alt=""
                        width={20}
                        height={20}
                        data-testid="mirror-detail-account-avatar-img"
                        className="size-5 shrink-0 rounded-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-bold text-ink"
                      >
                        {getUserInitials(mirror.targetAccountDisplayName)}
                      </span>
                    )}
                    <span data-testid="mirror-detail-account">
                      Connected via {mirror.targetAccountDisplayName}
                    </span>
                  </span>
                </>
              ) : null}
              {addedDate ? (
                <>
                  <span aria-hidden className="text-line">|</span>
                  <span data-testid="mirror-detail-added">Added {addedDate}</span>
                </>
              ) : null}
              {followers !== null ? (
                <>
                  <span aria-hidden className="text-line">|</span>
                  <span data-testid="mirror-detail-followers">
                    <strong className="text-body font-bold text-ink tabular-nums">
                      {followers.toLocaleString('en-US')}
                    </strong>{' '}
                    followers
                  </span>
                </>
              ) : null}
              {showGained ? (
                <>
                  <span aria-hidden className="text-line">|</span>
                  <span
                    data-testid="mirror-detail-followers-gained"
                    className={cn(
                      'font-semibold tabular-nums',
                      gained > 0 ? 'text-signal-operational' : 'text-signal-critical'
                    )}
                  >
                    {gained > 0
                      ? `+${gained.toLocaleString('en-US')}`
                      : gained.toLocaleString('en-US')}{' '}
                    gained
                  </span>
                </>
              ) : null}
              {mirror.targetCategory ? (
                <>
                  <span aria-hidden className="text-line">|</span>
                  <span data-testid="mirror-detail-category">{mirror.targetCategory}</span>
                </>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-metadata text-ink-sub">
              {mirror.sourceAvatarUrl ? (
                <Image
                  src={mirror.sourceAvatarUrl}
                  alt=""
                  width={20}
                  height={20}
                  className="size-5 shrink-0 rounded-full object-cover"
                  unoptimized
                />
              ) : (
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-bold text-ink"
                >
                  {sourceInitial}
                </span>
              )}
              <span data-testid="mirror-detail-source">source: @{mirror.sourceUsername}</span>
              <span aria-hidden>·</span>
              <a
                data-testid="mirror-detail-tiktok-link"
                href={`https://www.tiktok.com/@${mirror.sourceUsername}`}
                target="_blank"
                rel="noreferrer"
                className="text-metadata text-link hover:underline"
              >
                View on TikTok
              </a>
            </div>

            {mirrorAddedDate ? (
              <p
                data-testid="mirror-detail-mirror-added"
                className="mt-2 text-metadata text-ink-dim"
              >
                Mirror added <strong className="text-ink">{mirrorAddedDate}</strong>
                {duration ? (
                  <>
                    {' '}· Mirroring for <strong className="text-ink">{duration}</strong>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            data-testid="mirror-detail-menu-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            disabled={pausePending}
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-md border border-line bg-panel px-3.5 py-2 text-body font-bold text-ink hover:border-brand-gold"
          >
            •••
          </button>
          {menuOpen ? (
            <div
              role="menu"
              tabIndex={-1}
              data-testid="mirror-detail-menu"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMenuOpen(false);
              }}
              className="absolute right-0 z-popover mt-1.5 min-w-44 rounded-md border border-line bg-panel p-1 shadow-elevated"
            >
              <button
                type="button"
                role="menuitem"
                data-testid="mirror-detail-menu-pause"
                disabled={pausePending || resumeLocked}
                onClick={() => {
                  setMenuOpen(false);
                  onPauseResume();
                }}
                className="block w-full rounded-sm px-3 py-2.5 text-left text-body text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="mirror-detail-menu-delete"
                onClick={() => {
                  setMenuOpen(false);
                  onDeleteRequest();
                }}
                className="block w-full rounded-sm px-3 py-2.5 text-left text-body text-signal-critical hover:bg-subtle"
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div
        data-testid="mirror-detail-timing"
        className="mb-6 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4 text-metadata text-ink-dim"
      >
        <span>
          Last mirrored:{' '}
          <strong className="text-ink">
            {mirror.lastMirroredPost
              ? formatDateTime(mirror.lastMirroredPost.createdAt)
              : 'Nothing yet'}
          </strong>
        </span>
        <span>
          Next check:{' '}
          <strong className="text-ink">
            {formatDateTime(mirror.nextCheckAt)}
            {countdown ? ` (${countdown})` : ''}
          </strong>
        </span>
        <span>
          Last checked: <strong className="text-ink">{formatDateTime(mirror.lastCheckedAt)}</strong>
        </span>
        <span>Checks hourly</span>
      </div>
    </div>
  );
}
