'use client';

/**
 * Posting-times tab orchestrator (spec 134 §3.3) — composition only:
 * header, loading skeleton at final geometry, the typed empty state,
 * the slot rows, and the three closed-by-default dialogs (add/edit
 * form, delete confirm, timezone flow) loaded via next/dynamic so a
 * closed surface ships none of their code (spec 137 §4.1 duty 5).
 *
 * Behaviour preserved from specs 105/106/112 (§5.1): slot CRUD +
 * toggle through the route's callbacks, the Edit fallback of
 * delete + re-add when no update callback is provided, and the
 * timezone change applying through `onUpdateTimezone` when present.
 * Data still arrives via the section route's props (131 owns the
 * route); this panel holds no copy of server slot data beyond the
 * route-provided props it renders.
 */
import * as React from 'react';
import dynamic from 'next/dynamic';

import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Skeleton } from '@/components/shared/ui/skeleton';
import type { FacebookPageItem } from '../../page-card';
import type { PageSlotSummary } from '../tab-dashboard';
import { PostingTimeRow } from './posting-time-row';
import { PostingTimesEmptyState } from './posting-times-empty-state';
import { PostingTimesHeader } from './posting-times-header';

const PostingTimeForm = dynamic(
  () => import('./posting-time-form').then((m) => ({ default: m.PostingTimeForm })),
  { ssr: false }
);
const DeleteSlotConfirm = dynamic(
  () => import('./delete-slot-confirm').then((m) => ({ default: m.DeleteSlotConfirm })),
  { ssr: false }
);
const ScheduleTimezoneModal = dynamic(
  () =>
    import('./timezone/schedule-timezone-modal').then((m) => ({
      default: m.ScheduleTimezoneModal,
    })),
  { ssr: false }
);

export interface PageTabPostingTimesProps {
  /**
   * Only the timezone is read (the active-zone resolution below) — the
   * prop is the Pick it always behaved as, so the unified destination
   * panel (spec 134 PR-134-3) can drive this same orchestrator with a
   * destination's timezone instead of a fabricated Page row. One
   * posting-times implementation, two data adapters (spec §3.3).
   */
  page: Pick<FacebookPageItem, 'timezone'>;
  slots: PageSlotSummary[];
  isLoading?: boolean;
  /**
   * R4: the slots fetch failed. An empty `slots` array then means
   * "unknown", never "no posting times": the first-use empty state
   * must not render, and no unmatched warnings may be derived from
   * the failed fetch. Shows an error state with Retry instead.
   */
  slotsError?: boolean;
  /** Re-runs the shell's slots fetch. */
  onRetrySlots?: () => void;
  /**
   * All queued posts. Under publisher-driven scheduling there are no
   * slot links and no stored times to realign — the timezone review
   * shows this count with copy saying estimates update, not that
   * posts are realigned.
   */
  queuedCount?: number;
  onAddSlot: (data: {
    slotTime: string;
    timezone: string;
    allowedFormats?: string[];
  }) => Promise<void>;
  onUpdateSlot?: (
    slotId: string,
    data: {
      slotTime?: string;
      timezone?: string;
      isActive?: boolean;
      allowedFormats?: string[];
    }
  ) => Promise<void>;
  onUpdateTimezone?: (newTimezone: string) => Promise<void>;
  onToggleSlot: (slotId: string, isActive: boolean) => Promise<void>;
  onDeleteSlot: (slotId: string) => Promise<void>;
}

