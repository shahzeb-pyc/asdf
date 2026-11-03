'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';

import { api, buildTenantApiPath } from '@/lib/api';
import { RetryMirrorPostResponseSchema } from '@/lib/api/schemas/tiktok-mirrors';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { toast } from '@/components/shared/ui/toast';
import type {
  MirrorDetailResponse,
  MirrorView,
} from '@/lib/api/schemas/tiktok-mirrors';
import { mapStoredMirrorErrorToDisplay } from '@fbuploadpro/contracts';

/**
 * Mirror Dashboard tab — mirror history only. The header (target
 * identity, status, account, Added date, followers, source,
 * timing, error banner) lives in the shared MirrorDetailHeader
 * above the tabs: this tab used to repeat that identity card, and
 * the duplication is deleted, not kept behind a flag. No queue, no
 * posting times, no calendar: mirrors post on the hourly tick, not
 * on a schedule. No all-time totals here either — those belong in
 * this tab in a later job, not in this header rebuild.
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
  subdomain: string;
  mirrorId: string;
}

export function TikTokDashboardTab({
  mirror,
  posts,
  subdomain,
  mirrorId,
}: Readonly<TikTokDashboardTabProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);

  // Manual retry for one failed post (pre-existing `pending`
  // rows are also retryable — see the retry route). Failed posts
  // are never auto-retried; this mutation is the only retry path.
  // The tab is shared by the Facebook detail view and the Instagram
  // Auto Repost detail view, so both query-key families are
  // invalidated (the miss is a no-op). A failed publish returns a
  // 200 outcome with the row still failed, so the specific message
  // toasts here instead of a generic failure.
  const retryMutation = useMutation({
    mutationFn: (postId: string) =>
      api.post(
        buildTenantApiPath(
          subdomain,
          `/tiktok-mirrors/${mirrorId}/posts/${postId}/retry`
        ),
        {},
        { schema: RetryMirrorPostResponseSchema }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: tenant.tiktokMirrors.detail(mirrorId),
      });
      void queryClient.invalidateQueries({ queryKey: tenant.tiktokMirrors.list });
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramAutoRepost.detail(mirrorId),
      });
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramAutoRepost.list,
      });
      if (data.post.status === 'posted') {
        toast.success('Reel posted');
      } else {
        toast.error(data.post.error ?? 'Could not post this reel. Please try again.');
      }
    },
    onError: () => {
      toast.error('Could not retry this post. Please try again.');
    },
  });
  return (
    <div data-testid="tiktok-dashboard-tab" className="flex flex-col gap-6">
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
                    {post.published_post_id ? ' · Posted' : ''}
                  </p>
                  {post.error ? (
                    <p className="mt-1 text-metadata text-signal-critical">{mapStoredMirrorErrorToDisplay(post.error)}</p>
                  ) : null}
                  {(post.status === 'failed' || post.status === 'pending') &&
                  (mirror.targetPlatform === 'facebook' ||
                    mirror.targetPlatform === 'instagram') ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      data-testid={`tiktok-retry-btn-${post.id}`}
                      disabled={
                        retryMutation.isPending && retryMutation.variables === post.id
                      }
                      onClick={() => retryMutation.mutate(post.id)}
                    >
                      {retryMutation.isPending && retryMutation.variables === post.id
                        ? 'Retrying…'
                        : 'Retry'}
                    </Button>
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
