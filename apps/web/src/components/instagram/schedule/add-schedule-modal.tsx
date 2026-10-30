'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, SearchIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import { getErrorMessage } from '@/lib/api/errors';
import { ListInstagramAccountsResponseSchema } from '@fbuploadpro/contracts';
import { validateInstagramScheduleSlots } from '@fbuploadpro/contracts';
import {
  AddInstagramScheduleResponseSchema,
} from '@/lib/api/schemas/instagram-schedule';
import { searchAndGroupTimezones } from '@/lib/timezones';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Input } from '@/components/shared/ui/input';
import { StatusMark } from '@/components/shared/ui/status-mark';

/**
 * Add to Schedule modal — the Add Page flow adapted for Instagram.
 * Steps: 1) pick a connected Instagram account (no discovery step:
 * the destination IS the account), 2) pick a timezone, 3) set
 * posting times. Expired or disconnected accounts are shown disabled
 * with a note to reconnect in Instagram Accounts, mirroring Pages
 * eligibility. Posting times offer Photo / Reel / Carousel only.
 */

type Step = 'account' | 'timezone' | 'times';

const FORMAT_OPTIONS = [
  { value: 'image', label: 'Photo' },
  { value: 'reel', label: 'Reel' },
  { value: 'carousel', label: 'Carousel' },
] as const;

interface DraftTime {
  time: string;
  formats: string[];
}

