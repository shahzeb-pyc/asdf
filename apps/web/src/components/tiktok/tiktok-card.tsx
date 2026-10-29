'use client';

import * as React from 'react';
import Image from 'next/image';

import { cn } from '@/lib/utils';
import { StatusMark, type StatusMarkKind } from '@/components/shared/ui/status-mark';
import type { MirrorView } from '@/lib/api/schemas/tiktok-mirrors';

/**
 * TikTok mirror card — the Pages card pattern for mirrors: avatar +
 * identity, status as colour + icon + text (never a dot), linked
 * page, last mirrored reel, next check. Clicking opens the mirror's
 * dedicated view.
 */

export function mirrorStatusMark(status: MirrorView['status']): {
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

export interface TikTokCardProps {
  mirror: MirrorView;
  onSelect?: ((mirror: MirrorView) => void) | undefined;
  highlighted?: boolean | undefined;
}

export function TikTokCard({ mirror, onSelect, highlighted }: Readonly<TikTokCardProps>) {
  const mark = mirrorStatusMark(mirror.status);
  const lastMirrored = formatRelativeTime(mirror.lastMirroredPost?.createdAt ?? null);
  const nextCheck = formatRelativeTime(mirror.nextCheckAt);
  return (
    <button
      type="button"
      data-testid={`tiktok-mirror-card-${mirror.id}`}
      onClick={() => onSelect?.(mirror)}
      className={cn(
        'w-full rounded-md border border-line bg-panel p-4 text-left shadow-sm transition-colors hover:border-brand-gold/60',
        highlighted && 'border-brand-gold'
      )}
    >
      <div className="flex items-start gap-3">
        {mirror.tiktokAvatarUrl ? (
          <Image
            src={mirror.tiktokAvatarUrl}
            alt=""
            width={48}
            height={48}
            className="size-12 shrink-0 rounded-full object-cover"
            unoptimized
          />
        ) : (
          <span
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink"
          >
            {(mirror.tiktokUsername[0] ?? '?').toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-bold text-ink">@{mirror.tiktokUsername}</p>
          <p className="truncate text-metadata text-ink-sub">
            {mirror.tiktokDisplayName ?? 'TikTok account'}
          </p>
          <p className="truncate text-metadata text-ink-sub">
            → {mirror.destinationName}
          </p>
        </div>
        <StatusMark kind={mark.kind} label={mark.label} testId="tiktok-mirror-status" />
      </div>

      {mirror.lastError ? (
        <p
          data-testid="tiktok-mirror-error"
          className="mt-3 truncate text-metadata text-signal-critical"
        >
          {mirror.lastError}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-metadata text-ink-dim">
        <span data-testid="tiktok-mirror-last">
          {mirror.lastMirroredPost
            ? `Last mirrored ${lastMirrored ?? ''}`
            : 'Nothing mirrored yet'}
        </span>
        {nextCheck ? (
          <span data-testid="tiktok-mirror-next">Next check {nextCheck}</span>
        ) : null}
      </div>
    </button>
  );
}
