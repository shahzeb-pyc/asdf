'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';

import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import { StatusMark, type StatusMarkKind } from '@/components/shared/ui/status-mark';
import type { ThreadsScheduleItem, ThreadsScheduleStatus } from '@fbuploadpro/contracts';

export type { ThreadsScheduleItem };

const STATUS_META: Record<ThreadsScheduleStatus, { kind: StatusMarkKind; label: string }> = {
  active: { kind: 'operational', label: 'Active' },
  paused: { kind: 'idle', label: 'Paused' },
  expired: { kind: 'critical', label: 'Connection expired' },
  disconnected: { kind: 'critical', label: 'Disconnected' },
  rate_limited: { kind: 'queued', label: 'Rate limited' },
  error: { kind: 'critical', label: 'Needs attention' },
};

export function ThreadsScheduleCard({
  item,
  subdomain,
}: Readonly<{ item: ThreadsScheduleItem; subdomain: string }>) {
  const meta = STATUS_META[item.status];
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  const showAvatar = Boolean(item.profilePictureUrl) && !avatarFailed;
  const countsError = item.queueCountsError === true;
  return (
    <Link
      href={`/tenant/${subdomain}/threads/schedule/${item.id}`}
      data-testid={`threads-schedule-card-${item.id}`}
      className="flex min-h-40 flex-col justify-between rounded-md border border-line bg-panel p-6 shadow-card transition hover:-translate-y-0.5 hover:shadow-elevated"
    >
      <div className="mb-4 flex items-center gap-4">
        <div
          className={cn(
            'flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-subtle text-body font-bold',
            meta.kind === 'operational'
              ? 'border-signal-operational'
              : meta.kind === 'critical'
                ? 'border-signal-critical'
                : 'border-line'
          )}
        >
          {showAvatar && item.profilePictureUrl ? (
            <Image
              src={item.profilePictureUrl}
              alt={item.name}
              width={44}
              height={44}
              className="size-11 object-cover"
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span>{getUserInitials(item.name)}</span>
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-body font-bold text-ink">{item.name}</p>
          {item.handle ? (
            <p className="truncate text-metadata text-ink-dim">@{item.handle}</p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <StatusMark kind={meta.kind} label={meta.label} testId={`threads-schedule-status-${item.id}`} />
        <span className="text-metadata text-ink-dim">
          {countsError
            ? 'Queued – · Posted – · Failed –'
            : `Queued ${item.queueCounts.queued} · Posted ${item.queueCounts.posted} · Failed ${item.queueCounts.failed}`}
        </span>
      </div>
    </Link>
  );
}
