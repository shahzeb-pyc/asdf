'use client';

/**
 * Calendar View section for a dedicated Page: the same queue, laid
 * out as a month calendar instead of a list. This is a SEPARATE
 * section after Queue (its own URL-synced tab), not a toggle inside
 * the Queue tab.
 *
 * - Placement: queued posts sit on their DERIVED ESTIMATE day (the
 *   same assignQueueEstimates computation the Queue panel uses over
 *   the full queued list); published posts on their published day;
 *   failed posts on their last-update day. Queued posts with no
 *   estimate (no posting time matches their format) have no day and
 *   are reported in a note below the grid, never silently dropped.
 * - Filters: the same All / Queued / Failed / Published chips as the
 *   Queue tab, with the API's per-status counts.
 * - Clicking a post opens the SAME caption-only edit dialogue the
 *   Queue list uses (imported, not duplicated). Published posts
 *   keep edit disabled, same as the list: their entries are not
 *   clickable. Full actions (publish-now, retry, delete, reorder)
 *   stay in the Queue list only — the calendar is a view + edit
 *   entry point, not a second action surface.
 * - Caps, honoured like the queue: the list API caps at 100 items,
 *   and estimates cover at most 100 queued posts. When either cap
 *   bites, a plain note says the month may be incomplete — a
 *   partial month is never shown as complete.
 */
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageIcon,
  TypeIcon,
  VideoIcon,
} from 'lucide-react';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { assignQueueEstimates } from '@fbuploadpro/contracts';
import {
  ListQueueItemsResponseSchema,
  QueueItemSchema,
  type QueueItem,
} from '@/lib/api/schemas/queue';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { toast } from '@/components/shared/ui/toast';
import type { PageSlotSummary } from '../tab-dashboard';
import { QueueEditDialog } from '../queue/queue-edit-dialog';
import {
  CALENDAR_WEEKDAYS,
  currentYearMonth,
  dayNumberOfKey,
  formatDayTime,
  formatDayTimeFromIso,
  formatMonthLabel,
  getItemDayKey,
  getItemSortInstant,
  getMonthGridKeys,
  nextMonth,
  prevMonth,
  todayKey,
} from './calendar-utils';

/** The list API caps limit at 100 — same cap discipline as the queue. */
const ITEMS_LIMIT = 100;

type CalendarFilter = 'all' | 'queued' | 'publishing' | 'failed' | 'published';

const FILTERS: Array<{ id: CalendarFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'queued', label: 'Queued' },
  { id: 'publishing', label: 'Publishing' },
  { id: 'failed', label: 'Failed' },
  { id: 'published', label: 'Published' },
];

