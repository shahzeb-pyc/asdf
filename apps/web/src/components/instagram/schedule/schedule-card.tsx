'use client';

import * as React from 'react';
import Image from 'next/image';

import type { InstagramScheduleItem } from '@/lib/api/schemas/instagram-schedule';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { cn } from '@/lib/utils';

/**
 * Instagram Schedule card — the PageCard analogue for a scheduled
 * Instagram account. Real fields only: avatar, name, @handle,
 * account type, status (colour + icon + text, never a dot), queued /
 * posted / failed counts, timezone. No followers: no Instagram
 * follower read exists, so none is shown.
 */

function statusMarkFor(item: InstagramScheduleItem) {
  switch (item.status) {
    case 'active':
      return { kind: 'operational' as const, label: 'Connected' };
    case 'paused':
      return { kind: 'queued' as const, label: 'Paused' };
    case 'expired':
      return { kind: 'critical' as const, label: 'Session expired' };
    default:
      return { kind: 'critical' as const, label: 'Disconnected' };
  }
}

export function ScheduleCard({
  item,
  subdomain,
  highlighted,
  onSelect,
}: Readonly<{
  item: InstagramScheduleItem;
  subdomain: string;
  highlighted?: boolean;
  onSelect: (item: InstagramScheduleItem) => void;
}>) {
  void subdomain;
  const mark = statusMarkFor(item);
  return (
    <Card
      data-testid={`instagram-schedule-card-${item.id}`}
      className={cn(
        'cursor-pointer transition-shadow hover:shadow-elevated',
        highlighted && 'border-brand-gold bg-brand-gold/10'
      )}
      onClick={() => onSelect(item)}
    >
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          {item.accountAvatarUrl ? (
            <Image
              src={item.accountAvatarUrl}
              alt=""
              width={40}
              height={40}
              className="size-10 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-subtle text-lg font-semibold text-ink"
            >
              {item.accountDisplayName.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <CardTitle className="truncate">{item.accountDisplayName}</CardTitle>
            <p className="m-0 truncate text-body text-ink-sub">
              {item.handle ? `@${item.handle}` : 'Instagram account'}
              {item.accountType ? ` · ${item.accountType}` : ''}
            </p>
          </div>
        </div>
        <StatusMark kind={mark.kind} label={mark.label} testId={`instagram-schedule-status-${item.id}`} />
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-4">
          <div>
            <dt className="text-metadata text-ink-sub">Queued</dt>
            <dd className="m-0 text-lg font-semibold">{item.counts.queued}</dd>
          </div>
          <div>
            <dt className="text-metadata text-ink-sub">Posted</dt>
            <dd className="m-0 text-lg font-semibold">{item.counts.posted}</dd>
          </div>
          <div>
            <dt className="text-metadata text-ink-sub">Failed</dt>
            <dd className="m-0 text-lg font-semibold">{item.counts.failed}</dd>
          </div>
        </dl>
        <p className="mt-4 mb-0 text-body text-ink-sub">
          {item.slotCount} posting {item.slotCount === 1 ? 'time' : 'times'} · {item.timezone}
        </p>
      </CardContent>
    </Card>
  );
}
