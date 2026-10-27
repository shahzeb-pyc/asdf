'use client';

/**
 * Timezone-change flow, step 2: review the impact before applying —
 * current vs new zone, the preserved clock-time behaviour, and the
 * counts of active posting times and queued posts. Under
 * publisher-driven scheduling nothing is realigned: queued posts
 * store no times, so the times simply fire in the new zone and the
 * queue estimates update with it.
 */
import * as React from 'react';
import { ArrowRightIcon, CheckIcon, InfoIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { DialogFooter } from '@/components/shared/ui/dialog';
import {
  findTimezoneEntry,
  getTimezoneUtcOffset,
} from '@/lib/timezones';

export interface TimezoneReviewStepProps {
  activeTimezone: string;
  selectedTimezone: string;
  slotsCount: number;
  queuedCount: number;
  isSubmitting: boolean;
  errorMessage: string | null;
  onBack: () => void;
  onConfirm: () => void;
}

export function TimezoneReviewStep({
  activeTimezone,
  selectedTimezone,
  slotsCount,
  queuedCount,
  isSubmitting,
  errorMessage,
  onBack,
  onConfirm,
}: Readonly<TimezoneReviewStepProps>) {
  const currentEntry = React.useMemo(() => findTimezoneEntry(activeTimezone), [activeTimezone]);
  const newEntry = React.useMemo(() => findTimezoneEntry(selectedTimezone), [selectedTimezone]);
  const currentOffset = React.useMemo(() => getTimezoneUtcOffset(activeTimezone), [activeTimezone]);
  const newOffset = React.useMemo(
    () => getTimezoneUtcOffset(selectedTimezone),
    [selectedTimezone]
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-metadata font-semibold tracking-wide text-brand-gold uppercase">
        Step 2 of 2: Review this change
      </p>

      {/* Transition preview */}
      <div
        data-testid="timezone-transition-card"
        className="flex items-center gap-2 border-b border-line pb-4"
      >
        <div className="flex flex-1 flex-col">
          <span className="text-metadata font-semibold tracking-wide text-ink-dim uppercase">
            Current timezone
          </span>
          <span className="text-body font-semibold text-ink">{currentEntry.city}</span>
          <span className="text-metadata text-ink-sub">
            {currentOffset} · {activeTimezone}
          </span>
        </div>
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-full bg-hover text-brand-gold"
        >
          <ArrowRightIcon className="size-3.5" />
        </span>
        <div className="flex flex-1 flex-col">
          <span className="text-metadata font-semibold tracking-wide text-brand-gold uppercase">
            New timezone
          </span>
          <span className="text-body font-semibold text-ink">{newEntry.city}</span>
          <span className="text-metadata text-ink-sub">
            {newOffset} · {selectedTimezone}
          </span>
        </div>
      </div>

      {/* Impact explanation */}
      <div className="flex flex-col gap-2 py-2 text-body leading-relaxed text-ink-sub">
        <div className="flex items-start gap-2">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-gold" />
          <p>
            <strong className="text-ink">Clock times stay the same:</strong> Your posting times
            will still go out at their exact clock times in the new timezone. For example, a
            10:00 AM posting time will now go out at 10:00 AM {newEntry.city} time.
          </p>
        </div>
        <div className="flex items-start gap-2">
          <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-gold" />
          <p>
            <strong className="text-ink">No post times change:</strong> Queued posts
            have no fixed time — they go out at your posting times, in queue order. Changing
            the timezone only changes when those times happen, and the queue&apos;s estimated
            dates update with it.
          </p>
        </div>
      </div>

      {/* Impact numbers. Callers pass active slots only (inactive
          slots schedule nothing) and all queued posts — nothing is
          realigned, so the queued number is context, not a
          realignment count. */}
      <div data-testid="timezone-impact-metrics" className="grid grid-cols-2 gap-4">
        <div className="flex flex-col py-1">
          <div className="text-metadata font-semibold tracking-wide text-ink-dim uppercase">
            Posting times
          </div>
          <div data-testid="timezone-metric-slots" className="mt-0.5 text-lg font-bold text-ink">
            {slotsCount}
          </div>
          <div className="text-metadata text-ink-sub">Active posting times</div>
        </div>
        <div className="flex flex-col py-1">
          <div className="text-metadata font-semibold tracking-wide text-ink-dim uppercase">
            Queued posts
          </div>
          <div data-testid="timezone-metric-queued" className="mt-0.5 text-lg font-bold text-ink">
            {queuedCount}
          </div>
          <div className="text-metadata text-ink-sub">Estimates update with the new timezone</div>
        </div>
      </div>

      {errorMessage ? (
        <div
          data-testid="timezone-update-error"
          role="alert"
          className="rounded-sm border border-brand-rose bg-panel px-3 py-2 text-body text-brand-rose"
        >
          {errorMessage}
        </div>
      ) : null}

      <DialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="outline"
          data-testid="back-to-step1-button"
          disabled={isSubmitting}
          onClick={onBack}
        >
          Back
        </Button>
        <Button
          type="button"
          data-testid="confirm-timezone-update-button"
          loading={isSubmitting}
          onClick={onConfirm}
        >
          {isSubmitting ? 'Updating…' : 'Update timezone'}
        </Button>
      </DialogFooter>
    </div>
  );
}
