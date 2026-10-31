'use client';

/**
 * Threads In-app Schedule detail page (client shell).
 *
 * Tabs: Dashboard, Queue, Posting Times, Calendar View, Insights,
 * Settings — the same shape as a Facebook Page detail, for one
 * Threads account added to Schedule. Insights are derived from this
 * account's own queue rows only: no live Threads follower or reach
 * numbers are shown, because the connect scopes do not provide them
 * and none are invented here. Queue actions reuse the generic queue
 * item routes for edit/delete and the Threads-specific routes for
 * publish-now / retry; paused, expired and disconnected accounts
 * show a plain reason and their queue actions stay disabled.
 */
import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import {
  ListThreadsScheduleQueueResponseSchema,
  ListThreadsScheduleSlotsResponseSchema,
  ThreadsScheduleDetailResponseSchema,
  ThreadsScheduleInsightsResponseSchema,
  UpdateThreadsScheduleResponseSchema,
  THREADS_SCHEDULE_FORMATS,
  type ThreadsScheduleDetail,
  type ThreadsScheduleFormat,
  type ThreadsScheduleQueueItem,
  type ThreadsScheduleSlot,
} from '@fbuploadpro/contracts';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { queryKeys } from '@/lib/data';
import { getUserInitials } from '@/lib/user-initials';
import { searchAndGroupTimezones } from '@/lib/timezones';
import { Button } from '@/components/shared/ui/button';
import { Banner } from '@/components/shared/ui/banner';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Input } from '@/components/shared/ui/input';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { StatusMark, type StatusMarkKind } from '@/components/shared/ui/status-mark';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { Textarea } from '@/components/shared/ui/textarea';
import { Toast, toast } from '@/components/shared/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';

import { ThreadsCreatePostDialog } from './create-post-dialog';

const TAB_IDS = [
  'dashboard',
  'queue',
  'posting-times',
  'calendar-view',
  'insights',
  'settings',
] as const;
type TabId = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<TabId, string> = {
  dashboard: 'Dashboard',
  queue: 'Queue',
  'posting-times': 'Posting Times',
  'calendar-view': 'Calendar View',
  insights: 'Insights',
  settings: 'Settings',
};

const STATUS_META: Record<string, { kind: StatusMarkKind; label: string }> = {
  active: { kind: 'operational', label: 'Active' },
  paused: { kind: 'idle', label: 'Paused' },
  expired: { kind: 'critical', label: 'Connection expired' },
  disconnected: { kind: 'critical', label: 'Disconnected' },
  rate_limited: { kind: 'queued', label: 'Rate limited' },
  error: { kind: 'critical', label: 'Needs attention' },
};

const QUEUE_FILTERS = ['all', 'queued', 'publishing', 'published', 'failed', 'cancelled'] as const;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function disabledReasonFor(item: ThreadsScheduleDetail): string | null {
  if (item.status === 'paused') return 'This account is paused. Resume it in Settings to post again.';
  if (item.status === 'expired')
    return 'This account’s connection has expired. Reconnect it in Threads Accounts first.';
  if (item.status === 'disconnected' || item.status === 'error')
    return 'This account is disconnected. Reconnect it in Threads Accounts first.';
  if (item.status === 'rate_limited')
    return 'Threads is rate-limiting this account right now. Try again later.';
  return null;
}