export function AddScheduleModal({
  subdomain,
  open,
  onOpenChange,
  onSuccess,
}: Readonly<{
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (destinationId: string) => void;
}>) {
  const [step, setStep] = React.useState<Step>('account');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [timezone, setTimezone] = React.useState<string | null>(null);
  const [timezoneSearch, setTimezoneSearch] = React.useState('');
  const [times, setTimes] = React.useState<DraftTime[]>([
    { time: '09:00', formats: ['image', 'reel', 'carousel'] },
  ]);
  const [newTime, setNewTime] = React.useState('12:00');
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const accountsQuery = useQuery({
    queryKey: ['tenant', subdomain, 'instagram', 'accounts', 'list', 'all'],
    queryFn: async ({ signal }) => {
      const all: Array<{
        id: string;
        displayName: string;
        profilePictureUrl: string | null;
        status: string;
        destinationHandle: string | null;
      }> = [];
      const seenIds = new Set<string>();
      let currentPage = 1;
      let total = Number.POSITIVE_INFINITY;
      while (all.length < total) {
        const data = await api.get(
          buildUrl(buildTenantApiPath(subdomain, '/instagram/accounts'), {
            page: currentPage,
            limit: 50,
          }),
          { schema: ListInstagramAccountsResponseSchema, signal }
        );
        const batch = data.accounts ?? [];
        if (batch.length === 0) break;
        let added = false;
        for (const account of batch) {
          if (account.id && !seenIds.has(account.id)) {
            seenIds.add(account.id);
            all.push({
              id: account.id,
              displayName: account.displayName,
              profilePictureUrl: account.profilePictureUrl ?? null,
              status: account.status,
              destinationHandle: account.destinationHandle ?? null,
            });
            added = true;
          }
        }
        if (!added) break;
        total = data.total;
        currentPage += 1;
      }
      return all;
    },
    enabled: open,
  });

  const groupedTimezones = React.useMemo(
    () => searchAndGroupTimezones(timezoneSearch),
    [timezoneSearch]
  );

  const reset = React.useCallback(() => {
    setStep('account');
    setAccountId(null);
    setTimezone(null);
    setTimezoneSearch('');
    setTimes([{ time: '09:00', formats: ['image', 'reel', 'carousel'] }]);
    setNewTime('12:00');
    setError(null);
    setIsSubmitting(false);
  }, []);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset]
  );

  const selectedAccount = (accountsQuery.data ?? []).find(
    (account) => account.id === accountId
  );

  const timesError = validateInstagramScheduleSlots(times);

  const handleSubmit = React.useCallback(async () => {
    if (!accountId || !timezone || timesError) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await api.post(
        buildTenantApiPath(subdomain, '/instagram/schedule'),
        {
          accountId,
          timezone,
          postingTimes: times.map((t) => ({
            time: t.time,
            formats: t.formats,
          })),
        },
        { schema: AddInstagramScheduleResponseSchema }
      );
      handleOpenChange(false);
      onSuccess(result.destinationId);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not add this account to Schedule.'));
    } finally {
      setIsSubmitting(false);
    }
  }, [accountId, timezone, times, timesError, subdomain, handleOpenChange, onSuccess]);

  const titles: Record<Step, { title: string; subtitle: string }> = {
    account: {
      title: 'Add an Instagram account',
      subtitle: 'Choose an account you have already connected.',
    },
    timezone: {
      title: 'Choose a timezone',
      subtitle: 'Posting times are shown in this timezone.',
    },
    times: {
      title: 'Set posting times',
      subtitle: 'Posts created for this account will go out at these times.',
    },
  };
  const current = titles[step];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-135"
        data-testid="add-schedule-modal"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            {step !== 'account' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Back"
                onClick={() =>
                  setStep(step === 'times' ? 'timezone' : 'account')
                }
              >
                <ArrowLeftIcon aria-hidden />
              </Button>
            )}
            <div>
              <DialogTitle>{current.title}</DialogTitle>
              <DialogDescription>{current.subtitle}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {error && (
          <div
            role="alert"
            data-testid="add-schedule-error"
            className="rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2.5 text-body text-ink"
          >
            {error}
          </div>
        )}

        {step === 'account' && (
          <div className="flex flex-col gap-2">
            {accountsQuery.isPending && <p className="text-body text-ink-sub">Loading accounts…</p>}
            {accountsQuery.isError && (
              <p className="text-body text-signal-critical">
                Couldn&apos;t load your Instagram accounts. Close this and try again.
              </p>
            )}
            {(accountsQuery.data ?? []).length === 0 &&
              !accountsQuery.isPending && (
                <p className="text-body text-ink-sub">
                  No Instagram accounts are connected yet. Connect one in
                  Instagram Accounts first.
                </p>
              )}
            {(accountsQuery.data ?? []).map((account) => {
              const disabled = account.status !== 'active';
              const selected = accountId === account.id;
              return (
                <button
                  key={account.id}
                  type="button"
                  disabled={disabled}
                  data-testid={`add-schedule-account-${account.id}`}
                  onClick={() => {
                    setAccountId(account.id);
                    setStep('timezone');
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-line bg-panel px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {account.displayName}
                    </span>
                    <span className="block truncate text-body text-ink-sub">
                      {account.destinationHandle
                        ? `@${account.destinationHandle}`
                        : 'Instagram account'}
                    </span>
                  </span>
                  {disabled ? (
                    <StatusMark
                      kind="critical"
                      label="Reconnect in Instagram Accounts"
                      testId={`add-schedule-account-status-${account.id}`}
                    />
                  ) : (
                    selected && (
                      <StatusMark
                        kind="operational"
                        label="Selected"
                        testId={`add-schedule-account-status-${account.id}`}
                      />
                    )
                  )}
                </button>
              );
            })}
          </div>
        )}

        {step === 'timezone' && (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <SearchIcon
                aria-hidden
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-sub"
              />
              <Input
                data-testid="add-schedule-timezone-search-input"
                type="search"
                placeholder="Search timezones"
                value={timezoneSearch}
                onChange={(event) => setTimezoneSearch(event.target.value)}
                className="pl-9"
              />
            </div>
            <p data-testid="add-schedule-timezone-note" className="m-0 text-body text-ink-sub">
              {timezone
                ? `Selected timezone: ${timezone}`
                : 'No timezone selected yet. Choose a timezone to continue.'}
            </p>
            <div
              data-testid="add-schedule-timezone-list"
              className="flex max-h-80 flex-col gap-4 overflow-y-auto pr-1"
            >
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
                          data-testid={`add-schedule-timezone-option-${entry.iana}`}
                          onClick={() => {
                            setTimezone(entry.iana);
                            setStep('times');
                          }}
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
          </div>
        )}

        {step === 'times' && (
          <div className="flex flex-col gap-4">
            <p className="m-0 text-body text-ink-sub">
              Timezone for these posting times:{' '}
              <span className="font-semibold text-ink">{timezone}</span>{' '}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setStep('timezone')}
              >
                Change
              </Button>
            </p>
            <div className="flex flex-col gap-3">
              {times.map((draft, index) => (
                <div
                  key={`${draft.time}-${index}`}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-panel px-3 py-2.5"
                >
                  <Input
                    data-testid={`add-schedule-time-input-${index}`}
                    type="time"
                    value={draft.time}
                    onChange={(event) => {
                      const next = [...times];
                      next[index] = { ...draft, time: event.target.value };
                      setTimes(next);
                    }}
                    className="w-32"
                  />
                  {FORMAT_OPTIONS.map((format) => (
                    <label
                      key={format.value}
                      className="flex cursor-pointer items-center gap-1.5 text-body"
                    >
                      <Checkbox
                        checked={draft.formats.includes(format.value)}
                        onCheckedChange={(checked) => {
                          const next = [...times];
                          const formats = checked
                            ? [...draft.formats, format.value]
                            : draft.formats.filter((f) => f !== format.value);
                          next[index] = { ...draft, formats };
                          setTimes(next);
                        }}
                      />
                      {format.label}
                    </label>
                  ))}
                  {times.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTimes(times.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {timesError && (
              <p role="alert" className="m-0 text-body text-signal-critical">
                {timesError}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Input
                data-testid="add-schedule-new-time-input"
                type="time"
                value={newTime}
                onChange={(event) => setNewTime(event.target.value)}
                className="w-32"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!times.some((t) => t.time === newTime)) {
                    setTimes([
                      ...times,
                      { time: newTime, formats: ['image', 'reel', 'carousel'] },
                    ]);
                  }
                }}
              >
                Add posting time
              </Button>
            </div>
            <Button
              type="button"
              data-testid="add-schedule-submit-btn"
              disabled={!accountId || !timezone || Boolean(timesError) || isSubmitting}
              onClick={() => void handleSubmit()}
            >
              {isSubmitting ? 'Adding…' : 'Add to Schedule'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
