'use client';

/**
 * Timezone-change flow, step 1 (spec 134 §3.3): search + grouped
 * timezone directory with the current zone named in a banner. Rebuilt
 * clean-room on shared/ui + tokens from the legacy two-step flow's
 * behaviour (spec 106): grouped by region, current zone marked,
 * proceeding is disabled while the selection equals the active zone.
 */
import * as React from 'react';
import { SearchIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { DialogFooter } from '@/components/shared/ui/dialog';
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

export interface TimezoneSelectorStepProps {
  activeTimezone: string;
  selectedTimezone: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectTimezone: (iana: string) => void;
  onCancel: () => void;
  onProceed: () => void;
}

export function TimezoneSelectorStep({
  activeTimezone,
  selectedTimezone,
  searchQuery,
  onSearchChange,
  onSelectTimezone,
  onCancel,
  onProceed,
}: Readonly<TimezoneSelectorStepProps>) {
  const grouped = React.useMemo(() => searchAndGroupTimezones(searchQuery), [searchQuery]);
  const activeEntry = React.useMemo(() => findTimezoneEntry(activeTimezone), [activeTimezone]);
  const activeOffset = React.useMemo(() => getTimezoneUtcOffset(activeTimezone), [activeTimezone]);
  const activeLocalTime = React.useMemo(
    () => getTimezoneCurrentTime(activeTimezone),
    [activeTimezone]
  );
  const hasMatches = React.useMemo(
    () => REGION_ORDER.some((region) => grouped[region].length > 0),
    [grouped]
  );
  const isSameAsActive = selectedTimezone === activeTimezone;

  return (
    <div className="flex flex-col gap-4">
      {/* Current timezone banner */}
      <div
        data-testid="current-timezone-banner"
        className="flex items-center justify-between gap-3 border-b border-line pb-3"
      >
        <div className="flex items-center gap-2">
          <div className="flex flex-col">
            <span className="text-metadata font-semibold tracking-wide text-ink-dim uppercase">
              Current timezone
            </span>
            <span className="text-body font-medium text-ink">
              {activeEntry.city} · {activeEntry.country} ({activeOffset})
            </span>
          </div>
        </div>
        {activeLocalTime ? (
          <span className="text-body text-ink-sub tabular-nums">{activeLocalTime}</span>
        ) : null}
      </div>

      {/* Search */}
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub"
        />
        <Input
          type="text"
          autoFocus
          data-testid="timezone-search-input"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by city, country, or region..."
          aria-label="Search Timezones"
          className="pl-9"
        />
      </div>

      {/* Grouped directory */}
      <div data-testid="timezone-list-container" className="max-h-72 overflow-y-auto">
        {!hasMatches ? (
          <div
            data-testid="timezone-no-matches"
            className="px-4 py-6 text-center text-body text-ink-sub"
          >
            No timezones matching &ldquo;{searchQuery}&rdquo;.
          </div>
        ) : (
          REGION_ORDER.map((region) => {
            const entries = grouped[region];
            if (entries.length === 0) return null;
            return (
              <div key={region} data-testid={`timezone-region-group-${region}`} className="mb-2">
                <div className="px-2 py-1 text-metadata font-semibold tracking-wide text-ink-dim uppercase">
                  {REGION_LABELS[region]}
                </div>
                {entries.map((entry) => {
                  const isSelected = selectedTimezone === entry.iana;
                  const isCurrent = activeTimezone === entry.iana;
                  return (
                    <button
                      key={entry.iana}
                      type="button"
                      data-testid={`timezone-option-${entry.iana}`}
                      aria-pressed={isSelected}
                      onClick={() => onSelectTimezone(entry.iana)}
                      className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-line px-2 py-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
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
                            {isCurrent ? (
                              <span className="ml-1 text-metadata text-link">
                                (Current)
                              </span>
                            ) : null}
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
          })
        )}
      </div>

      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="proceed-to-step2-button"
          disabled={isSameAsActive}
          {...(isSameAsActive
            ? { disabledReason: 'Choose a different timezone to continue.' }
            : {})}
          onClick={onProceed}
        >
          Review change
        </Button>
      </DialogFooter>
    </div>
  );
}
