'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  AddThreadsScheduleResponseSchema,
  ListThreadsScheduleCandidatesResponseSchema,
  THREADS_SCHEDULE_FORMATS,
  type ThreadsScheduleCandidate,
  type ThreadsScheduleFormat,
} from '@fbuploadpro/contracts';
import { queryKeys } from '@/lib/data';
import { reportError } from '@/lib/report-error';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Input } from '@/components/shared/ui/input';
import { Banner } from '@/components/shared/ui/banner';
import { searchAndGroupTimezones } from '@/lib/timezones';

const FORMAT_LABELS: Record<ThreadsScheduleFormat, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  carousel: 'Carousel',
};

function format12h(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  if (hours === undefined || minutes === undefined || Number.isNaN(hours) || Number.isNaN(minutes)) {
    return time;
  }
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

interface PostingTimeDraft {
  time: string;
  formats: ThreadsScheduleFormat[];
}

export function AddThreadsScheduleDialog({
  open,
  onOpenChange,
  subdomain,
  onAdded,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subdomain: string;
  onAdded: (name: string) => void;
}>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [step, setStep] = React.useState(1);
  const [selectedDestinationId, setSelectedDestinationId] = React.useState<string | null>(null);
  const [timezoneSearch, setTimezoneSearch] = React.useState('');
  const [timezone, setTimezone] = React.useState<string | null>(null);
  const [postingTimes, setPostingTimes] = React.useState<PostingTimeDraft[]>([
    { time: '09:00', formats: [...THREADS_SCHEDULE_FORMATS] },
  ]);
  const [error, setError] = React.useState<string | null>(null);

  const candidatesQuery = useQuery({
    queryKey: tenant.threadsSchedule.candidates,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/threads/schedule/candidates'), {
        schema: ListThreadsScheduleCandidatesResponseSchema,
        signal,
      }),
    enabled: open,
  });
  const candidates: ThreadsScheduleCandidate[] = candidatesQuery.data?.candidates ?? [];

  const reset = React.useCallback(() => {
    setStep(1);
    setSelectedDestinationId(null);
    setTimezoneSearch('');
    setTimezone(null);
    setPostingTimes([{ time: '09:00', formats: [...THREADS_SCHEDULE_FORMATS] }]);
    setError(null);
  }, []);

  const close = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) reset();
      onOpenChange(nextOpen);
    },
    [onOpenChange, reset]
  );

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDestinationId || !timezone) {
        throw new Error('Choose an account and a timezone first.');
      }
      return api.post(
        buildTenantApiPath(subdomain, '/threads/schedule'),
        {
          destinationId: selectedDestinationId,
          timezone,
          postingTimes: postingTimes.map((t) => ({ time: t.time, formats: t.formats })),
        },
        { schema: AddThreadsScheduleResponseSchema }
      );
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: tenant.threadsSchedule.list });
      onAdded(data.item.name);
      reset();
    },
    onError: (err: unknown) => {
      const message = isApiError(err) ? err.message : 'Could not add this account. Try again.';
      setError(message);
      reportError(err);
    },
  });

  const timezoneGroups = React.useMemo(
    () => searchAndGroupTimezones(timezoneSearch),
    [timezoneSearch]
  );
  const duplicateTimes =
    new Set(postingTimes.map((t) => t.time)).size !== postingTimes.length;
  const invalidTimes = postingTimes.some(
    (t) => !t.time || t.formats.length === 0
  );

  const canFinish =
    selectedDestinationId !== null &&
    timezone !== null &&
    postingTimes.length >= 1 &&
    !duplicateTimes &&
    !invalidTimes &&
    !addMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent aria-label="Add account to In-app Schedule">
        <DialogHeader>
          <DialogTitle>Add account to In-app Schedule</DialogTitle>
          <DialogDescription>
            {step === 1
              ? 'Choose a connected Threads account. Accounts are connected in Threads Accounts.'
              : step === 2
                ? 'Choose the timezone your posting times use.'
                : 'Add at least one posting time. Queued posts go out at these times, in queue order.'}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Banner variant="critical" title="Could not add this account">
            {error}
          </Banner>
        ) : null}

        {step === 1 ? (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {candidatesQuery.isPending ? (
              <p className="text-body text-ink-dim">Loading connected accounts…</p>
            ) : candidatesQuery.isError ? (
              <p className="text-body text-ink-dim" role="alert">
                Could not load connected accounts. Try again.
              </p>
            ) : candidates.length === 0 ? (
              <p className="text-body text-ink-dim">
                No Threads accounts are connected yet. Connect one in Threads
                Accounts first.
              </p>
            ) : (
              candidates.map((candidate) => {
                const disabled =
                  candidate.destinationId === null ||
                  candidate.scheduleAdded ||
                  candidate.accountStatus === 'expired';
                const reason = candidate.scheduleAdded
                  ? 'Already in In-app Schedule'
                  : candidate.destinationId === null
                    ? 'No Threads profile linked yet'
                    : candidate.accountStatus === 'expired'
                      ? 'Connection expired — reconnect in Threads Accounts'
                      : null;
                return (
                  <button
                    key={candidate.accountId}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (candidate.destinationId) {
                        setSelectedDestinationId(candidate.destinationId);
                        setTimezone(candidate.destinationTimezone ?? 'UTC');
                      }
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-md border border-line bg-panel px-4 py-3 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span>
                      <span className="block text-body font-medium text-ink">
                        {candidate.displayName}
                      </span>
                      {candidate.handle ? (
                        <span className="block text-metadata text-ink-dim">
                          @{candidate.handle}
                        </span>
                      ) : null}
                      {reason ? (
                        <span className="block text-metadata text-ink-dim">{reason}</span>
                      ) : null}
                    </span>
                    {selectedDestinationId === candidate.destinationId ? (
                      <span className="text-body font-medium text-link">Selected</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-3">
            <Input
              type="search"
              aria-label="Search timezones"
              placeholder="Search city or country"
              value={timezoneSearch}
              onChange={(event) => setTimezoneSearch(event.target.value)}
            />
            <div className="flex max-h-80 flex-col gap-4 overflow-y-auto">
              {(Object.keys(timezoneGroups) as Array<keyof typeof timezoneGroups>).map(
                (region) => {
                  const entries = timezoneGroups[region];
                  if (entries.length === 0) return null;
                  return (
                    <div key={region}>
                      <p className="mb-1 text-metadata font-medium text-ink-dim">{region}</p>
                      {entries.map((entry) => (
                        <button
                          key={entry.iana}
                          type="button"
                          onClick={() => setTimezone(entry.iana)}
                          className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-body hover:bg-hover"
                        >
                          <span>
                            {entry.city} ({entry.country}) — {entry.offset}
                          </span>
                          {timezone === entry.iana ? (
                            <span className="font-medium text-link">Selected</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  );
                }
              )}
            </div>
            {timezone ? (
              <p className="text-body text-ink-dim">
                Selected timezone: {timezone}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-3">
            {postingTimes.map((draft, index) => (
              <div
                key={index}
                className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-panel px-3 py-3"
              >
                <input
                  type="time"
                  aria-label={`Posting time ${index + 1}`}
                  value={draft.time}
                  onChange={(event) => {
                    const next = [...postingTimes];
                    const current = next[index];
                    if (current) next[index] = { ...current, time: event.target.value };
                    setPostingTimes(next);
                  }}
                  className="rounded-sm border border-line bg-panel px-2 py-2 text-body text-ink"
                />
                <span className="text-metadata text-ink-dim">{format12h(draft.time)}</span>
                <span className="flex flex-wrap gap-2">
                  {THREADS_SCHEDULE_FORMATS.map((format) => (
                    <label key={format} className="flex items-center gap-1 text-body">
                      <input
                        type="checkbox"
                        checked={draft.formats.includes(format)}
                        onChange={(event) => {
                          const next = [...postingTimes];
                          const current = next[index];
                          if (!current) return;
                          next[index] = {
                            ...current,
                            formats: event.target.checked
                              ? [...current.formats, format]
                              : current.formats.filter((f) => f !== format),
                          };
                          setPostingTimes(next);
                        }}
                      />
                      {FORMAT_LABELS[format]}
                    </label>
                  ))}
                </span>
                {postingTimes.length > 1 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPostingTimes(postingTimes.filter((_, i) => i !== index))
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            ))}
            {duplicateTimes ? (
              <p className="text-body text-signal-critical" role="alert">
                Each posting time can only appear once.
              </p>
            ) : null}
            {postingTimes.length < 24 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setPostingTimes([
                    ...postingTimes,
                    { time: '12:00', formats: [...THREADS_SCHEDULE_FORMATS] },
                  ])
                }
              >
                Add another time
              </Button>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {step > 1 ? (
            <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {step === 1 ? (
            <Button
              type="button"
              disabled={selectedDestinationId === null}
              onClick={() => setStep(2)}
            >
              Continue
            </Button>
          ) : step === 2 ? (
            <Button type="button" disabled={timezone === null} onClick={() => setStep(3)}>
              Continue
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!canFinish}
              onClick={() => addMutation.mutate()}
            >
              {addMutation.isPending ? 'Adding…' : 'Add to Schedule'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
