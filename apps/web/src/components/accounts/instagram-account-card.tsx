'use client';

/**
 * Instagram account card — Facebook's `account-card.tsx` geometry, with
 * Instagram data in every slot. The linked-pages strip's real Instagram
 * analogue is the account's publishing destinations (the `destinations`
 * rows for this account — normally exactly one, the account itself):
 * the strip shows the real destination count in the same slot, and the
 * header's profile link points at the provider-reported Instagram
 * handle (`instagram.com/<handle>`). There is no destinations page to
 * navigate to, so the strip is a label, not a navigation button.
 * Status uses the shared `StatusMark` exactly as Facebook's card does
 * (tick / cross / clock icon + text, never a dot).
 */
import * as React from 'react';
import Image from 'next/image';
import { ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { StatusMark, type StatusMarkKind } from '@/components/shared/ui/status-mark';
import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import {
  getInstagramAccountHealth,
  getInstagramAccountHealthLabel,
  getInstagramAccountHealthSignal,
  isInstagramTokenExpiringSoon,
} from './instagram-account-health';

export interface InstagramAccountItem {
  id: string;
  externalAccountId: string;
  displayName: string;
  profilePictureUrl?: string | null | undefined;
  status: string;
  tokenExpiresAt?: string | Date | null | undefined;
  createdAt: string | Date;
  updatedAt?: string | Date | undefined;
  /** Real destination count from the list route (Facebook's pages count analogue). */
  destinationCount?: number | undefined;
  /** Provider-reported Instagram username, from the destination row. */
  destinationHandle?: string | null | undefined;
  /** Destination display name, from the destination row. */
  destinationName?: string | null | undefined;
}

export interface InstagramAccountCardProps {
  account: InstagramAccountItem;
  onReconnect?: ((account: InstagramAccountItem) => void) | undefined;
  onDisconnect?: ((account: InstagramAccountItem) => void) | undefined;
  highlighted?: boolean | undefined;
}

function initialsFor(name: string | null | undefined, fallback: string): string {
  if (!name || !name.trim()) return fallback;
  return getUserInitials(name);
}

const RING_CLASSES = {
  operational: 'border-signal-operational',
  queued: 'border-signal-queued',
  critical: 'border-signal-critical',
} as const;

/**
 * Account-card status mark — the shared `StatusMark`, exactly as
 * Facebook's card uses it (icon + text only, deliberately NOT the
 * shared `StatusDot`, which renders a coloured dot before its icon).
 */
function InstagramAccountHealthMark({
  status,
  label,
}: Readonly<{
  status: StatusMarkKind;
  label: string;
}>) {
  return (
    <StatusMark
      kind={status}
      label={label}
      testId="account-health-mark"
      className="font-medium"
    />
  );
}

export function InstagramAccountCard({
  account,
  onReconnect,
  onDisconnect,
  highlighted = false,
}: Readonly<InstagramAccountCardProps>) {
  const health = getInstagramAccountHealth(account);
  const isExpired = health === 'expired';
  const isExpiringSoon = isInstagramTokenExpiringSoon(account);
  // Facebook's signal mapping exactly: connected + expiring-soon shows
  // the queued clock, everything else follows the health signal.
  const statusSignal: StatusMarkKind =
    health === 'connected' && isExpiringSoon
      ? 'queued'
      : getInstagramAccountHealthSignal(health);
  const statusLabel = getInstagramAccountHealthLabel(health);
  const ringClass = RING_CLASSES[statusSignal];
  const destinationCount = account.destinationCount ?? 0;
  const destinationsLabel = `${destinationCount} ${
    destinationCount === 1 ? 'destination linked' : 'destinations linked'
  }`;
  const profileHref = account.destinationHandle
    ? `https://www.instagram.com/${encodeURIComponent(account.destinationHandle)}/`
    : null;

  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);

  const formattedDate = React.useMemo(() => {
    try {
      const d = new Date(account.createdAt);
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return 'recently';
    }
  }, [account.createdAt]);

  const initials = initialsFor(account.displayName, 'IG');
  const showAvatarImg =
    Boolean(account.profilePictureUrl) &&
    failedAvatarUrl !== account.profilePictureUrl;

  return (
    <div
      data-testid={`account-card-${account.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn(
        'flex min-h-40 flex-col justify-between rounded-md border bg-panel p-6 shadow-card transition hover:-translate-y-0.5 hover:shadow-elevated',
        highlighted
          ? 'border-link ring-2 ring-link/40'
          : isExpired
            ? 'border-signal-critical'
            : 'border-line'
      )}
    >
      <div className="mb-4 flex items-center gap-4">
        {showAvatarImg && account.profilePictureUrl ? (
          <Image
            src={account.profilePictureUrl}
            alt={account.displayName}
            width={44}
            height={44}
            data-testid="account-avatar-img"
            onError={() => setFailedAvatarUrl(account.profilePictureUrl ?? '__error__')}
            className={cn('size-11 shrink-0 rounded-full border-2 object-cover', ringClass)}
          />
        ) : (
          <div
            data-testid="account-avatar-initials"
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-full border-2 bg-subtle text-body font-bold text-ink',
              ringClass
            )}
          >
            {initials}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 overflow-hidden">
            <h3 data-testid="account-name" className="truncate text-body font-semibold text-ink">
              {account.displayName}
            </h3>

            {profileHref && (
              <a
                href={profileHref}
                target="_blank"
                rel="noopener noreferrer"
                title="View Instagram Profile"
                aria-label={`View ${account.displayName}'s Instagram Profile`}
                data-testid="account-profile-link"
                className="inline-flex shrink-0 items-center text-ink-dim outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
              >
                <ExternalLinkIcon className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span data-testid="account-health-label" className="inline-flex">
              <InstagramAccountHealthMark status={statusSignal} label={statusLabel} />
            </span>
            <span data-testid="account-connected-date" className="text-metadata text-ink-dim">
              · Connected {formattedDate}
            </span>
          </div>
        </div>
      </div>

      {/* Destinations strip — Facebook's linked-pages strip slot, with
          the real Instagram analogue: the account's destination count.
          A label, not a navigation button: there is no Instagram
          destinations page to navigate to. */}
      <div className="mb-4 flex items-center justify-between">
        <span data-testid="account-destinations-count" className="px-2 py-1 text-body text-ink-dim">
          {destinationsLabel}
        </span>
      </div>

      {isExpired && (
        <div
          data-testid="account-expired-alert"
          className="mb-4 flex items-center gap-1.5 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-2.5 py-1.5 text-metadata font-medium text-signal-critical-on-tint"
        >
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
          <span>Session expired — reconnect to resume publishing</span>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        {isExpired || isExpiringSoon ? (
          <Button
            type="button"
            data-testid="account-reconnect-button"
            variant={isExpired ? 'default' : 'outline'}
            onClick={() => onReconnect?.(account)}
          >
            <span>{isExpired ? 'Reconnect account' : 'Refresh connection'}</span>
          </Button>
        ) : (
          <div className="flex-1" />
        )}

        <Button
          type="button"
          variant="ghost"
          data-testid="account-disconnect-button"
          onClick={() => onDisconnect?.(account)}
          className="text-ink-dim hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}
