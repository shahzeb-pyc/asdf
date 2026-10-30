'use client';

/**
 * Threads account card — Threads-specific, modelled on the Facebook
 * AccountCard minus everything Facebook-only: no pages-linked strip,
 * no linked-pages list, no Facebook profile link. Status is icon +
 * text via the shared StatusMark (tick for connected, cross for
 * expired/error) — never a dot. Avatar ring follows the same signal
 * mapping as Facebook cards (green connected, red expired/error,
 * gold expiring-soon).
 */
import * as React from 'react';
import Image from 'next/image';
import { ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { StatusMark, type StatusMarkKind } from '@/components/shared/ui/status-mark';
import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import {
  getThreadsAccountHealth,
  getThreadsAccountHealthLabel,
  isThreadsTokenExpiringSoon,
} from './threads-accounts-helpers';

export interface ThreadsAccountItem {
  id: string;
  threadsAccountId: string;
  displayName: string;
  profilePictureUrl?: string | null | undefined;
  /** Threads @handle from the account's destination row, when linked. */
  handle?: string | null | undefined;
  /** Public Threads profile address for the handle, when linked. */
  accountLink?: string | null | undefined;
  /** Destinations linked to this account (the profile itself, normally 1). */
  connectedDestinationsCount?: number | undefined;
  status: 'active' | 'disconnected' | 'expired';
  tokenExpiresAt?: string | null | undefined;
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface ThreadsAccountCardProps {
  account: ThreadsAccountItem;
  onReconnect?: ((account: ThreadsAccountItem) => void) | undefined;
  onDisconnect?: ((account: ThreadsAccountItem) => void) | undefined;
  highlighted?: boolean | undefined;
}

const RING_CLASSES = {
  operational: 'border-signal-operational',
  queued: 'border-signal-queued',
  critical: 'border-signal-critical',
  idle: 'border-signal-idle',
} as const;

function initialsFor(name: string | null | undefined, fallback: string): string {
  if (!name || !name.trim()) return fallback;
  return getUserInitials(name);
}

export function ThreadsAccountCard({
  account,
  onReconnect,
  onDisconnect,
  highlighted = false,
}: Readonly<ThreadsAccountCardProps>) {
  const health = getThreadsAccountHealth(account);
  const isExpired = health === 'expired';
  const isExpiringSoon = isThreadsTokenExpiringSoon(account);
  const statusSignal: StatusMarkKind =
    health === 'connected' && isExpiringSoon
      ? 'queued'
      : health === 'connected'
        ? 'operational'
        : 'critical';
  const statusLabel = getThreadsAccountHealthLabel(health);
  const ringClass = RING_CLASSES[statusSignal];

  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(
    null
  );
  const showAvatarImg =
    Boolean(account.profilePictureUrl) &&
    failedAvatarUrl !== account.profilePictureUrl;
  const initials = initialsFor(account.displayName, 'TH');

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

  return (
    <div
      data-testid={`threads-account-card-${account.id}`}
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
            data-testid="threads-account-avatar-img"
            onError={() => setFailedAvatarUrl(account.profilePictureUrl ?? '__error__')}
            className={cn('size-11 shrink-0 rounded-full border-2 object-cover', ringClass)}
          />
        ) : (
          <div
            data-testid="threads-account-avatar-initials"
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
            <h3
              data-testid="threads-account-name"
              className="truncate text-body font-semibold text-ink"
            >
              {account.displayName}
            </h3>

            {account.accountLink && (
              <a
                href={account.accountLink}
                target="_blank"
                rel="noopener noreferrer"
                title="View Threads Profile"
                aria-label={`View ${account.displayName}'s Threads Profile`}
                data-testid="threads-account-profile-link"
                className="inline-flex shrink-0 items-center text-ink-dim outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
              >
                <ExternalLinkIcon className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span data-testid="threads-account-health-label" className="inline-flex">
              <StatusMark
                kind={statusSignal}
                label={statusLabel}
                testId="threads-account-health-mark"
                className="font-medium"
              />
            </span>
            <span
              data-testid="threads-account-connected-date"
              className="text-metadata text-ink-dim"
            >
              · Connected {formattedDate}
            </span>
          </div>
        </div>
      </div>

      {isExpired && (
        <div
          data-testid="threads-account-expired-alert"
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
            data-testid="threads-account-reconnect-button"
            variant={isExpired ? 'default' : 'outline'}
            onClick={() => onReconnect?.(account)}
          >
            <span>
              {isExpired ? 'Reconnect account' : 'Refresh connection'}
            </span>
          </Button>
        ) : (
          <div className="flex-1" />
        )}

        <Button
          type="button"
          variant="ghost"
          data-testid="threads-account-disconnect-button"
          onClick={() => onDisconnect?.(account)}
          className="text-ink-dim hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}
