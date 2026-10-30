'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';

import { api, buildTenantApiPath } from '@/lib/api';
import { getErrorMessage } from '@/lib/api/errors';
import {
  ListQueueSlotsResponseSchema,
  PageQueueSlotSchema,
} from '@/lib/api/schemas/queue';
import { queryKeys } from '@/lib/data/query-keys';
import { searchAndGroupTimezones } from '@/lib/timezones';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Input } from '@/components/shared/ui/input';
import { toast } from '@/components/shared/ui/toast';
import { z } from 'zod';

/**
 * Instagram Schedule Posting Times tab — the Pages posting-times
 * tab's behaviour for Instagram: slot list, add slot, delete slot,
 * change timezone. Formats are Photo / Reel / Carousel only.
 * Changing the timezone changes the timezone future posting times
 * are resolved in; posts already in the queue keep the absolute
 * time they were given, and the dialog says so plainly.
 */

const AckSchema = z.object({}).passthrough();

const FORMAT_OPTIONS = [
  { value: 'image', label: 'Photo' },
  { value: 'reel', label: 'Reel' },
  { value: 'carousel', label: 'Carousel' },
] as const;

function formatLabel(format: string): string {
  if (format === 'image') return 'Photo';
  if (format === 'reel') return 'Reel';
  if (format === 'carousel') return 'Carousel';
  if (format === 'video') return 'Reel';
  return format;
}

