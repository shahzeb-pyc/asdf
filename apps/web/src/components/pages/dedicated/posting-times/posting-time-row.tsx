'use client';

/**
 * One posting-time slot row (spec 134 §3.3): the time in the single
 * consistent 12-hour format via the shared formatter, its timezone
 * label beside it (UI Rule 6), the slot's status as colour + icon +
 * text (OD-3 research pattern), format coverage in plain words under
 * the "Post types" label (spec 106 copy), an immediate-effect Switch
 * for active (matrix §14), Edit, and Remove. Rebuilt clean-room on
 * shared/ui + tokens — layout separates with hairline dividers and
 * spacing, no box-in-box (UI Rule 13).
 */
import * as React from 'react';
import { Button } from '@/components/shared/ui/button';
import { Switch } from '@/components/shared/ui/switch';
import { PageStatusMark } from '../../page-card';
import type { PageSlotSummary } from '../tab-dashboard';
import {
  ALL_POST_FORMATS,
  formatSlotDisplay,
  resolveFormatLabel,
} from './posting-time-utils';

export interface PostingTimeRowProps {
  slot: PageSlotSummary;
  isToggling: boolean;
  onToggle: (slot: PageSlotSummary) => void;
  onEdit: (slot: PageSlotSummary) => void;
  onRemove: (slot: PageSlotSummary) => void;
}

export function PostingTimeRow({
  slot,
  isToggling,
  onToggle,
  onEdit,
  onRemove,
}: Readonly<PostingTimeRowProps>) {
  const formatted = formatSlotDisplay(slot.slotTime);
  const formats =
    slot.allowedFormats && slot.allowedFormats.length > 0
      ? slot.allowedFormats
      : ALL_POST_FORMATS.map((format) => format.id);
  const isAllFormats = formats.length >= ALL_POST_FORMATS.length;

  return (
    <div
      data-testid={`posting-time-row-${slot.id}`}
      className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-2 py-4 last:border-b-0 sm:px-4"
    >
      {/* Time + status + timezone label. The mark is the shared
          header mark (tick/clock, never a dot); an inactive slot only
          stops future scheduling — already-queued posts still go out
          at their scheduled time, so the label says so. */}
      <div className="flex min-w-44 flex-wrap items-center gap-3">
        <PageStatusMark
          status={slot.isActive ? 'active' : 'paused'}
          label={slot.isActive ? 'Active' : 'Paused for new posts'}
        />
        <div className="flex items-baseline gap-1">
          <span
            className={
              slot.isActive
                ? 'text-xl font-bold tracking-tight text-ink tabular-nums'
                : 'text-xl font-bold tracking-tight text-ink-dim tabular-nums'
            }
          >
            {formatted.time12}
          </span>
          <span
            className={
              slot.isActive
                ? 'text-body font-semibold text-ink-sub'
                : 'text-body font-semibold text-ink-dim'
            }
          >
            {formatted.ampm}
          </span>
          <span className="text-metadata text-ink-dim">{slot.timezone}</span>
        </div>
      </div>

      {/* Format coverage in plain words */}
      <div
        data-testid={`slot-format-container-${slot.id}`}
        className="flex flex-1 basis-64 flex-wrap items-center gap-1.5"
      >
        <span className="text-body text-ink-sub">Post types:</span>
        {isAllFormats ? (
          <span
            data-testid={`slot-format-badge-all-${slot.id}`}
            className="text-body font-medium text-ink"
          >
            All post types
          </span>
        ) : (
          formats.map((fmt, index) => (
            <span key={fmt} className="inline-flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden className="text-ink-dim">
                  ·
                </span>
              )}
              <span
                data-testid={`slot-format-badge-${slot.id}-${fmt}`}
                className="text-body font-medium text-ink"
              >
                {resolveFormatLabel(fmt)}
              </span>
            </span>
          ))
        )}
      </div>

      {/* Controls: Edit, immediate-effect Switch, Remove */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`edit-slot-btn-${slot.id}`}
          onClick={() => onEdit(slot)}
          className="min-h-11 px-3 sm:min-h-8"
        >
          Edit
        </Button>

        <Switch
          data-testid={`toggle-slot-btn-${slot.id}`}
          aria-label={slot.isActive ? 'Pause posting time' : 'Activate posting time'}
          checked={slot.isActive}
          disabled={isToggling}
          onCheckedChange={() => onToggle(slot)}
        />

        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={`delete-slot-btn-${slot.id}`}
          onClick={() => onRemove(slot)}
          className="min-h-11 px-3 text-ink-dim hover:text-signal-critical sm:min-h-8"
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