export function PageTabPostingTimes({
  page,
  slots,
  isLoading = false,
  slotsError = false,
  onRetrySlots,
  queuedCount = 0,
  onAddSlot,
  onUpdateSlot,
  onUpdateTimezone,
  onToggleSlot,
  onDeleteSlot,
}: Readonly<PageTabPostingTimesProps>) {
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [isTimezoneModalOpen, setIsTimezoneModalOpen] = React.useState(false);
  const [editingSlot, setEditingSlot] = React.useState<PageSlotSummary | null>(null);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);
  const [slotToDelete, setSlotToDelete] = React.useState<PageSlotSummary | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [fallbackTimezone, setFallbackTimezone] = React.useState('UTC');

  const activeTimezone = page.timezone || slots[0]?.timezone || fallbackTimezone;

  const handleTimezoneChange = async (newTz: string) => {
    setFallbackTimezone(newTz);
    if (onUpdateTimezone) {
      await onUpdateTimezone(newTz);
    }
  };

  const handleToggle = (slot: PageSlotSummary) => {
    setTogglingId(slot.id);
    // Fire-and-forget (the row calls this from onCheckedChange and
    // never awaits it). A rejecting handler must not leak an
    // unhandled rejection, so both outcomes reset the toggling state
    // here; failure presentation belongs to the caller — in production
    // the shell mutation rolls back the optimistic switch and shows
    // the error toast.
    void onToggleSlot(slot.id, !slot.isActive).then(
      () => setTogglingId(null),
      () => setTogglingId(null),
    );
  };

  const handleOpenAdd = () => {
    setEditingSlot(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (slot: PageSlotSummary) => {
    setEditingSlot(slot);
    setIsModalOpen(true);
  };

  const handleSaveModal = async (data: {
    slotTime: string;
    timezone: string;
    allowedFormats: string[];
  }) => {
    if (editingSlot) {
      if (onUpdateSlot) {
        await onUpdateSlot(editingSlot.id, data);
      } else {
        await onDeleteSlot(editingSlot.id);
        await onAddSlot(data);
      }
    } else {
      await onAddSlot(data);
    }
  };

  const handleConfirmDelete = async () => {
    if (!slotToDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteSlot(slotToDelete.id);
      setSlotToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div data-testid="page-tab-calendar" className="flex flex-col gap-6">
      <PostingTimesHeader
        activeTimezone={activeTimezone}
        onOpenAddModal={handleOpenAdd}
        onOpenTimezoneModal={() => setIsTimezoneModalOpen(true)}
      />

      {isLoading && (
        <div data-testid="calendar-loading" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading posting times...</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!isLoading && slotsError && (
        <Banner
          variant="critical"
          title="Couldn't load posting times"
          description="Your posting times are unavailable until they load again — this does not mean you have none."
          action={
            onRetrySlots ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetrySlots}>
                Retry
              </Button>
            ) : undefined
          }
        />
      )}

      {!isLoading && !slotsError && slots.length === 0 && (
        <PostingTimesEmptyState onOpenAddModal={handleOpenAdd} />
      )}

      {!isLoading && !slotsError && slots.length > 0 && (
        <div data-testid="slots-grid" className="flex flex-col">
          {slots.map((slot) => (
            <PostingTimeRow
              key={slot.id}
              slot={slot}
              isToggling={togglingId === slot.id}
              onToggle={handleToggle}
              onEdit={handleOpenEdit}
              onRemove={setSlotToDelete}
            />
          ))}
        </div>
      )}

      {/* Add / Edit form. Mounted only while open and keyed by the slot
          being edited, so its form state initializes fresh from the
          target slot on every open (spec 112 #19). */}
      {isModalOpen && (
        <PostingTimeForm
          key={editingSlot?.id ?? 'add'}
          activeTimezone={activeTimezone}
          slotToEdit={editingSlot}
          onClose={() => setIsModalOpen(false)}
          onSave={handleSaveModal}
        />
      )}

      {slotToDelete && (
        <DeleteSlotConfirm
          slotToDelete={slotToDelete}
          isDeleting={isDeleting}
          onClose={() => setSlotToDelete(null)}
          onConfirmDelete={handleConfirmDelete}
        />
      )}

      <ScheduleTimezoneModal
        isOpen={isTimezoneModalOpen}
        activeTimezone={activeTimezone}
        // Review metrics: active slots only (inactive slots schedule
        // nothing), and all queued posts (no slot links exist under
        // publisher-driven scheduling — nothing is realigned).
        slotsCount={slots.filter((slot) => slot.isActive).length}
        queuedCount={queuedCount}
        onClose={() => setIsTimezoneModalOpen(false)}
        onConfirmTimezone={handleTimezoneChange}
      />
    </div>
  );
}