function formatDateTime(value: Date | string | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatDate(value: Date | string | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

export function ThreadsScheduleDetailShell({
  subdomain,
  scheduleId,
}: Readonly<{ subdomain: string; scheduleId: string }>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);

  const tabParam = searchParams.get('tab');
  const activeTab: TabId = (TAB_IDS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as TabId)
    : 'dashboard';
  const setTab = React.useCallback(
    (tab: TabId) => {
      router.replace(`/tenant/${subdomain}/threads/schedule/${scheduleId}?tab=${tab}`, {
        scroll: false,
      });
    },
    [router, subdomain, scheduleId]
  );

  const [createOpen, setCreateOpen] = React.useState(false);
  const [queueFilter, setQueueFilter] = React.useState<string>('all');
  const [queuePage, setQueuePage] = React.useState(1);
  const [editItem, setEditItem] = React.useState<ThreadsScheduleQueueItem | null>(null);
  const [editCaption, setEditCaption] = React.useState('');
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [newSlotTime, setNewSlotTime] = React.useState('09:00');
  const [newSlotFormats, setNewSlotFormats] = React.useState<ThreadsScheduleFormat[]>([
    ...THREADS_SCHEDULE_FORMATS,
  ]);
  const [timezoneSearch, setTimezoneSearch] = React.useState('');
  const [settingsTimezone, setSettingsTimezone] = React.useState<string | null>(null);

  const basePath = buildTenantApiPath(subdomain, `/threads/schedule/${scheduleId}`);
  const detailQuery = useQuery({
    queryKey: tenant.threadsSchedule.detail(scheduleId),
    queryFn: ({ signal }) =>
      api.get(basePath, { schema: ThreadsScheduleDetailResponseSchema, signal }),
  });
  const queueQuery = useQuery({
    queryKey: [...tenant.threadsSchedule.queue(scheduleId), queueFilter, queuePage],
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(`${basePath}/queue`, {
          page: queuePage,
          limit: DEFAULT_PAGE_SIZE,
          ...(queueFilter !== 'all' ? { status: queueFilter } : {}),
        }),
        { schema: ListThreadsScheduleQueueResponseSchema, signal }
      ),
    placeholderData: keepPreviousData,
  });
  const slotsQuery = useQuery({
    queryKey: tenant.threadsSchedule.slots(scheduleId),
    queryFn: ({ signal }) =>
      api.get(`${basePath}/slots`, {
        schema: ListThreadsScheduleSlotsResponseSchema,
        signal,
      }),
  });
  const insightsQuery = useQuery({
    queryKey: tenant.threadsSchedule.insights(scheduleId),
    queryFn: ({ signal }) =>
      api.get(`${basePath}/insights`, {
        schema: ThreadsScheduleInsightsResponseSchema,
        signal,
      }),
  });

  const item = detailQuery.data?.item ?? null;
  const disabledReason = item ? disabledReasonFor(item) : null;
  const isPaused = item?.status === 'paused';

  React.useEffect(() => {
    if (item && settingsTimezone === null) setSettingsTimezone(item.timezone);
  }, [item, settingsTimezone]);

  const invalidateAll = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: tenant.threadsSchedule.detail(scheduleId) });
    await queryClient.invalidateQueries({ queryKey: tenant.threadsSchedule.queue(scheduleId) });
    await queryClient.invalidateQueries({ queryKey: tenant.threadsSchedule.slots(scheduleId) });
    await queryClient.invalidateQueries({ queryKey: tenant.threadsSchedule.insights(scheduleId) });
    await queryClient.invalidateQueries({ queryKey: tenant.threadsSchedule.list });
  }, [queryClient, tenant, scheduleId]);

  const queueActionMutation = useMutation({
    mutationFn: async ({ itemId, action }: { itemId: string; action: 'publish-now' | 'retry' | 'delete' }) => {
      if (action === 'delete') {
        await api.delete(buildTenantApiPath(subdomain, `/publishing/queue/${itemId}`));
        return;
      }
      await api.post(`${basePath}/queue/${itemId}/${action}`, {});
    },
    onSuccess: async () => {
      await invalidateAll();
      toast.success('Queue updated.');
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'Could not update that post. Try again.'));
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ itemId, caption }: { itemId: string; caption: string }) => {
      await api.patch(buildTenantApiPath(subdomain, `/publishing/queue/${itemId}`), { caption });
    },
    onSuccess: async () => {
      setEditItem(null);
      await invalidateAll();
      toast.success('Caption updated.');
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'Could not update the caption. Try again.'));
    },
  });

  const slotAddMutation = useMutation({
    mutationFn: async () => {
      if (newSlotFormats.length === 0) throw new Error('Each posting time needs at least one post type.');
      return api.post(
        `${basePath}/slots`,
        { time: newSlotTime, formats: newSlotFormats },
        { schema: ListThreadsScheduleSlotsResponseSchema }
      );
    },
    onSuccess: async () => {
      await invalidateAll();
      toast.success('Posting time added.');
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'Could not add this posting time. Try again.'));
    },
  });

  const slotDeleteMutation = useMutation({
    mutationFn: async (slotId: string) => {
      await api.delete(`${basePath}/slots/${slotId}`);
    },
    onSuccess: async () => {
      await invalidateAll();
      toast.success('Posting time removed.');
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'Could not remove this posting time. Try again.'));
    },
  });

  const settingsMutation = useMutation({
    mutationFn: async (body: { timezone?: string; status?: 'active' | 'paused' }) => {
      return api.patch(basePath, body, { schema: UpdateThreadsScheduleResponseSchema });
    },
    onSuccess: async () => {
      await invalidateAll();
      toast.success('Settings saved.');
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'Could not save settings. Try again.'));
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      await api.delete(basePath);
    },
    onSuccess: async () => {
      setConfirmRemove(false);
      toast.success('Account removed from In-app Schedule.');
      router.push(`/tenant/${subdomain}/threads/schedule`);
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'Could not remove this account. Try again.'));
    },
  });

  if (detailQuery.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading scheduled account">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-45 w-full rounded-md" />
      </div>
    );
  }

  if (detailQuery.isError || !item) {
    return (
      <div className="flex flex-col gap-6">
        <Toast />
        <Banner variant="critical" title="Could not load this scheduled account">
          This account may have been removed from In-app Schedule, or its
          connection may have changed. Go back to the list and try again.
        </Banner>
        <Button type="button" variant="outline" asChild>
          <Link href={`/tenant/${subdomain}/threads/schedule`}>Back to In-app Schedule</Link>
        </Button>
      </div>
    );
  }

  const meta = STATUS_META[item.status] ?? STATUS_META['error']!;
  const slots: ThreadsScheduleSlot[] = slotsQuery.data?.slots ?? item.slots ?? [];
  const queueItems: ThreadsScheduleQueueItem[] = queueQuery.data?.items ?? [];
  const queueCounts = queueQuery.data?.counts;
  const timezoneGroups = searchAndGroupTimezones(timezoneSearch);

  const calendarGroups = new Map<string, ThreadsScheduleQueueItem[]>();
  for (const queueItem of queueItems) {
    const key = formatDate(queueItem.scheduledTime);
    const group = calendarGroups.get(key) ?? [];
    group.push(queueItem);
    calendarGroups.set(key, group);
  }

  const renderQueueRow = (queueItem: ThreadsScheduleQueueItem) => (
    <div
      key={queueItem.id}
      data-testid={`threads-schedule-queue-row-${queueItem.id}`}
      className="flex flex-col gap-2 border-b border-line py-4 last:border-b-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body font-bold text-ink">{queueItem.kind} post</span>
        <span className="text-metadata text-ink-dim">
          {queueItem.status} · {formatDateTime(queueItem.scheduledTime)}
        </span>
      </div>
      {queueItem.caption ? (
        <p className="text-body text-ink">{queueItem.caption}</p>
      ) : (
        <p className="text-body text-ink-dim">No caption</p>
      )}
      {queueItem.mediaName ? (
        <p className="text-metadata text-ink-dim">{queueItem.mediaName}</p>
      ) : null}
      {queueItem.errorMessage ? (
        <p className="text-body">{queueItem.errorMessage}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {queueItem.status === 'queued' ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabledReason !== null || queueActionMutation.isPending}
            onClick={() =>
              queueActionMutation.mutate({ itemId: queueItem.id, action: 'publish-now' })
            }
          >
            Publish now
          </Button>
        ) : null}
        {queueItem.status === 'failed' ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabledReason !== null || queueActionMutation.isPending}
            onClick={() => queueActionMutation.mutate({ itemId: queueItem.id, action: 'retry' })}
          >
            Retry
          </Button>
        ) : null}
        {queueItem.status === 'queued' || queueItem.status === 'failed' ? (
          <Button
            type="button"
            variant="outline"
            disabled={queueActionMutation.isPending}
            onClick={() => {
              setEditItem(queueItem);
              setEditCaption(queueItem.caption);
            }}
          >
            Edit caption
          </Button>
        ) : null}
        {queueItem.status !== 'published' && queueItem.status !== 'publishing' ? (
          confirmDeleteId === queueItem.id ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={queueActionMutation.isPending}
                onClick={() => {
                  setConfirmDeleteId(null);
                  queueActionMutation.mutate({ itemId: queueItem.id, action: 'delete' });
                }}
              >
                Confirm delete
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmDeleteId(null)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirmDeleteId(queueItem.id)}>
              Delete
            </Button>
          )
        ) : null}
      </div>
      {disabledReason && (queueItem.status === 'queued' || queueItem.status === 'failed') ? (
        <p className="text-metadata text-ink-dim">{disabledReason}</p>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Toast />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-line bg-subtle text-body font-bold">
            {item.profilePictureUrl ? (
              <Image
                src={item.profilePictureUrl}
                alt={item.name}
                width={44}
                height={44}
                className="size-11 object-cover"
              />
            ) : (
              <span>{getUserInitials(item.name)}</span>
            )}
          </div>
          <div>
            <h1 className="text-title font-bold text-ink">{item.name}</h1>
            <p className="text-body text-ink-dim">
              {item.handle ? `@${item.handle} · ` : ''}Timezone {item.timezone}
            </p>
            <StatusMark kind={meta.kind} label={meta.label} testId="threads-schedule-detail-status" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href={`/tenant/${subdomain}/threads/schedule`}>Back to list</Link>
          </Button>
          <Button
            type="button"
            disabled={disabledReason !== null}
            onClick={() => setCreateOpen(true)}
          >
            Create Post
          </Button>
        </div>
      </div>
      {disabledReason ? (
        <Banner variant="critical" title="Posting is paused for this account">
          {disabledReason}
        </Banner>
      ) : null}

      <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabId)}>
        <TabsList>
          {TAB_IDS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {TAB_LABELS[tab]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="dashboard">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-md border border-line bg-panel p-4">
              <p className="text-metadata text-ink-dim">Queued</p>
              <p className="text-title font-bold text-ink">
                {item.queueCountsError ? '—' : item.queueCounts.queued}
              </p>
            </div>
            <div className="rounded-md border border-line bg-panel p-4">
              <p className="text-metadata text-ink-dim">Posted</p>
              <p className="text-title font-bold text-ink">
                {item.queueCountsError ? '—' : item.queueCounts.posted}
              </p>
            </div>
            <div className="rounded-md border border-line bg-panel p-4">
              <p className="text-metadata text-ink-dim">Failed</p>
              <p className="text-title font-bold text-ink">
                {item.queueCountsError ? '—' : item.queueCounts.failed}
              </p>
            </div>
          </div>
          <h2 className="mt-6 mb-2 text-body font-bold text-ink">Recent posts</h2>
          {queueItems.length === 0 ? (
            <p className="text-body text-ink-dim">Nothing in the queue yet.</p>
          ) : (
            <div className="flex flex-col">{queueItems.slice(0, 5).map(renderQueueRow)}</div>
          )}
          <h2 className="mt-6 mb-2 text-body font-bold text-ink">Posting times</h2>
          {slots.length === 0 ? (
            <p className="text-body text-ink-dim">No posting times set yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {slots.map((slot) => (
                <li key={slot.id} className="text-body text-ink">
                  {slot.slotTime} — {slot.allowedFormats.join(', ')}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="queue">
          <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter queue by status">
            {QUEUE_FILTERS.map((filter) => (
              <Button
                key={filter}
                type="button"
                variant={queueFilter === filter ? 'default' : 'outline'}
                onClick={() => {
                  setQueueFilter(filter);
                  setQueuePage(1);
                }}
              >
                {filter}
                {queueCounts && filter !== 'all'
                  ? ` (${queueCounts[filter as keyof typeof queueCounts] ?? 0})`
                  : ''}
              </Button>
            ))}
          </div>
          {queueQuery.isPending ? (
            <Skeleton className="h-45 w-full rounded-md" />
          ) : queueQuery.isError ? (
            <Banner variant="critical" title="Could not load the queue">
              Try again, and if it keeps happening, reconnect the account in Threads Accounts.
            </Banner>
          ) : queueItems.length === 0 ? (
            <EmptyState
              type="first-use"
              title="No posts in this queue yet"
              description="Create a post to add it to this account’s queue."
              action={
                <Button type="button" disabled={disabledReason !== null} onClick={() => setCreateOpen(true)}>
                  Create Post
                </Button>
              }
            />
          ) : (
            <>
              <div className="flex flex-col">{queueItems.map(renderQueueRow)}</div>
              {(queueQuery.data?.totalPages ?? 0) > 1 ? (
                <ListPagination
                  page={queuePage}
                  total={queueQuery.data?.total ?? 0}
                  limit={DEFAULT_PAGE_SIZE}
                  totalPages={queueQuery.data?.totalPages ?? 0}
                  onPageChange={setQueuePage}
                />
              ) : null}
            </>
          )}
        </TabsContent>

        <TabsContent value="posting-times">
          <p className="mb-4 text-body text-ink-dim">
            Posting times in {item.timezone}. A queued post uses the next vacant
            time that allows its post type.
          </p>
          {slotsQuery.isError ? (
            <Banner variant="critical" title="Could not load posting times">
              Try again.
            </Banner>
          ) : slots.length === 0 ? (
            <p className="text-body text-ink-dim">No posting times set yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {slots.map((slot) => (
                <li
                  key={slot.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel p-4"
                >
                  <span className="text-body text-ink">
                    {slot.slotTime} — {slot.allowedFormats.join(', ')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={slotDeleteMutation.isPending}
                    onClick={() => slotDeleteMutation.mutate(slot.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-6 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-body text-ink-dim">
              Time
              <Input
                type="time"
                aria-label="New posting time"
                value={newSlotTime}
                onChange={(event) => setNewSlotTime(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Post types for new posting time">
              {THREADS_SCHEDULE_FORMATS.map((format) => (
                <label key={format} className="flex items-center gap-1 text-body text-ink">
                  <input
                    type="checkbox"
                    checked={newSlotFormats.includes(format)}
                    onChange={(event) => {
                      setNewSlotFormats((prev) =>
                        event.target.checked
                          ? [...prev, format]
                          : prev.filter((f) => f !== format)
                      );
                    }}
                  />
                  {format}
                </label>
              ))}
            </div>
            <Button
              type="button"
              disabled={slotAddMutation.isPending || newSlotFormats.length === 0}
              onClick={() => slotAddMutation.mutate()}
            >
              Add posting time
            </Button>
          </div>
          <div className="mt-6">
            <label className="mb-1 block text-body text-ink-dim" htmlFor="threads-settings-timezone-search">
              Change timezone
            </label>
            <Input
              id="threads-settings-timezone-search"
              type="search"
              aria-label="Search timezones"
              placeholder="Search timezones"
              value={timezoneSearch}
              onChange={(event) => setTimezoneSearch(event.target.value)}
              className="max-w-80"
            />
            <div className="mt-2 flex max-h-60 flex-col gap-1 overflow-y-auto">
              {(Object.keys(timezoneGroups) as Array<keyof typeof timezoneGroups>).map((region) => (
                <div key={region}>
                  <p className="text-metadata font-bold text-ink-dim">{region}</p>
                  {timezoneGroups[region].map((entry) => (
                    <button
                      key={entry.iana}
                      type="button"
                      className="block w-full text-left text-body text-ink hover:underline"
                      onClick={() => {
                        setSettingsTimezone(entry.iana);
                        settingsMutation.mutate({ timezone: entry.iana });
                      }}
                    >
                      {entry.iana}
                      {entry.iana === item.timezone ? ' (current)' : ''}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="calendar-view">
          {calendarGroups.size === 0 ? (
            <p className="text-body text-ink-dim">No scheduled posts to show on the calendar.</p>
          ) : (
            <div className="flex flex-col gap-6">
              {[...calendarGroups.entries()].map(([date, group]) => (
                <div key={date}>
                  <h2 className="mb-2 text-body font-bold text-ink">{date}</h2>
                  <div className="flex flex-col">{group.map(renderQueueRow)}</div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-metadata text-ink-dim">
            The calendar shows the posts loaded on this page, grouped by scheduled date.
          </p>
        </TabsContent>

        <TabsContent value="insights">
          {insightsQuery.isPending ? (
            <Skeleton className="h-45 w-full rounded-md" />
          ) : insightsQuery.isError || !insightsQuery.data ? (
            <Banner variant="critical" title="Could not load insights">
              Try again.
            </Banner>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-md border border-line bg-panel p-4">
                  <p className="text-metadata text-ink-dim">Posted</p>
                  <p className="text-title font-bold text-ink">{insightsQuery.data.totals.posted}</p>
                </div>
                <div className="rounded-md border border-line bg-panel p-4">
                  <p className="text-metadata text-ink-dim">Failed</p>
                  <p className="text-title font-bold text-ink">{insightsQuery.data.totals.failed}</p>
                </div>
                <div className="rounded-md border border-line bg-panel p-4">
                  <p className="text-metadata text-ink-dim">Queued</p>
                  <p className="text-title font-bold text-ink">{insightsQuery.data.totals.queued}</p>
                </div>
              </div>
              <p className="text-body text-ink-dim">
                These numbers come from this account’s own posting history only.
                No follower or reach numbers are shown here.
              </p>
              <ul className="flex flex-col gap-2">
                {insightsQuery.data.byKind.map((row) => (
                  <li
                    key={row.kind}
                    className="flex justify-between gap-2 rounded-md border border-line bg-panel p-4 text-body text-ink"
                  >
                    <span>{row.kind}</span>
                    <span>
                      {row.posted} posted · {row.failed} failed
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-body font-bold text-ink">
                Publish attempts over the last 14 days
              </p>
              <ul className="flex flex-col gap-2">
                {insightsQuery.data.byDay.map((row) => (
                  <li
                    key={row.date}
                    className="flex justify-between gap-2 rounded-md border border-line bg-panel p-4 text-body text-ink"
                  >
                    <span>{row.date}</span>
                    <span>
                      {row.posted} posted · {row.failed} failed
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="settings">
          <div className="flex flex-col gap-4">
            <p className="text-body text-ink">
              Timezone: {settingsTimezone ?? item.timezone}
            </p>
            <div className="flex flex-wrap gap-2">
              {isPaused ? (
                <Button
                  type="button"
                  disabled={settingsMutation.isPending}
                  onClick={() => settingsMutation.mutate({ status: 'active' })}
                >
                  Resume posting
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={settingsMutation.isPending}
                  onClick={() => settingsMutation.mutate({ status: 'paused' })}
                >
                  Pause posting
                </Button>
              )}
              <Button type="button" variant="outline" asChild>
                <Link href={`/tenant/${subdomain}/threads/accounts`}>Reconnect in Threads Accounts</Link>
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmRemove(true)}>
                Remove from Schedule
              </Button>
            </div>
            <p className="text-body text-ink-dim">
              Removing this account from Schedule keeps the Threads account
              itself and its posting history. Queued posts are cancelled so
              nothing publishes after removal.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      <ThreadsCreatePostDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        subdomain={subdomain}
        scheduleId={scheduleId}
        accountName={item.name}
        disabledReason={disabledReason}
      />

      {editItem ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setEditItem(null);
          }}
        >
          <DialogContent data-testid="threads-queue-edit-dialog" className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Edit caption</DialogTitle>
              <DialogDescription>Only the caption changes.</DialogDescription>
            </DialogHeader>
            <Textarea
              data-testid="threads-queue-edit-caption"
              aria-label="Caption"
              value={editCaption}
              onChange={(event) => setEditCaption(event.target.value)}
              rows={6}
              disabled={editMutation.isPending}
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={editMutation.isPending} onClick={() => setEditItem(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="threads-queue-edit-save-btn"
                disabled={editMutation.isPending}
                onClick={() =>
                  editMutation.mutate({ itemId: editItem.id, caption: editCaption })
                }
              >
                {editMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {confirmRemove ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmRemove(false);
          }}
        >
          <DialogContent data-testid="threads-schedule-remove-dialog" className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Remove from Schedule?</DialogTitle>
              <DialogDescription>
                {item.name} will no longer appear in In-app Schedule and its
                queued posts will be cancelled. The Threads account itself
                stays connected in Threads Accounts.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={removeMutation.isPending} onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
              <Button
                type="button"
                data-testid="threads-schedule-remove-confirm"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate()}
              >
                {removeMutation.isPending ? 'Removing…' : 'Remove from Schedule'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
