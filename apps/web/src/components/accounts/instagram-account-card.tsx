'use client';

/**
 * Instagram account card — modelled on Facebook's `account-card.tsx`
 * (same geometry, avatar ring, status + date line, expired alert, and
 * card actions) but Instagram-only: NO linked-pages strip, NO "View
 * profile" link, NO Pages navigation. An Instagram account's single
 * destination row is the account itself, so a pages strip would be a
 * fabrication. Status is a circle mark, never a dot: a tick in a green
 * circle for connected, a cross in a red circle for expired/error, and
 * a clock in a queued-colour circle for connected-but-expiring-soon
 * (label stays "Connected", as on Facebook).
 */
import * as React from 'react';
import Image from 'next/image';
import { CheckIcon, ClockIcon, TriangleAlertIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import {
  getInstagramAccountHealth,
  getInstagramAccountHealthLabel,
  isInstagramTokenExpiringSoon,
  type InstagramAccountHealth,
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

const RING_CLASSES: Record<string, string> = {
  connected: 'border-signal-operational',
  expiring: 'border-signal-queued',
  expired: 'border-signal-critical',
  error: 'border-signal-critical',
};

function InstagramAccountHealthMark({
  health,
  expiringSoon,
}: Readonly<{ health: InstagramAccountHealth; expiringSoon: boolean }>) {
  const label = getInstagramAccountHealthLabel(health);
  const Icon = health === 'connected' && !expiringSoon
    ? CheckIcon
    : health === 'connected'
      ? ClockIcon
      : XIcon;
  const circleClass =
    health === 'connected' && !expiringSoon
      ? 'bg-signal-operational'
      : health === 'connected'
        ? 'bg-signal-queued'
        : 'bg-signal-critical';
  const textClass =
    health === 'connected' && !expiringSoon
      ? 'text-signal-operational'
      : health === 'connected'
        ? 'text-signal-queued'
        : 'text-signal-critical';
  return (
    <span
      data-testid="account-health-mark"
      role="status"
      aria-label={label}
      className={cn('inline-flex items-center gap-1.5 font-medium', textClass)}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-5.5 shrink-0 items-center justify-center rounded-full text-neutral-white',
          circleClass
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </span>
      <span>{label}</span>
    </span>
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
  const ringKey = isExpired
    ? 'expired'
    : health === 'error'
      ? 'error'
      : isExpiringSoon
        ? 'expiring'
        : 'connected';
  const ringClass = RING_CLASSES[ringKey] ?? 'border-line';

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
          <h3 data-testid="account-name" className="truncate text-body font-semibold text-ink">
            {account.displayName}
          </h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span data-testid="account-health-label" className="inline-flex">
              <InstagramAccountHealthMark health={health} expiringSoon={isExpiringSoon} />
            </span>
            <span data-testid="account-connected-date" className="text-metadata text-ink-dim">
              · Connected {formattedDate}
            </span>
          </div>
        </div>
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