function errorMessage(error: unknown, fallback: string): string {
  if (isApiError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function typeIcon(postFormat: string): React.ReactNode {
  if (postFormat === 'image') return <ImageIcon aria-hidden className="size-3 shrink-0" />;
  if (postFormat === 'video' || postFormat === 'reel')
    return <VideoIcon aria-hidden className="size-3 shrink-0" />;
  return <TypeIcon aria-hidden className="size-3 shrink-0" />;
}

type CalendarEntry = {
  item: QueueItem;
  dayKey: string;
  instant: Date | null;
  timeLabel: string | null;
};

export interface CalendarViewPanelProps {
  subdomain: string;
  pageId: string;
  pageTimezone: string;
  /** Active + paused posting times, from the shell's slots cache. */
  slots: PageSlotSummary[];
  /**
   * K11: same hidden-panel rule as the queue panel — a visited
   * panel stays mounted but must not refetch on window focus
   * while hidden. Defaults to true; the shell passes the tab state.
   */
  isActive?: boolean;
}

export function CalendarViewPanel({
  subdomain,
  pageId,
  pageTimezone,
  slots,
  isActive = true,
}: Readonly<CalendarViewPanelProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const queuePath = buildTenantApiPath(subdomain, '/publishing/queue');

  const [filter, setFilter] = React.useState<CalendarFilter>('all');
  const [month, setMonth] = React.useState(() => currentYearMonth(pageTimezone));
  const [itemToEdit, setItemToEdit] = React.useState<QueueItem | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);

  const itemsQuery = useQuery({
    queryKey: [...tenant.queue.items(pageId), 'calendar', { status: filter }] as const,
    queryFn: ({ signal }) =>
      api.get(queuePath, {
        schema: ListQueueItemsResponseSchema,
        query: {
          pageId,
          ...(filter !== 'all' ? { status: filter } : {}),
          limit: ITEMS_LIMIT,
          offset: 0,
        },
        signal,
      }),
    enabled: Boolean(subdomain && pageId),
    refetchOnWindowFocus: isActive,
  });

  // Full queued list in queue order, for estimates — same query the
  // Queue panel uses, so a queued post's estimate day here always
  // matches the estimate its list row shows.
  const estimatesQuery = useQuery({
    queryKey: [...tenant.queue.items(pageId), 'calendar', 'estimates'] as const,
    queryFn: ({ signal }) =>
      api.get(queuePath, {
        schema: ListQueueItemsResponseSchema,
        query: { pageId, status: 'queued', limit: ITEMS_LIMIT, offset: 0 },
        signal,
      }),
    enabled: Boolean(subdomain && pageId),
    refetchOnWindowFocus: isActive,
  });

  const items = itemsQuery.data?.items ?? [];
  const itemsTotal = itemsQuery.data?.total ?? 0;
  const queuedList = estimatesQuery.data?.items ?? [];
  const totalQueued = estimatesQuery.data?.total ?? 0;

  const counts = itemsQuery.data;
  const queuedCount = counts?.queuedCount ?? 0;
  const publishedCount = counts?.publishedCount ?? 0;
  const failedCount = counts?.failedCount ?? 0;
  const cancelledCount = counts?.cancelledCount ?? 0;
  const skippedCount = counts?.skippedCount ?? 0;
  const publishingCount = counts?.publishingCount ?? 0;
  // R11, identical to the queue panel: All is ALWAYS the sum of
  // every per-status count, including publishing, so its number
  // cannot vary with the active filter while a post is publishing.
  const allCount =
    queuedCount +
    publishedCount +
    failedCount +
    cancelledCount +
    skippedCount +
    publishingCount;
  const filterCounts: Record<CalendarFilter, number> = {
    all: allCount,
    queued: queuedCount,
    publishing: publishingCount,
    failed: failedCount,
    published: publishedCount,
  };

  const estimates = React.useMemo(() => {
    if (queuedList.length === 0) return new Map<string, Date | null>();
    return assignQueueEstimates({
      slots: slots.map((slot) => ({
        id: slot.id,
        timeOfDay: slot.slotTime,
        isActive: slot.isActive,
        allowedFormats: slot.allowedFormats ?? null,
      })),
      timezone: pageTimezone,
      posts: queuedList.map((item) => ({ id: item.id, format: item.postFormat })),
    });
  }, [queuedList, slots, pageTimezone]);

  const { entriesByDay, unscheduledCount } = React.useMemo(() => {
    const byDay = new Map<string, CalendarEntry[]>();
    let unscheduled = 0;
    for (const item of items) {
      const estimate = item.status === 'queued' ? (estimates.get(item.id) ?? null) : null;
      const dayKey = getItemDayKey(item, estimate, pageTimezone);
      if (dayKey === null) {
        unscheduled += 1;
        continue;
      }
      const instant = getItemSortInstant(item, estimate);
      let timeLabel: string | null = null;
      if (item.status === 'queued' && estimate) {
        timeLabel = formatDayTime(estimate, pageTimezone);
      } else if (item.status === 'published') {
        timeLabel = formatDayTimeFromIso(item.publishedAt ?? item.updatedAt, pageTimezone);
      } else {
        timeLabel = formatDayTimeFromIso(item.updatedAt, pageTimezone);
      }
      const entry: CalendarEntry = { item, dayKey, instant, timeLabel };
      const dayEntries = byDay.get(dayKey) ?? [];
      dayEntries.push(entry);
      byDay.set(dayKey, dayEntries);
    }
    for (const dayEntries of byDay.values()) {
      dayEntries.sort((a, b) => {
        if (a.instant === null && b.instant === null) return 0;
        if (a.instant === null) return 1;
        if (b.instant === null) return -1;
        return a.instant.getTime() - b.instant.getTime();
      });
    }
    return { entriesByDay: byDay, unscheduledCount: unscheduled };
  }, [items, estimates, pageTimezone]);

  // Capped when the active filter's set exceeds the 100-item fetch,
  // or when the queued set (which feeds estimates) does — either
  // way a month could look complete while posts are missing.
  const capped =
    itemsTotal > ITEMS_LIMIT ||
    ((filter === 'all' || filter === 'queued') && totalQueued > ITEMS_LIMIT);

  const invalidateQueue = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.queue.all });
    // K8: same pages-cache refresh as the queue panel — an edit
    // here must not leave list counters and unmatched flags stale.
    void queryClient.invalidateQueries({ queryKey: tenant.pages.list });
    void queryClient.invalidateQueries({ queryKey: tenant.pages.detail(pageId) });
  }, [queryClient, tenant.queue, tenant.pages, pageId]);

  const editMutation = useMutation({
    mutationFn: ({ itemId, caption }: { itemId: string; caption: string }) =>
      api.patch(buildTenantApiPath(subdomain, `/publishing/queue/${itemId}`), { caption }, {
        schema: QueueItemSchema,
      }),
    onSuccess: () => {
      invalidateQueue();
      toast.success('Caption updated.');
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Couldn't update the caption. Please try again."));
    },
  });

  // R24: the dialog closes only on success, like the
  // posting-time form — a failed save used to clear the draft in
  // `finally`, losing the caption the user had just typed.
  const handleSaveEdit = React.useCallback(
    async (caption: string) => {
      if (!itemToEdit) return;
      setIsSaving(true);
      try {
        await editMutation.mutateAsync({ itemId: itemToEdit.id, caption });
        setItemToEdit(null);
      } catch (error) {
        // The mutation's onError already surfaced the failure via
        // toast; log it so the failure is never silent. The dialog
        // stays open with the draft intact for a retry.
        console.error('Calendar edit save failed:', error);
      } finally {
        setIsSaving(false);
      }
    },
    [editMutation, itemToEdit]
  );

  const grid = React.useMemo(
    () => getMonthGridKeys(month.year, month.month, pageTimezone),
    [month, pageTimezone]
  );
  const today = todayKey(pageTimezone);
  const monthPrefix = `${month.year}-${String(month.month + 1).padStart(2, '0')}`;
  const isLoading = itemsQuery.isPending || estimatesQuery.isPending;
  const isError = itemsQuery.isError || estimatesQuery.isError;

  return (
    <div data-testid="calendar-view-panel" className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-bold text-ink">Calendar View</h2>
        <p className="m-0 mt-1 text-body text-ink-sub">
          Posts by the day they go out. Queued posts sit on their estimated day;
          published and failed posts on the day they landed.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter calendar by status">
        {FILTERS.map((chip) => (
          <Button
            key={chip.id}
            type="button"
            size="sm"
            variant={filter === chip.id ? 'default' : 'outline'}
            data-testid={`calendar-filter-${chip.id}`}
            onClick={() => setFilter(chip.id)}
          >
            {chip.label} ({filterCounts[chip.id]})
          </Button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-4">
        <h3 data-testid="calendar-month-label" className="m-0 text-base font-semibold text-ink">
          {formatMonthLabel(month.year, month.month)}
        </h3>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            data-testid="calendar-prev-btn"
            aria-label="Previous month"
            onClick={() => setMonth(prevMonth(month.year, month.month))}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="calendar-today-btn"
            onClick={() => setMonth(currentYearMonth(pageTimezone))}
          >
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            data-testid="calendar-next-btn"
            aria-label="Next month"
            onClick={() => setMonth(nextMonth(month.year, month.month))}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Loading calendar...</span>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <div
          data-testid="calendar-error-state"
          className="flex flex-col items-center gap-4 rounded-md border border-signal-critical/40 bg-panel px-6 py-12 text-center"
        >
          <p className="m-0 text-body text-ink-sub">Couldn't load the calendar.</p>
          <Button
            type="button"
            onClick={() => {
              void itemsQuery.refetch();
              void estimatesQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div
          data-testid="calendar-empty-state"
          className="flex flex-col items-center gap-4 rounded-md border border-line bg-panel px-6 py-12 text-center"
        >
          <p className="m-0 text-body text-ink-sub">
            {filter === 'all' ? 'No posts yet.' : `No ${filter} posts.`}
          </p>
        </div>
      ) : (
        <div>
          <div className="mb-2 grid grid-cols-7 gap-2 text-center text-xs font-semibold text-ink-sub">
            {CALENDAR_WEEKDAYS.map((day) => (
              <div key={day} className="py-1">
                {day}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {grid.map((week) => (
              <div key={week[0]} className="grid grid-cols-7 gap-2">
                {week.map((dayKey) => {
                  const inMonth = dayKey.startsWith(monthPrefix);
                  const isToday = dayKey === today;
                  const dayEntries = entriesByDay.get(dayKey) ?? [];
                  return (
                    <div
                      key={dayKey}
                      data-testid={`calendar-day-${dayKey}`}
                      className={[
                        'flex min-h-24 min-w-0 flex-col rounded-xl border p-1.5',
                        isToday
                          ? 'border-link/60 bg-link/5 ring-1 ring-link/20'
                          : 'border-line bg-panel',
                        inMonth ? '' : 'opacity-40',
                      ].join(' ')}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span
                          className={[
                            'rounded-md px-1.5 py-0.5 text-xs font-bold',
                            isToday ? 'bg-primary text-on-primary' : 'text-ink-sub',
                          ].join(' ')}
                        >
                          {dayNumberOfKey(dayKey)}
                        </span>
                        {dayEntries.length > 0 ? (
                          <span className="rounded-full bg-link/10 px-1.5 py-0.5 text-metadata font-bold text-link">
                            {dayEntries.length}
                          </span>
                        ) : null}
                      </div>
                      <div className="max-h-24 flex-1 space-y-1 overflow-y-auto pr-0.5">
                        {dayEntries.map((entry) => {
                          const isPublished = entry.item.status === 'published';
                          // K1: publishing entries are not
                          // clickable either — the row is
                          // immutable until the worker settles it.
                          const isPublishing = entry.item.status === 'publishing';
                          const inner = (
                            <>
                              <span className="shrink-0 text-ink-sub">
                                {typeIcon(entry.item.postFormat)}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block font-semibold text-ink">
                                  {entry.timeLabel ?? ''}
                                </span>
                                <span className="block truncate text-ink-sub">
                                  {entry.item.caption ? (
                                    entry.item.caption
                                  ) : (
                                    <span className="italic">No caption</span>
                                  )}
                                </span>
                              </span>
                            </>
                          );
                          // Published (and publishing) posts keep
                          // edit disabled, same as the list: their
                          // entries are not clickable.
                          return isPublished || isPublishing ? (
                            <div
                              key={entry.item.id}
                              data-testid={`calendar-entry-${entry.item.id}`}
                              title={
                                isPublishing
                                  ? "Publishing posts can't be edited"
                                  : "Published posts can't be edited"
                              }
                              className="flex min-w-0 items-start gap-1 rounded-lg border border-line bg-canvas p-1.5 text-left text-metadata leading-tight opacity-70"
                            >
                              {inner}
                            </div>
                          ) : (
                            <button
                              key={entry.item.id}
                              type="button"
                              data-testid={`calendar-entry-${entry.item.id}`}
                              onClick={() => setItemToEdit(entry.item)}
                              className="flex w-full min-w-0 items-start gap-1 rounded-lg border border-line bg-canvas p-1.5 text-left text-metadata leading-tight hover:border-link/40"
                            >
                              {inner}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {capped ? (
        <p data-testid="calendar-capped-note" className="m-0 text-metadata text-ink-sub">
          Showing the first 100 posts — the calendar may be incomplete while more than 100
          posts exist.
        </p>
      ) : null}
      {unscheduledCount > 0 ? (
        <p data-testid="calendar-unscheduled-note" className="m-0 text-metadata text-link">
          {unscheduledCount} queued{' '}
          {unscheduledCount === 1 ? 'post has' : 'posts have'} no estimate yet (no posting
          time matches {unscheduledCount === 1 ? 'its' : 'their'} type) so{' '}
          {unscheduledCount === 1 ? 'it is' : 'they are'} not on this calendar.
        </p>
      ) : null}

      <QueueEditDialog
        item={itemToEdit}
        isSaving={isSaving}
        onClose={() => setItemToEdit(null)}
        onSave={handleSaveEdit}
      />
    </div>
  );
}
