'use client';

/**
 * Page card (spec 131 PR-131-2) — rebuilt on the design system:
 * token-backed Tailwind utilities only (zero inline styles), the
 * avatar on `next/image` (the file's raw img element is deleted),
 * and status as icon + text via the Accounts-style `PageStatusMark`
 * (no status dot). Layout, copy, testids, and the click / Enter /
 * Space activation behaviours are preserved (spec §6 parity).
 *
 * The exported `FacebookPageItem` type is a cross-PR contract
 * (consumed by the dedicated section route, PR-131-3) — its shape
 * is frozen in this PR.
 */
import * as React from 'react';
import Image from 'next/image';
import {
  MoveUpRightIcon,
} from 'lucide-react';

import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import { StatusMark } from '@/components/shared/ui/status-mark';

export type FacebookPageStatus =
  | 'active'
  | 'paused'
  | 'fb_rate_limited'
  | 'page_checkpoint'
  | 'invalid_token'
  | 'disconnected';

export interface FacebookPageItem {
  id: string;
  facebookAccountId: string;
  accountDisplayName?: string | undefined;
  accountPictureUrl?: string | null | undefined;
  fbPageId: string;
  pageName: string;
  profilePictureUrl?: string | null | undefined;
  category?: string | null | undefined;
  timezone?: string | undefined;
  startingFollowers: number;
  currentFollowers: number;
  followersGained: number;
  status: FacebookPageStatus;
  tasks?: string[] | undefined;
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface PageCardProps {
  page: FacebookPageItem;
  subdomain?: string | undefined;
  onSelectPage?: ((page: FacebookPageItem) => void) | undefined;
  forceAvatarError?: boolean | undefined;
  /** Gold highlight for just-imported cards, shown while the import toast is up. */
  highlighted?: boolean | undefined;
}

export function isPageNeedsAttention(status: FacebookPageStatus): boolean {
  return (
    status === 'invalid_token' ||
    status === 'page_checkpoint' ||
    status === 'fb_rate_limited'
  );
}

export function getPageStatusLabel(status: FacebookPageStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'invalid_token':
      return 'Token Expired';
    case 'page_checkpoint':
      return 'Identity Checkpoint';
    case 'fb_rate_limited':
      return 'Rate Limited';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Active';
  }
}

/**
 * Added date for the card, from the page's import date (`createdAt`),
 * formatted like "12 Oct 2026". Returns '' for an unparseable date so
 * the card simply omits the line instead of rendering garbage.
 */
export function formatAddedDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * Page status mark — the shared `StatusMark` (icon + text, NO dot)
 * with this card's testid and type tweaks, so the rendered output is
 * identical to the old local mark. Do not reintroduce StatusDot here.
 */
export type PageStatusMarkKind = 'operational' | 'queued' | 'critical';

export function getPageStatusMarkKind(
  status: FacebookPageStatus
): PageStatusMarkKind {
  if (status === 'active') return 'operational';
  if (status === 'paused') return 'queued';
  return 'critical';
}

export function PageStatusMark({
  status,
  label,
}: Readonly<{ status: FacebookPageStatus; label: string }>) {
  return (
    <StatusMark
      kind={getPageStatusMarkKind(status)}
      label={label}
      testId="page-status"
      className="min-w-0 font-semibold tracking-wide"
      labelClassName="truncate"
    />
  );
}

const RING_CLASSES: Record<PageStatusMarkKind, string> = {
  operational: 'border-2 border-signal-operational',
  queued: 'border-2 border-signal-queued',
  critical: 'border-2 border-signal-critical',
};

/**
 * Short, human-comparable form of a page's Facebook Page ID.
 * Pages can share a display name (and even followers and category), so the
 * ID suffix is the distinguishing line that tells two same-named pages apart.
 */
export function formatPageIdSuffix(fbPageId: string): string {
  const trimmed = fbPageId.trim();
  if (!trimmed) return '';
  return trimmed.length <= 6 ? trimmed : `…${trimmed.slice(-6)}`;
}

export function computeFollowersGained(
  page: Pick<FacebookPageItem, 'currentFollowers' | 'startingFollowers'> & {
    followersGained?: number | undefined;
  }
): number {
  if (typeof page.followersGained === 'number') {
    return page.followersGained;
  }
  const current = page.currentFollowers ?? 0;
  const starting = page.startingFollowers ?? current;
  return current - starting;
}

export function formatFollowersGained(gained: number): string {
  if (gained > 0) {
    return `+${gained.toLocaleString('en-US')}`;
  }
  if (gained < 0) {
    return gained.toLocaleString('en-US');
  }
  return '0';
}

