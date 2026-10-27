'use client';

/**
 * Posting-times header (spec 134 §3.3): the view title, the timezone
 * line — the active zone named as data beside a Change action (UI
 * Rule 6: timezone is data, never a tooltip) — and Add posting time,
 * the view's one primary action (UI Rule 1). Rebuilt clean-room on
 * shared/ui + tokens (spec 129 §1).
 */
import * as React from 'react';
import { PlusIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';

export interface PostingTimesHeaderProps {
  activeTimezone: string;
  onOpenAddModal: () => void;
  onOpenTimezoneModal: () => void;
}

export function PostingTimesHeader({
  activeTimezone,
  onOpenAddModal,
  onOpenTimezoneModal,
}: Readonly<PostingTimesHeaderProps>) {
  return (
    <div
      data-testid="posting-times-header"
      className="flex flex-wrap items-start justify-between gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-xl leading-heading font-bold text-ink">Posting Times</h2>
        <p className="text-body text-ink-sub">
          The times your posts go out each day, and which post types go out at each time.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Timezone line, kept small: metadata size with tight internal
            spacing, so it reads as secondary info next to the Add
            action rather than competing with it. Structure, testid,
            and the gold underlined Change treatment are unchanged.
            The Change button keeps py-2.5 so its box stays a 36px+
            tap target (mobile gate) despite the small text. */}
        <span className="flex items-center gap-1 text-metadata">
          <span className="text-ink-sub">Timezone:</span>
          <span className="font-semibold">{activeTimezone}</span>
          <button
            type="button"
            data-testid="schedule-timezone-trigger"
            onClick={onOpenTimezoneModal}
            className="text-link underline py-2.5"
          >
            Change
          </button>
        </span>

        <Button type="button" data-testid="add-slot-button" onClick={onOpenAddModal}>
          <PlusIcon aria-hidden />
          <span>Add Posting Time</span>
        </Button>
      </div>
    </div>
  );
}
