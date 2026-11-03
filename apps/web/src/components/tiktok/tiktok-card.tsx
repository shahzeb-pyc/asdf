'use client';

import * as React from 'react';
import Image from 'next/image';
import { CheckIcon, ClockIcon, MoveUpRightIcon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { getUserInitials } from '@/lib/user-initials';
import type { MirrorListView } from '@/lib/api/schemas/tiktok-mirrors';
import { formatAddedDate } from '@/components/pages/page-card';
import { mapStoredMirrorErrorToDisplay } from '@fbuploadpro/contracts';

/**
 * TikTok mirror card — the Pages card pattern for mirrors: the
 * TARGET PAGE is the primary identity (avatar with status ring,
 * name, Added date, followers + category, circled arrow), then the
 * Facebook link, then a muted `source: @username` line for the
 * TikTok creator (source only, never the primary identity), then
 * divider + status footer, then divider + Posted / Failed counts.
 * No Queued column. Status is colour + icon + text, with a tick in
 * a green circle for Active (the standing status-mark rule) — never
 * a dot. Clicking the card opens the mirror's dedicated view; the
 * Facebook link inside it navigates independently.
 *
 * This card renders the LIST view (MirrorListView): it carries no
 * lastMirroredPost and no nextCheckAt — those live on the detail
 * view only.
 */

export function mirrorStatusMark(status: MirrorListView['status']): {
  kind: 'operational' | 'queued' | 'critical';
  label: string;
} {
  switch (status) {
    case 'active':
      return { kind: 'operational', label: 'Active' };
    case 'paused':
      return { kind: 'queued', label: 'Paused' };
    case 'error':
      return { kind: 'critical', label: 'Error' };
  }
}

export const MIRROR_STATUS_RING_CLASSES = {
  operational: 'border-2 border-signal-operational',
  queued: 'border-2 border-signal-queued',
  critical: 'border-2 border-signal-critical',
} as const;

const CIRCLE_CLASSES = {
  operational: 'bg-signal-operational',
  queued: 'bg-signal-queued',
  critical: 'bg-signal-critical',
} as const;

const CIRCLE_ICONS = {
  operational: CheckIcon,
  queued: ClockIcon,
  critical: XIcon,
} as const;

const STATUS_TEXT_CLASSES = {
  operational: 'text-signal-operational',
  queued: 'text-signal-queued',
  critical: 'text-signal-critical',
} as const;

/**
 * Circled status mark — the Facebook-settings mark pattern (icon
 * in a signal-coloured circle + text), token-backed, never a dot.
 * The shared `StatusMark` renders a bare icon, not a circle, so the
 * card uses this circled form to match the approved mockup.
 */
export function MirrorStatusCircle({ status, label }: Readonly<{ status: MirrorListView['status']; label: string }>) {
  const mark = mirrorStatusMark(status);
  const Icon = CIRCLE_ICONS[mark.kind];
  return (
    <span
      data-testid="tiktok-mirror-status"
      role="status"
      aria-label={label}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-metadata font-semibold tracking-wide',
        STATUS_TEXT_CLASSES[mark.kind]
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-5.5 shrink-0 items-center justify-center rounded-full text-neutral-white',
          CIRCLE_CLASSES[mark.kind]
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

export interface TikTokCardProps {
  mirror: MirrorListView;
  onSelect?: ((mirror: MirrorListView) => void) | undefined;
  highlighted?: boolean | undefined;
}

export function TikTokCard({ mirror, onSelect, highlighted }: Readonly<TikTokCardProps>) {
  const mark = mirrorStatusMark(mirror.status);
  const ringClass = MIRROR_STATUS_RING_CLASSES[mark.kind];
  const addedDate = mirror.targetAddedAt ? formatAddedDate(mirror.targetAddedAt) : '';
  const facebookUrl =
    mirror.targetPlatform === 'facebook'
      ? `https://facebook.com/${mirror.targetExternalId}`
      : null;
  const rawPageName = mirror.targetDisplayName.trim();
  const initials = rawPageName ? getUserInitials(rawPageName) : 'PG';
  const showAvatarImg = Boolean(mirror.targetAvatarUrl);

  return (
    <button
      type="button"
      data-testid={`tiktok-mirror-card-${mirror.id}`}
      onClick={() => onSelect?.(mirror)}
      className={cn(
        'group flex min-w-0 w-full cursor-pointer flex-col rounded-md border bg-panel p-6 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-elevated',
        highlighted ? 'border-link ring-2 ring-link/40' : 'border-line hover:border-brand-emerald/40'
      )}
    >
      <div className="flex items-start gap-4">
        {showAvatarImg ? (
          <Image
            src={mirror.targetAvatarUrl!}
            alt=""
            width={42}
            height={42}
            data-testid="tiktok-mirror-page-avatar-img"
            className={cn('size-10.5 shrink-0 rounded-full object-cover', ringClass)}
            unoptimized
          />
        ) : (
          <span
            aria-hidden
            data-testid="tiktok-mirror-page-avatar-initials"
            className={cn(
              'flex size-10.5 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink',
              ringClass
            )}
          >
            {initials}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p data-testid="tiktok-mirror-page-name" className="truncate text-body font-semibold text-ink">
            {mirror.targetDisplayName}
          </p>
          {addedDate ? (
            <span
              data-testid="tiktok-mirror-page-added"
              className="mt-0.5 block truncate text-metadata text-ink-dim"
            >
              Added {addedDate}
            </span>
          ) : null}
          {mirror.targetFollowers !== null ? (
            <span
              data-testid="tiktok-mirror-page-followers"
              className="mt-0.5 block truncate text-metadata text-ink-sub"
            >
              <span className="text-body font-bold text-ink tabular-nums">
                {mirror.targetFollowers.toLocaleString('en-US')}
              </span>{' '}
              followers
              <span data-testid="tiktok-mirror-page-category">
                {' '}
                · {mirror.targetCategory || 'Facebook Page'}
              </span>
            </span>
          ) : null}
        </div>
        <span
          data-testid="tiktok-mirror-card-arrow"
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line text-ink-sub transition group-hover:border-link group-hover:text-link"
        >
          <MoveUpRightIcon className="size-4" />
        </span>
      </div>

      {facebookUrl ? (
        <div data-testid="tiktok-mirror-facebook-link-row" className="mt-3 flex items-center justify-between gap-4">
          <a
            data-testid="tiktok-mirror-facebook-link"
            href={facebookUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 shrink-0 truncate text-metadata text-brand-facebook hover:underline"
          >
            View on Facebook{' '}
            <MoveUpRightIcon aria-hidden className="inline size-3 shrink-0" />
          </a>
        </div>
      ) : null}

      <div className="mt-1.5">
        <span data-testid="tiktok-mirror-source" className="truncate text-metadata text-ink-sub">
          source: @{mirror.sourceUsername}
        </span>
      </div>

      {mirror.lastError ? (
        <p
          data-testid="tiktok-mirror-error"
          className="mt-3 truncate text-metadata text-signal-critical"
        >
          {mapStoredMirrorErrorToDisplay(mirror.lastError)}
        </p>
      ) : null}

      <div aria-hidden className="pt-3">
        <div className="border-t border-line" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <MirrorStatusCircle status={mirror.status} label={mark.label} />
        {mirror.targetAccountDisplayName ? (
          <p
            data-testid="tiktok-mirror-account"
            className="min-w-0 max-w-45 shrink-0 truncate text-right text-metadata text-ink-sub"
          >
            Account: {mirror.targetAccountDisplayName}
          </p>
        ) : null}
      </div>

      <div aria-hidden className="pt-3">
        <div className="border-t border-line" />
      </div>
      <div
        data-testid="tiktok-mirror-post-counts"
        className="mt-3 grid grid-cols-2 gap-4"
      >
        <span
          data-testid="tiktok-mirror-posted-stat"
          className="flex flex-col items-center text-center"
        >
          <span
            data-testid="tiktok-mirror-posted-count"
            className="text-xxl font-bold tabular-nums text-signal-operational"
          >
            {mirror.postCountsError ? '—' : mirror.postCounts.posted.toLocaleString('en-US')}
          </span>
          <span className="mt-1 text-metadata text-ink-sub">Posted</span>
        </span>
        <span
          data-testid="tiktok-mirror-failed-stat"
          className="flex flex-col items-center text-center"
        >
          <span
            data-testid="tiktok-mirror-failed-count"
            className="text-xxl font-bold tabular-nums text-signal-critical"
          >
            {mirror.postCountsError ? '—' : mirror.postCounts.failed.toLocaleString('en-US')}
          </span>
          <span className="mt-1 text-metadata text-ink-sub">Failed</span>
        </span>
      </div>
      {mirror.postCountsError ? (
        <p
          data-testid="tiktok-mirror-post-counts-error"
          className="m-0 mt-2 text-center text-metadata text-ink-sub"
        >
          Post counts unavailable
        </p>
      ) : null}
    </button>
  );
}
