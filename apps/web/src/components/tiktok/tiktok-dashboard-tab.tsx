'use client';

import * as React from 'react';
import Image from 'next/image';

import { Card } from '@/components/shared/ui/card';
import { StatusMark } from '@/components/shared/ui/status-mark';
import type {
  MirrorDetailResponse,
  MirrorView,
} from '@/lib/api/schemas/tiktok-mirrors';
import { mirrorStatusMark } from './tiktok-card';

/**
 * Mirror Dashboard tab — the Pages dashboard pattern for mirrors:
 * account identity, linked page, status, last mirrored reel, next
 * check, and mirror history. No queue, no posting times, no
 * calendar: mirrors post on the hourly tick, not on a schedule.
 */

function formatDateTime(iso: string | null): string {
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

function postStatusLabel(status: string): string {
  switch (status) {
    case 'posted':
      return 'Posted';
    case 'pending':
      return 'Pending';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    default:
      return status;
  }
}

export interface TikTokDashboardTabProps {
  mirror: MirrorView;
  posts: MirrorDetailResponse['posts'];
}

export function TikTokDashboardTab({ mirror, posts }: Readonly<TikTokDashboardTabProps>) {
  const mark = mirrorStatusMark(mirror.status);
  const last = mirror.lastMirroredPost;
  return (
    <div data-testid="tiktok-dashboard-tab" className="flex flex-col gap-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-4">
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
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink"
            >
              {(mirror.sourceUsername[0] ?? '?').toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-body font-bold text-ink">@{mirror.sourceUsername}</p>
            {mirror.sourceDisplayName ? (
              <p className="text-metadata text-ink-sub">{mirror.sourceDisplayName}</p>
            ) : null}
            <a
              href={`https://www.tiktok.com/@${mirror.sourceUsername}`}
              target="_blank"
              rel="noreferrer"
              className="text-metadata text-link hover:underline"
            >
              View on TikTok
            </a>
            <p className="mt-1 text-metadata text-ink-sub">
              Mirroring to <strong className="text-ink">{mirror.targetDisplayName}</strong>
            </p>
          </div>
          <StatusMark kind={mark.kind} label={mark.label} testId="tiktok-detail-status" />
        </div>
        {mirror.lastError ? (
          <p role="alert" data-testid="tiktok-detail-error" className="mt-3 text-body text-signal-critical">
            {mirror.lastError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-metadata text-ink-dim">
          <span>
            Last mirrored:{' '}
            <strong className="text-ink">
              {last ? formatDateTime(last.createdAt) : 'Nothing yet'}
            </strong>
          </span>
          <span>
            Next check:{' '}
            <strong className="text-ink">{formatDateTime(mirror.nextCheckAt)}</strong>
          </span>
          <span>
            Last checked:{' '}
            <strong className="text-ink">{formatDateTime(mirror.lastCheckedAt)}</strong>
          </span>
        </div>
      </Card>

      <div>
        <h2 className="mb-3 text-body font-bold text-ink">Mirror history</h2>
        {posts.length === 0 ? (
          <p data-testid="tiktok-history-empty" className="text-body text-ink-sub">
            No reels mirrored yet. New reels from @{mirror.sourceUsername} will appear
            here after the next hourly check.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {posts.map((post) => (
              <li
                key={post.id}
                data-testid={`tiktok-history-item-${post.id}`}
                className="flex items-start gap-3 rounded-md border border-line bg-panel p-3"
              >
                {post.cover_url ? (
                  <Image
                    src={post.cover_url}
                    alt=""
                    width={72}
                    height={96}
                    className="h-24 w-auto shrink-0 rounded-sm object-cover"
                    unoptimized
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-body text-ink">
                    {post.caption || 'No caption'}
                  </p>
                  <p className="mt-1 text-metadata text-ink-dim">
                    {formatDateTime(post.created_at)} · {postStatusLabel(post.status)}
                    {post.published_post_id ? ' · Posted to Facebook' : ''}
                  </p>
                  {post.error ? (
                    <p className="mt-1 text-metadata text-signal-critical">{post.error}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
