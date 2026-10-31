'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import {
  ListInstagramScheduleQueueResponseSchema,
  type InstagramScheduleItem,
} from '@/lib/api/schemas/instagram-schedule';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shared/ui/card';

/**
 * Instagram Schedule Dashboard tab — real data only: queue counts,
 * next scheduled post, posting-times summary, recent failed posts.
 * No follower or reach numbers: no Instagram insights read exists.
 */

function formatTime(scheduledTime: string | null, timezone: string): string {
  if (!scheduledTime) return 'Next posting time';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(scheduledTime));
  } catch {
    return new Date(scheduledTime).toLocaleString();
  }
}

export function DashboardPanel({
  subdomain,
  item,
  onCreatePost,
  onViewQueue,
}: Readonly<{
  subdomain: string;
  item: InstagramScheduleItem;
  onCreatePost: () => void;
  onViewQueue: () => void;
}>) {
  const tenant = queryKeys.tenant(subdomain);
  const queuePath = buildTenantApiPath(
    subdomain,
    `/instagram/schedule/${item.id}/queue`
  );
  const nextQuery = useQuery({
    queryKey: tenant.instagramSchedule.queue(item.id, {
      page: '1',
      status: 'queued',
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(queuePath, { page: 1, limit: 1, status: 'queued' }),
        { schema: ListInstagramScheduleQueueResponseSchema, signal }
      ),
  });
  const failedQuery = useQuery({
    queryKey: tenant.instagramSchedule.queue(item.id, {
      page: '1',
      status: 'failed',
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(queuePath, { page: 1, limit: 5, status: 'failed' }),
        { schema: ListInstagramScheduleQueueResponseSchema, signal }
      ),
  });
  const next = nextQuery.data?.items[0] ?? null;
  const failed = failedQuery.data?.items ?? [];

  return (
    <div
      data-testid="instagram-schedule-dashboard-panel"
      className="flex flex-col gap-6"
    >
      <div className="grid gap-6 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Queued</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="m-0 text-xxl font-bold">{item.counts.queued}</p>
          </CardContent>
        </Card>
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
          <CardTitle>Next post</CardTitle>
        </CardHeader>
        <CardContent>
          {next ? (
            <div>
              <p className="m-0 font-semibold">
                {formatTime(next.scheduledTime, item.timezone)}
              </p>
              <p className="mt-1 mb-0 line-clamp-2 text-body text-ink-sub">
                {next.caption || 'No caption'}
              </p>
            </div>
          ) : (
            <p className="m-0 text-body text-ink-sub">
              Nothing is queued yet. Create a post to fill this schedule.
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button type="button" onClick={onCreatePost}>
              Create post
            </Button>
            <Button type="button" variant="outline" onClick={onViewQueue}>
              View queue
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Posting times</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="m-0 text-body text-ink-sub">
            {item.slotCount} posting {item.slotCount === 1 ? 'time' : 'times'} ·{' '}
            {item.timezone}
          </p>
        </CardContent>
      </Card>

      {failed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent failed posts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {failed.map((failedItem) => (
                <p key={failedItem.id} className="m-0 truncate text-body">
                  {failedItem.caption || 'No caption'}
                </p>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={onViewQueue}
            >
              View all failed posts
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
