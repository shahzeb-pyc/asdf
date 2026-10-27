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
          Daily posting windows and the post types that can go out in each.
        </p>
        <p className="text-metadata text-ink-sub">
          Times shown in <span className="font-semibold text-ink">{activeTimezone}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="schedule-timezone-trigger"
          onClick={onOpenTimezoneModal}
          className="gap-2"
        >
          <span className="text-ink-sub">Timezone:</span>
          <span className="font-semibold">{activeTimezone}</span>
          <span className="text-link underline">Change</span>
        </Button>

        <Button type="button" data-testid="add-slot-button" onClick={onOpenAddModal}>
          <PlusIcon aria-hidden />
          <span>Add Posting Time</span>
        </Button>
      </div>
    </div>
  );
}
