'use client';

import * as React from 'react';
import Image from 'next/image';

import { Button } from '@/components/shared/ui/button';
import type {
  MirrorDashboardCounts,
  MirrorDetailResponse,
} from '@/lib/api/schemas/tiktok-mirrors';

/**
 * Mirror Dashboard tab — overview only. The header (target
 * identity, status, account, Added date, followers, source,
 * timing, error banner) lives in the shared MirrorDetailHeader
 * above the tabs and is never repeated here. No queue, no posting
 * times, no calendar: mirrors post on the hourly tick, not on a
 * schedule. The full post list lives in the History tab; this tab
 * shows all-time totals, a failed-attention strip, and the single
 * latest mirrored reel.
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

export interface TikTokDashboardTabProps {
  posts: MirrorDetailResponse['posts'];
  postCounts: MirrorDashboardCounts | null | undefined;
  postCountsError: boolean;
  onViewFailed: () => void;
}

export function TikTokDashboardTab({
  posts,
  postCounts,
  postCountsError,
  onViewFailed,
}: Readonly<TikTokDashboardTabProps>) {
  // Counts failure renders dashes, never fake zeros (Pages R6
  // rule, same as the list card). A null postCounts with no error
  // flag cannot happen from the detail route; treat it as unknown.
  const unknown = postCounts == null;
  const failed = postCounts?.failed ?? 0;
  const latestPosted = posts.find((post) => post.status === 'posted') ?? null;

  return (
    <div data-testid="tiktok-dashboard-tab" className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-line bg-panel p-4">
          <p className="text-metadata text-ink-dim">Posted</p>
          <p data-testid="tiktok-dashboard-posted" className="mt-1 text-body font-bold text-ink">
            {unknown ? '—' : postCounts.posted}
          </p>
        </div>
        <div className="rounded-md border border-line bg-panel p-4">
          <p className="text-metadata text-ink-dim">Failed</p>
          <p data-testid="tiktok-dashboard-failed" className="mt-1 text-body font-bold text-signal-critical">
            {unknown ? '—' : postCounts.failed}
          </p>
        </div>
        <div className="rounded-md border border-line bg-panel p-4">
          <p className="text-metadata text-ink-dim">Skipped</p>
          <p data-testid="tiktok-dashboard-skipped" className="mt-1 text-body font-bold text-ink">
            {unknown ? '—' : postCounts.skipped}
          </p>
        </div>
      </div>
      {postCountsError ? (
        <p data-testid="tiktok-dashboard-counts-error" className="text-metadata text-ink-dim">
          Totals could not be loaded. The mirror itself is unaffected.
        </p>
      ) : null}

      {postCounts != null && failed > 0 ? (
        <div
          data-testid="tiktok-dashboard-failed-strip"
          className="flex flex-wrap items-center gap-3 rounded-md border border-signal-critical bg-panel p-3"
        >
          <p className="text-body text-ink">
            {failed} {failed === 1 ? 'reel failed' : 'reels failed'} to post.
          </p>
          <Button type="button" size="sm" onClick={onViewFailed}>
            View failed reels
          </Button>
        </div>
      ) : null}

      {latestPosted ? (
        <div>
          <h2 className="mb-3 text-body font-bold text-ink">Latest mirrored</h2>
          <div className="flex items-start gap-3 rounded-md border border-line bg-panel p-3">
            {latestPosted.cover_url ? (
              <Image
                src={latestPosted.cover_url}
                alt=""
                width={72}
                height={96}
                className="h-24 w-auto shrink-0 rounded-sm object-cover"
                unoptimized
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-body text-ink">
                {latestPosted.caption || 'No caption'}
              </p>
              <p className="mt-1 text-metadata text-ink-dim">
                {formatDateTime(latestPosted.created_at)} · Posted
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <p className="text-metadata text-ink-dim">
        Totals cover every reel this mirror has handled. The full list, with every
        reel&apos;s status and Retry, lives in History.
      </p>
    </div>
  );
}
