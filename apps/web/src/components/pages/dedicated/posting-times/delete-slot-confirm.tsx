'use client';

/**
 * Delete posting-time confirmation (spec 134 §3.3) on the shared/ui
 * AlertDialog pattern (UI Rule 3): verb-named confirm ("Delete posting
 * time" / "Remove Time"), focus starts on Cancel, and no outside-click
 * or Esc dismissal — Radix AlertDialog mechanics provide all three.
 * Copy preserved from the legacy surface (spec §5.1).
 */
import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import type { PageSlotSummary } from '../tab-dashboard';
import { formatSlotDisplay } from './posting-time-utils';

export interface DeleteSlotConfirmProps {
  slotToDelete: PageSlotSummary | null;
  isDeleting: boolean;
  onClose: () => void;
  onConfirmDelete: () => Promise<void>;
}

export function DeleteSlotConfirm({
  slotToDelete,
  isDeleting,
  onClose,
  onConfirmDelete,
}: Readonly<DeleteSlotConfirmProps>) {
  if (!slotToDelete) return null;
  const formatted = formatSlotDisplay(slotToDelete.slotTime);

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent data-testid="delete-posting-time-modal" className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove Posting Time?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to remove the daily {formatted.time12} {formatted.ampm} posting
            window? Nothing queued is cancelled, and no post keeps this time: queued posts flow
            through your remaining posting times, in queue order. If no posting time remains,
            they wait in the queue until you add one — and adding a time later speeds the queue
            up again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="confirm-delete-slot-btn"
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              void onConfirmDelete();
            }}
          >
            {isDeleting ? 'Removing...' : 'Remove Time'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
