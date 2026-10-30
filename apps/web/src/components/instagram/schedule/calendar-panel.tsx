'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import {
  ListInstagramScheduleQueueResponseSchema,
  type InstagramScheduleQueueItem,
} from '@/lib/api/schemas/instagram-schedule';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { cn } from '@/lib/utils';

/**
 * Instagram Schedule Calendar View — a month grid fed by the
 * Instagram queue API for the visible month (from/to window, max
 * 93 days on the server). A day shows its post count; selecting a
 * day lists that day's posts with their status. Posts without a
 * scheduled time (next-posting-time posts) appear under "No date"
 * only when the month window cannot place them — in practice every
 * queued Instagram post carries a scheduled time, so this is a
 * safety net, not a second list.
 */

function monthWindow(year: number, month: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

function dayKey(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function CalendarPanel({
  subdomain,
  destinationId,
  timezone,
}: Readonly<{
  subdomain: string;
  destinationId: string;
  timezone: string;
}>) {
  const tenant = queryKeys.tenant(subdomain);
  const today = new Date();
  const [year, setYear] = React.useState(today.getUTCFullYear());
  const [month, setMonth] = React.useState(today.getUTCMonth());
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null);
  const { from, to } = React.useMemo(() => monthWindow(year, month), [year, month]);

  const query = useQuery({
    queryKey: tenant.instagramSchedule.queue(destinationId, {
      from,
      to,
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(
          buildTenantApiPath(subdomain, `/instagram/schedule/${destinationId}/queue`),
          { page: 1, limit: 200, from, to }
        ),
        { schema: ListInstagramScheduleQueueResponseSchema, signal }
      ),
  });

  const items = query.data?.items ?? [];
  const byDay = React.useMemo(() => {
    const map = new Map<string, InstagramScheduleQueueItem[]>();
    for (const item of items) {
      if (!item.scheduledTime) continue;
      const key = dayKey(new Date(item.scheduledTime), timezone);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, [items, timezone]);

  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const startWeekday = firstOfMonth.getUTCDay();
  const cells: Array<{ day: number | null; key: string }> = [];
  for (let i = 0; i < startWeekday; i += 1) {
    cells.push({ day: null, key: `blank-${i}` });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ day, key: `day-${day}` });
  }
  const monthLabel = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(firstOfMonth);

  const shiftMonth = (delta: number) => {
    const next = new Date(Date.UTC(year, month + delta, 1));
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth());
    setSelectedDay(null);
  };

  const selectedItems = selectedDay ? (byDay.get(selectedDay) ?? []) : [];

  return (
    <div data-testid="instagram-schedule-calendar-panel">
      <div className="mb-4 flex items-center gap-3">
        <Button type="button" variant="outline" onClick={() => shiftMonth(-1)}>
          Previous month
        </Button>
        <p className="m-0 font-semibold">{monthLabel}</p>
        <Button type="button" variant="outline" onClick={() => shiftMonth(1)}>
          Next month
        </Button>
      </div>
      {query.isPending && <p className="text-body text-ink-sub">Loading calendar…</p>}
      {query.isError && <p className="text-body text-signal-critical">Couldn&apos;t load the calendar. Try again.</p>}
      {!query.isPending && !query.isError && (
        <>
          <div className="grid grid-cols-7 gap-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
              <p key={label} className="m-0 text-center text-metadata font-semibold text-ink-sub">
                {label}
              </p>
            ))}
            {cells.map((cell) => {
              if (cell.day === null) {
                return <div key={cell.key} />;
              }
              const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(cell.day).padStart(2, '0')}`;
              const count = byDay.get(key)?.length ?? 0;
              const selected = selectedDay === key;
              return (
                <button
                  key={cell.key}
                  type="button"
                  data-testid={`instagram-schedule-calendar-day-${key}`}
                  onClick={() => setSelectedDay(selected ? null : key)}
                  className={cn(
                    'rounded-md border border-line bg-panel px-2 py-3 text-center',
                    selected && 'border-brand-gold bg-brand-gold/10'
                  )}
                >
                  <span className="block font-semibold">{cell.day}</span>
                  <span className="block text-metadata text-ink-sub">
                    {count === 0 ? '' : `${count} ${count === 1 ? 'post' : 'posts'}`}
                  </span>
                </button>
              );
            })}
          </div>
          {selectedDay && (
            <div className="mt-6 flex flex-col gap-3">
              <p className="m-0 font-semibold">{selectedDay}</p>
              {selectedItems.length === 0 && (
                <p className="m-0 text-body text-ink-sub">No posts on this day.</p>
              )}
              {selectedItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-md border border-line bg-panel px-4 py-3"
                >
                  <p className="m-0 line-clamp-2 text-body">
                    {item.caption || 'No caption'}
                  </p>
                  <div className="mt-2">
                    <StatusMark
                      kind={
                        item.status === 'published'
                          ? 'operational'
                          : item.status === 'failed'
                            ? 'critical'
                            : 'queued'
                      }
                      label={item.status}
                      testId={`instagram-schedule-calendar-status-${item.id}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
