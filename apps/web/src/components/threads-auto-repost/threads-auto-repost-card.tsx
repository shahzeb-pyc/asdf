'use client';

import * as React from 'react';
import Image from 'next/image';

import { cn } from '@/lib/utils';
import { StatusMark, type StatusMarkKind } from '@/components/shared/ui/status-mark';
import type { MirrorView } from '@/lib/api/schemas/threads-auto-repost';

/**
 * Threads Auto Repost card — the Facebook mirror card pattern for
 * Threads: avatar + identity, status as colour + icon + text (never
 * a dot), linked Threads account, last mirrored reel, next check.
 * Clicking opens the mirror's dedicated view.
 */

export function threadsMirrorStatusMark(status: MirrorView['status']): {
  kind: StatusMarkKind;
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

function formatRelativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export interface ThreadsAutoRepostCardProps {
  mirror: MirrorView;
  onSelect?: ((mirror: MirrorView) => void) | undefined;
  highlighted?: boolean | undefined;
}

export function ThreadsAutoRepostCard({ mirror, onSelect, highlighted }: Readonly<ThreadsAutoRepostCardProps>) {
  const mark = threadsMirrorStatusMark(mirror.status);
  const lastMirrored = formatRelativeTime(mirror.lastMirroredPost?.createdAt ?? null);
  const nextCheck = formatRelativeTime(mirror.nextCheckAt);
  return (
    <button
      type="button"
      data-testid={`threads-mirror-card-${mirror.id}`}
      onClick={() => onSelect?.(mirror)}
      className={cn(
        'w-full rounded-md border border-line bg-panel p-4 text-left shadow-card transition-colors hover:border-brand-gold/60',
        highlighted && 'border-brand-gold'
      )}
    >
      <div className="flex items-center gap-3">
        {mirror.sourceAvatarUrl ? (
          <Image
            src={mirror.sourceAvatarUrl}
            alt=""
            width={56}
            height={56}
            className="size-14 shrink-0 rounded-full object-cover"
            unoptimized
          />
        ) : (
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-subtle text-xl font-bold text-ink"
          >
            {(mirror.sourceUsername[0] ?? '?').toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold leading-heading text-ink">@{mirror.sourceUsername}</p>
          <p className="truncate text-metadata text-ink-sub">
            {mirror.sourceDisplayName ?? 'TikTok account'}
          </p>
          <p className="truncate text-metadata text-ink-sub">
            → {mirror.targetDisplayName}
          </p>
        </div>
        <StatusMark kind={mark.kind} label={mark.label} testId="threads-mirror-status" />
      </div>

      {mirror.lastError ? (
        <p
          data-testid="threads-mirror-error"
          className="mt-3 truncate text-metadata text-signal-critical"
        >
          {mirror.lastError}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-metadata text-ink-dim">
        <span data-testid="threads-mirror-last">
          {mirror.lastMirroredPost
            ? `Last mirrored ${lastMirrored ?? ''}`
            : 'Nothing mirrored yet'}
        </span>
        {nextCheck ? (
          <span data-testid="threads-mirror-next">Next check {nextCheck}</span>
        ) : null}
      </div>
    </button>
  );
}
