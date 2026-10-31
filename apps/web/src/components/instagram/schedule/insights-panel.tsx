'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import {
  ListInstagramScheduleQueueResponseSchema,
  type InstagramScheduleItem,
} from '@/lib/api/schemas/instagram-schedule';
import { queryKeys } from '@/lib/data/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shared/ui/card';

/**
 * Instagram Schedule Insights tab — honest limit, stated in the UI:
 * Instagram account insights (followers, reach, impressions) have
 * no read path in the web app or the worker, so this tab shows only
 * real queue outcomes: posted posts with their Instagram post IDs,
 * and the posted/failed counts. No metric is invented or zero-filled
 * as if it were measured.
 */

export function InsightsPanel({
  subdomain,
  item,
}: Readonly<{ subdomain: string; item: InstagramScheduleItem }>) {
  const tenant = queryKeys.tenant(subdomain);
  const publishedQuery = useQuery({
    queryKey: tenant.instagramSchedule.queue(item.id, {
      page: '1',
      status: 'published',
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(
          buildTenantApiPath(subdomain, `/instagram/schedule/${item.id}/queue`),
          { page: 1, limit: 50, status: 'published' }
        ),
        { schema: ListInstagramScheduleQueueResponseSchema, signal }
      ),
  });
  const published = publishedQuery.data?.items ?? [];

  return (
    <div
      data-testid="instagram-schedule-insights-panel"
      className="flex flex-col gap-6"
    >
      <p className="m-0 text-body text-ink-sub">
        Instagram insights are not connected yet, so follower and reach
        numbers are not shown here. What follows is the real posting
        record for this account.
      </p>
      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Posted</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="m-0 text-xxl font-bold">{item.counts.posted}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Failed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="m-0 text-xxl font-bold">{item.counts.failed}</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Posted posts</CardTitle>
        </CardHeader>
        <CardContent>
          {publishedQuery.isPending && (
            <p className="m-0 text-body text-ink-sub">Loading posted posts…</p>
          )}
          {!publishedQuery.isPending && published.length === 0 && (
            <p className="m-0 text-body text-ink-sub">
              Nothing has been posted from this schedule yet.
            </p>
          )}
          <div className="flex flex-col gap-3">
            {published.map((post) => (
              <div key={post.id}>
                <p className="m-0 line-clamp-2 text-body">
                  {post.caption || 'No caption'}
                </p>
                <p className="mt-1 mb-0 text-metadata text-ink-sub">
                  {post.publishedAt
                    ? new Date(post.publishedAt).toLocaleDateString()
                    : 'Posted'}
                  {post.fbPostId ? ` · Instagram post ${post.fbPostId}` : ''}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
