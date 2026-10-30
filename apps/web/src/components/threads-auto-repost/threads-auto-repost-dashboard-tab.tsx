'use client';

import * as React from 'react';
import Image from 'next/image';

import { Card } from '@/components/shared/ui/card';
import { StatusMark } from '@/components/shared/ui/status-mark';
import type {
  MirrorDetailResponse,
  MirrorView,
} from '@/lib/api/schemas/threads-auto-repost';
import { threadsMirrorStatusMark } from './threads-auto-repost-card';

/**
 * Threads mirror Dashboard tab — the Facebook mirror dashboard
 * pattern for Threads: account identity, linked Threads account,
 * status, last mirrored reel, next check, and mirror history. No
 * queue, no posting times, no calendar (mirrors post on the hourly
 * tick, not on a schedule) and no Insights tab (there is no Threads
 * destination insights panel to reuse, unlike Facebook pages).
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

export interface ThreadsAutoRepostDashboardTabProps {
  mirror: MirrorView;
  posts: MirrorDetailResponse['posts'];
}

export function ThreadsAutoRepostDashboardTab({ mirror, posts }: Readonly<ThreadsAutoRepostDashboardTabProps>) {
  const mark = threadsMirrorStatusMark(mirror.status);
  const last = mirror.lastMirroredPost;
  return (
    <div data-testid="threads-dashboard-tab" className="flex flex-col gap-6">
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
              Mirroring to <strong className="text-ink">{mirror.targetDisplayName}</strong> on Threads
            </p>
          </div>
          <StatusMark kind={mark.kind} label={mark.label} testId="threads-detail-status" />
        </div>
        {mirror.lastError ? (
          <p role="alert" data-testid="threads-detail-error" className="mt-3 text-body text-signal-critical">
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
          <p className="text-body text-ink-sub">No reels mirrored yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {posts.map((post) => (
              <Card key={post.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-bold text-ink">
                      {post.caption || 'Untitled reel'}
                    </p>
                    <p className="text-metadata text-ink-sub">
                      {formatDateTime(post.created_at)}
                      {post.error ? ` · ${post.error}` : ''}
                    </p>
                  </div>
                  <span className="text-metadata font-bold text-ink">
                    {postStatusLabel(post.status)}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
