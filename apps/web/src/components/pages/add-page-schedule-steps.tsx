'use client';

/**
 * Add Page flow steps 3–4 — timezone, then posting times.
 *
 * Step 3 reuses the existing searchable timezone directory
 * (`@/lib/timezones`, the same registry the dedicated Posting Times
 * timezone flow renders) with no current-zone banner and no default:
 * the selection starts blank and Continue stays disabled until a
 * timezone is picked.
 *
 * Step 4 reuses the dedicated Posting Times shapes: the narrowed
 * native time input, the 12-hour preview, and the post-type pills
 * (`ALL_POST_FORMATS`, gold outline when selected). The selected
 * timezone is shown as plain text with a Change action back to
 * Step 3. Every time starts with all post types selected, and
 * Remove is offered only while more than one time remains.
 */
import * as React from 'react';
import { SearchIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { Input } from '@/components/shared/ui/input';
import { cn } from '@/lib/utils';
import {
  findTimezoneEntry,
  getTimezoneCurrentTime,
  getTimezoneUtcOffset,
  REGION_LABELS,
  REGION_ORDER,
  searchAndGroupTimezones,
} from '@/lib/timezones';
import {
  ALL_POST_FORMATS,
  formatSlotDisplay,
} from './dedicated/posting-times/posting-time-utils';
import type { AddPagePostingTime } from './add-page-helpers';

/* ------------------------------------------------------------------ */
/* Step 3 — select timezone                                            */
/* ------------------------------------------------------------------ */

export interface SelectTimezoneStepProps {
  selectedTimezone: string | null;
  timezoneSearchQuery: string;
  onTimezoneSearchChange: (value: string) => void;
  onSelectTimezone: (iana: string) => void;
}

export function SelectTimezoneStep({
  selectedTimezone,
  timezoneSearchQuery,
  onTimezoneSearchChange,
  onSelectTimezone,
}: Readonly<SelectTimezoneStepProps>) {
  const grouped = React.useMemo(
    () => searchAndGroupTimezones(timezoneSearchQuery),
    [timezoneSearchQuery]
  );
  const hasMatches = React.useMemo(
    () => REGION_ORDER.some((region) => grouped[region].length > 0),
    [grouped]
  );
  const selectedEntry = selectedTimezone
    ? findTimezoneEntry(selectedTimezone)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div
        data-testid="add-page-timezone-note"
        className="text-body text-ink-sub"
      >
        {selectedEntry
          ? `Selected timezone: ${selectedEntry.city} · ${selectedEntry.country} (${selectedTimezone})`
          : 'No timezone selected yet. Choose a timezone to continue.'}
      </div>

      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub"
        />
        <Input
          type="text"
          autoFocus
          data-testid="add-page-timezone-search-input"
          value={timezoneSearchQuery}
          onChange={(e) => onTimezoneSearchChange(e.target.value)}
          placeholder="Search by city, country, or region..."
          aria-label="Search Timezones"
          className="pl-9"
        />
      </div>

      <div
        data-testid="add-page-timezone-list"
        className="max-h-72 overflow-y-auto"
      >
        {!hasMatches && (
          <div
            data-testid="add-page-timezone-no-matches"
            className="px-4 py-6 text-center text-body text-ink-sub"
          >
            No timezones matching &ldquo;{timezoneSearchQuery}&rdquo;.
          </div>
        )}

        {REGION_ORDER.map((region) => {
          const entries = grouped[region];
          if (entries.length === 0) return null;
          return (
            <div
              key={region}
              data-testid={`add-page-timezone-region-${region}`}
              className="mb-2"
            >
              <div className="px-2 py-1 text-metadata font-semibold tracking-wide text-ink-dim uppercase">
                {REGION_LABELS[region]}
              </div>
              {entries.map((entry) => {
                const isSelected = selectedTimezone === entry.iana;
                return (
                  <button
                    key={entry.iana}
                    type="button"
                    data-testid={`add-page-timezone-option-${entry.iana}`}
                    aria-pressed={isSelected}
                    onClick={() => onSelectTimezone(entry.iana)}
                    className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-line px-2 py-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-link"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          'box-border size-3.5 shrink-0 rounded-full',
                          isSelected
                            ? 'border-4 border-link bg-neutral-white'
                            : 'border border-line-strong'
                        )}
                      />
                      <span className="flex flex-col">
                        <span
                          className={cn(
                            'text-body text-ink',
                            isSelected ? 'font-semibold' : 'font-medium'
                          )}
                        >
                          {entry.city}
                        </span>
                        <span className="text-metadata text-ink-sub">
                          {entry.country} · {entry.iana}
                        </span>
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col text-right">
                      <span className="text-metadata font-medium text-ink tabular-nums">
                        {entry.offset}
                      </span>
                      {entry.currentTime ? (
                        <span className="text-metadata text-ink-sub tabular-nums">
                          {entry.currentTime}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4 — set posting times                                          */
/* ------------------------------------------------------------------ */

export interface SelectPostingTimesStepProps {
  timezone: string;
  postingTimes: AddPagePostingTime[];
  canAddAnotherPostingTime: boolean;
  onChangeTimezone: () => void;
  onAddPostingTime: () => void;
  onRemovePostingTime: (index: number) => void;
  onPostingTimeChange: (index: number, slotTime: string) => void;
  onToggleFormat: (index: number, formatId: string) => void;
}

export function SelectPostingTimesStep({
  timezone,
  postingTimes,
  canAddAnotherPostingTime,
  onChangeTimezone,
  onAddPostingTime,
  onRemovePostingTime,
  onPostingTimeChange,
  onToggleFormat,
}: Readonly<SelectPostingTimesStepProps>) {
  const timeCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const postingTime of postingTimes) {
      counts.set(
        postingTime.slotTime,
        (counts.get(postingTime.slotTime) ?? 0) + 1
      );
    }
    return counts;
  }, [postingTimes]);

  return (
    <div className="flex flex-col gap-4">
      <div
        data-testid="add-page-selected-timezone-note"
        className="flex flex-wrap items-center gap-1.5 text-metadata text-ink-sub"
      >
        <span>Timezone for these posting times:</span>
        <span className="font-semibold text-ink">{timezone}</span>
        <span className="text-ink-sub">
          ({getTimezoneUtcOffset(timezone)}, {getTimezoneCurrentTime(timezone)})
        </span>
        <Button
          type="button"
          variant="link"
          size="sm"
          data-testid="change-timezone-btn"
          onClick={onChangeTimezone}
        >
          Change
        </Button>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="text-body font-semibold text-ink">Posting times</div>
        <Button
          type="button"
          variant="link"
          size="sm"
          data-testid="add-another-posting-time-btn"
          disabled={!canAddAnotherPostingTime}
          onClick={onAddPostingTime}
        >
          Add another posting time
        </Button>
      </div>

      <div className="text-metadata text-ink-sub">
        At least 1 posting time is required. The same posting times
        apply to every page you selected.
      </div>
      {!canAddAnotherPostingTime && (
        <div
          data-testid="add-page-posting-times-cap-note"
          className="text-metadata text-ink-sub"
        >
          Maximum of 24 posting times reached.
        </div>
      )}

      <div
        data-testid="add-page-posting-times-list"
        className="flex max-h-85 flex-col gap-4 overflow-y-auto"
      >
        {postingTimes.map((postingTime, index) => {
          // A cleared or invalid time previews nothing: showing
          // 09:00 AM for an empty field would be a fake time.
          const isValidTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(
            postingTime.slotTime
          );
          const preview = isValidTime
            ? formatSlotDisplay(postingTime.slotTime)
            : null;
          const isDuplicate =
            (timeCounts.get(postingTime.slotTime) ?? 0) > 1;
          return (
            <div
              key={`${postingTime.slotTime}-${index}`}
              data-testid={`add-page-posting-time-${index}`}
              className="flex flex-col gap-3 rounded-sm border border-line px-3 py-3"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="text-body font-semibold text-ink">
                  Posting time {index + 1}
                </div>
                {postingTimes.length > 1 && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    data-testid={`remove-posting-time-${index}`}
                    onClick={() => onRemovePostingTime(index)}
                  >
                    Remove
                  </Button>
                )}
              </div>

              <div>
                <Input
                  type="time"
                  required
                  autoFocus={index === 0}
                  data-testid={`add-page-posting-time-input-${index}`}
                  value={postingTime.slotTime}
                  onChange={(e) =>
                    onPostingTimeChange(index, e.target.value)
                  }
                  aria-label={`Time of day for posting time ${index + 1}`}
                  className="w-44"
                />
                <div className="mt-1 text-metadata text-ink-sub">
                  {preview
                    ? `Posts will go out at ${preview.time12} ${preview.ampm}.`
                    : 'Choose a time.'}
                </div>
                {isDuplicate && (
                  <div className="mt-1 text-metadata text-brand-rose">
                    Choose a different time for each posting time.
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 text-body font-medium text-ink">
                  Post types
                </div>
                <div
                  data-testid={`add-page-format-group-${index}`}
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label={`Post types for posting time ${index + 1}`}
                >
                  {ALL_POST_FORMATS.map((format) => {
                    const isSelected =
                      postingTime.allowedFormats.includes(format.id);
                    return (
                      <button
                        key={format.id}
                        type="button"
                        data-testid={`add-page-format-toggle-${index}-${format.id}`}
                        aria-pressed={isSelected}
                        onClick={() => onToggleFormat(index, format.id)}
                        className={cn(
                          'inline-flex min-h-9 items-center rounded-full px-3 text-body font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
                          isSelected
                            ? 'bg-transparent text-link ring-2 ring-link ring-inset'
                            : 'bg-subtle text-ink-sub hover:text-ink'
                        )}
                      >
                        <span>{format.label}</span>
                      </button>
                    );
                  })}
                </div>
                {postingTime.allowedFormats.length === 0 && (
                  <div className="mt-1 text-metadata text-brand-rose">
                    Choose at least one post type.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