export function PageCard({
  page,
  subdomain,
  onSelectPage,
  forceAvatarError = false,
  highlighted = false,
}: Readonly<PageCardProps>) {
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(
    forceAvatarError ? (page.profilePictureUrl ?? '__forced__') : null
  );

  const needsAttention = isPageNeedsAttention(page.status);
  const statusLabel = getPageStatusLabel(page.status);
  const addedDate = formatAddedDate(page.createdAt);
  const facebookUrl = `https://facebook.com/${page.fbPageId}`;
  const ringClass = RING_CLASSES[getPageStatusMarkKind(page.status)];

  const currentFollowers = page.currentFollowers ?? 0;
  const gained = computeFollowersGained(page);
  const formattedGained = formatFollowersGained(gained);

  const gainedClass =
    gained > 0
      ? 'text-brand-emerald'
      : gained < 0
        ? 'text-brand-rose'
        : 'text-ink-sub';

  const rawPageName = page.pageName.trim();
  const initials = rawPageName ? getUserInitials(rawPageName) : 'PG';
  const showAvatarImg =
    Boolean(page.profilePictureUrl) &&
    !forceAvatarError &&
    failedAvatarUrl !== page.profilePictureUrl;

  const targetHref = subdomain
    ? `/tenant/${subdomain}/pages/${page.id}`
    : `/pages/${page.id}`;

  // The Facebook link inside the card must never trigger the card's own
  // navigation: clicks stopPropagation on the link itself, and keyboard
  // activation is ignored here when the event target is (or is inside) a
  // link, so the link stays independently tab-focusable and activatable.
  const isLinkEventTarget = (e: React.SyntheticEvent): boolean => {
    const target = e.target as HTMLElement | null;
    return Boolean(target && typeof target.closest === 'function' && target.closest('a'));
  };

  const handleActivate = (e?: React.SyntheticEvent) => {
    if (e && isLinkEventTarget(e)) return;
    if (onSelectPage) {
      onSelectPage(page);
    } else if (typeof window !== 'undefined') {
      window.location.href = targetHref;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isLinkEventTarget(e)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleActivate();
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      data-testid={`page-card-${page.id}`}
      data-href={targetHref}
      data-highlighted={highlighted ? 'true' : undefined}
      aria-label={`Open ${page.pageName} page details`}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className={cn(
        'group flex min-w-0 cursor-pointer flex-col rounded-md border bg-panel p-6 shadow-card transition outline-none hover:-translate-y-0.5 hover:shadow-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold',
        highlighted
          ? 'border-brand-gold ring-2 ring-brand-gold/40'
          : needsAttention
            ? 'border-brand-rose hover:border-brand-rose'
            : 'border-line hover:border-brand-emerald/40'
      )}
    >
      {/* Top Section: Avatar with Dynamic Status Ring + Identity + Affordance.
          Identity lines, in order: name, Added date, followers + category.
          The followers NUMBER is page-name size (text-body) and bold; the
          rest of the followers line stays muted at metadata size. */}
      <div className="flex items-start gap-4">
        {showAvatarImg ? (
          <Image
            src={page.profilePictureUrl!}
            alt={page.pageName}
            width={42}
            height={42}
            data-testid="page-avatar-img"
            onError={() =>
              setFailedAvatarUrl(page.profilePictureUrl ?? '__error__')
            }
            className={cn('size-10.5 shrink-0 rounded-full object-cover', ringClass)}
          />
        ) : (
          <div
            data-testid="page-avatar-initials"
            className={cn(
              'flex size-10.5 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink',
              ringClass
            )}
          >
            {initials}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h3
            data-testid="page-name"
            className="m-0 truncate text-body font-semibold text-ink"
          >
            {page.pageName}
          </h3>
          {addedDate && (
            <span
              data-testid="page-added-line"
              className="mt-0.5 block truncate text-metadata text-ink-dim"
            >
              Added {addedDate}
            </span>
          )}
          <span
            data-testid="page-followers-line"
            className="mt-0.5 block truncate text-metadata text-ink-sub"
          >
            <span
              data-testid="page-current-followers"
              className="text-body font-bold text-ink tabular-nums"
            >
              {currentFollowers.toLocaleString('en-US')}
            </span>{' '}
            followers
            <span data-testid="page-category">
              {' '}
              · {page.category || 'Facebook Page'}
            </span>
          </span>
        </div>

        {/* Professional circled arrow affordance (muted, gold on hover) */}
        <span
          data-testid="page-card-arrow"
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line text-ink-sub transition group-hover:border-brand-gold group-hover:text-brand-gold"
        >
          <MoveUpRightIcon className="size-4" />
        </span>
      </div>

      {/* Facebook link row, full card width (not inside the identity
          column, where the avatar/arrow columns indented it): link flush
          left, gained flush right against the card edge, lined up with
          the Account text in the footer. No forced card height and no
          pinned footer, so the divider follows the content directly. */}
      <div
        data-testid="page-facebook-link-row"
        className="mt-3 flex items-center justify-between gap-4"
      >
        <a
          data-testid="page-facebook-link"
          href={facebookUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 truncate text-metadata text-brand-facebook hover:underline"
        >
          View on Facebook{' '}
          <MoveUpRightIcon aria-hidden className="inline size-3 shrink-0" />
        </a>
        {gained !== 0 && (
          <span
            data-testid="page-followers-gained"
            className={cn('shrink-0 text-metadata tabular-nums', gainedClass)}
          >
            {formattedGained} gained
          </span>
        )}
      </div>

      {/* Divider + footer, directly under the content (no min height,
          no mt-auto pinning) so no dead space opens up on short cards. */}
      <div aria-hidden className="pt-3">
        <div className="border-t border-line" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <PageStatusMark status={page.status} label={statusLabel} />

        <div
          data-testid="page-parent-account"
          className="min-w-0 max-w-45 shrink-0 truncate text-right text-metadata text-ink-sub"
        >
          Account: {page.accountDisplayName || 'Connected Account'}
        </div>
      </div>
    </div>
  );
}