export function PostingTimesPanel({
  subdomain,
  destinationId,
  timezone,
  queuedCount,
}: Readonly<{
  subdomain: string;
  destinationId: string;
  timezone: string;
  queuedCount: number;
}>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [newTime, setNewTime] = React.useState('09:00');
  const [newFormats, setNewFormats] = React.useState<string[]>([
    'image',
    'reel',
    'carousel',
  ]);
  const [timezoneDialogOpen, setTimezoneDialogOpen] = React.useState(false);
  const [timezoneSearch, setTimezoneSearch] = React.useState('');
  const [selectedTimezone, setSelectedTimezone] = React.useState(timezone);

  const slotsPath = buildTenantApiPath(
    subdomain,
    `/instagram/schedule/${destinationId}/slots`
  );
  const slotsQuery = useQuery({
    queryKey: tenant.instagramSchedule.slots(destinationId),
    queryFn: ({ signal }) =>
      api.get(slotsPath, { schema: ListQueueSlotsResponseSchema, signal }),
  });

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: tenant.instagramSchedule.slots(destinationId),
    });
    void queryClient.invalidateQueries({
      queryKey: tenant.instagramSchedule.detail(destinationId),
    });
  }, [queryClient, tenant.instagramSchedule, destinationId]);

  const addMutation = useMutation({
    mutationFn: (body: { time: string; formats: string[] }) =>
      api.post(slotsPath, body, { schema: PageQueueSlotSchema }),
    onSuccess: () => {
      invalidate();
      toast.success('Posting time added.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't add this posting time. Please try again."));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (slotId: string) =>
      api.delete(`${slotsPath}/${slotId}`, { schema: AckSchema }),
    onSuccess: () => {
      invalidate();
      toast.success('Posting time deleted.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't delete this posting time. Please try again."));
    },
  });

  const timezoneMutation = useMutation({
    mutationFn: (nextTimezone: string) =>
      api.patch(slotsPath, { timezone: nextTimezone }, { schema: AckSchema }),
    onSuccess: () => {
      invalidate();
      setTimezoneDialogOpen(false);
      toast.success('Timezone changed.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't change the timezone. Please try again."));
    },
  });

  const slots = slotsQuery.data?.slots ?? [];
  const groupedTimezones = React.useMemo(
    () => searchAndGroupTimezones(timezoneSearch),
    [timezoneSearch]
  );

  return (
    <div data-testid="instagram-schedule-posting-times-panel">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="m-0 text-body text-ink-sub">
          Timezone: <span className="font-semibold text-ink">{timezone}</span>
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSelectedTimezone(timezone);
            setTimezoneSearch('');
            setTimezoneDialogOpen(true);
          }}
        >
          Change timezone
        </Button>
      </div>

      {slotsQuery.isPending && <p className="text-body text-ink-sub">Loading posting times…</p>}
      {slotsQuery.isError && (
        <EmptyState
          type="not-found"
          title="Couldn't load posting times"
          description="Please try again."
          action={
            <Button type="button" onClick={() => void slotsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      {!slotsQuery.isPending && !slotsQuery.isError && slots.length === 0 && (
        <EmptyState
          type="no-results"
          title="No posting times yet"
          description="Add a posting time below. Posts created for this account will go out at these times."
        />
      )}

      <div className="flex flex-col gap-2">
        {slots.map((slot) => (
          <div
            key={slot.id}
            data-testid={`instagram-schedule-slot-${slot.id}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-panel px-4 py-3"
          >
            <div>
              <p className="m-0 font-semibold">{slot.slotTime}</p>
              <p className="m-0 text-body text-ink-sub">
                {(slot.allowedFormats ?? []).map(formatLabel).join(' · ')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(slot.id)}
            >
              Delete
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-md border border-line bg-panel px-4 py-3">
        <Input
          data-testid="instagram-schedule-new-slot-time-input"
          type="time"
          value={newTime}
          onChange={(event) => setNewTime(event.target.value)}
          className="w-32"
        />
        {FORMAT_OPTIONS.map((format) => (
          <label
            key={format.value}
            className="flex cursor-pointer items-center gap-1.5 text-body"
          >
            <Checkbox
              checked={newFormats.includes(format.value)}
              onCheckedChange={(checked) => {
                setNewFormats(
                  checked
                    ? [...newFormats, format.value]
                    : newFormats.filter((f) => f !== format.value)
                );
              }}
            />
            {format.label}
          </label>
        ))}
        <Button
          type="button"
          disabled={addMutation.isPending || newFormats.length === 0}
          onClick={() =>
            addMutation.mutate({ time: newTime, formats: newFormats })
          }
        >
          Add posting time
        </Button>
      </div>

      <Dialog open={timezoneDialogOpen} onOpenChange={setTimezoneDialogOpen}>
        <DialogContent data-testid="instagram-schedule-timezone-dialog">
          <DialogHeader>
            <DialogTitle>Change timezone</DialogTitle>
          </DialogHeader>
          <p className="m-0 text-body text-ink-sub">
            Future posting times for this account will be resolved in the
            new timezone. Posts already in the queue keep the time they
            were given. {queuedCount} {queuedCount === 1 ? 'post is' : 'posts are'} queued.
          </p>
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-sub"
            />
            <Input
              type="search"
              placeholder="Search timezones"
              value={timezoneSearch}
              onChange={(event) => setTimezoneSearch(event.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex max-h-80 flex-col gap-4 overflow-y-auto pr-1">
            {Object.entries(groupedTimezones).map(([region, entries]) =>
              entries.length === 0 ? null : (
                <div key={region}>
                  <p className="mb-2 text-metadata font-semibold text-ink-sub">
                    {region}
                  </p>
                  <div className="flex flex-col gap-1">
                    {entries.map((entry) => (
                      <button
                        key={entry.iana}
                        type="button"
                        onClick={() => setSelectedTimezone(entry.iana)}
                        className="rounded-sm px-2 py-1.5 text-left text-body hover:bg-subtle"
                      >
                        {entry.label} · {entry.offset}
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
          <p className="m-0 text-body text-ink-sub">
            Selected: <span className="font-semibold text-ink">{selectedTimezone}</span>
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setTimezoneDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={timezoneMutation.isPending || selectedTimezone === timezone}
              onClick={() => timezoneMutation.mutate(selectedTimezone)}
            >
              Change timezone
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
