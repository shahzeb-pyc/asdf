'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import {
  MirrorDetailResponseSchema,
  RetryMirrorPostResponseSchema,
} from '@/lib/api/schemas/tiktok-mirrors';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { toast } from '@/components/shared/ui/toast';
import type {
  MirrorDetailResponse,
  MirrorView,
} from '@/lib/api/schemas/tiktok-mirrors';
import { mapStoredMirrorErrorToDisplay } from '@fbuploadpro/contracts';

/**
 * Mirror History tab — the post list that used to be the whole
 * Dashboard tab, now on its own tab. Filtering and pagination are
 * server-side (the detail route's ?status= and ?page=), so the
 * filter and Load more work past the first page, not just over
 * loaded rows. Retry behaviour is unchanged: manual retry for one
 * failed (or legacy pending) post, Facebook and Instagram only,
 * never automatic.
 *
 * Published-post link: deliberately NOT linked. The codebase has
 * no proven URL pattern for a published_post_id (Pages link to
 * the Page itself, never to a post id), and a guessed
 * facebook.com URL format must not ship — so posted rows keep the
 * plain "Posted" text until a proven pattern exists.
 */

export type HistoryStatusFilter = 'all' | 'posted' | 'failed' | 'skipped';

const FILTERS: Array<{ value: HistoryStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'posted', label: 'Posted' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
];

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

export interface TikTokHistoryTabProps {
  mirror: MirrorView;
  subdomain: string;
  mirrorId: string;
  status: HistoryStatusFilter;
  onStatusChange: (status: HistoryStatusFilter) => void;
}

export function TikTokHistoryTab({
  mirror,
  subdomain,
  mirrorId,
  status,
  onStatusChange,
}: Readonly<TikTokHistoryTabProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [posts, setPosts] = React.useState<MirrorDetailResponse['posts']>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);

  const fetchPage = React.useCallback(
    async (pageToLoad: number, append: boolean) => {
      if (append) setIsLoadingMore(true);
      else setIsLoading(true);
      setLoadError(false);
      try {
        const data = await api.get(
          buildUrl(buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`), {
            targetPlatform: mirror.targetPlatform,
            ...(status !== 'all' ? { status } : {}),
            page: pageToLoad,
          }),
          { schema: MirrorDetailResponseSchema }
        );
        setPosts((prev) => (append ? [...prev, ...data.posts] : data.posts));
        setHasMore(data.postsHasMore ?? false);
        setPage(pageToLoad);
      } catch {
        setLoadError(true);
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [mirror.targetPlatform, mirrorId, status, subdomain]
  );

  React.useEffect(() => {
    void fetchPage(1, false);
  }, [fetchPage]);

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
      void queryClient.invalidateQueries({ queryKey: tenant.instagramAutoRepost.list });
      // Refresh this tab from page 1 so the retried row's new
      // status shows without a manual reload.
      void fetchPage(1, false);
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
    <div data-testid="tiktok-history-tab" className="flex flex-col gap-6">
      <div>
        <h2 className="mb-3 text-body font-bold text-ink">Mirror history</h2>
        <div className="mb-4 flex flex-wrap gap-2" data-testid="tiktok-history-filters">
          {FILTERS.map((filter) => (
            <Button
              key={filter.value}
              type="button"
              variant={status === filter.value ? 'default' : 'outline'}
              size="sm"
              data-testid={`tiktok-history-filter-${filter.value}`}
              onClick={() => onStatusChange(filter.value)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
        {isLoading ? (
          <p data-testid="tiktok-history-loading" className="text-body text-ink-sub">
            Loading history…
          </p>
        ) : loadError && posts.length === 0 ? (
          <p data-testid="tiktok-history-error" className="text-body text-ink-sub">
            Couldn&apos;t load history.{' '}
            <Button type="button" variant="outline" size="sm" onClick={() => void fetchPage(1, false)}>
              Retry
            </Button>
          </p>
        ) : posts.length === 0 ? (
          <p data-testid="tiktok-history-empty" className="text-body text-ink-sub">
            {status === 'all'
              ? `No reels mirrored yet. New reels from @${mirror.sourceUsername} will appear here after the next hourly check.`
              : `No ${status} reels yet.`}
          </p>
        ) : (
          <>
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
            {hasMore ? (
              <div className="mt-4 text-center">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="tiktok-history-load-more"
                  disabled={isLoadingMore}
                  onClick={() => void fetchPage(page + 1, true)}
                >
                  {isLoadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
