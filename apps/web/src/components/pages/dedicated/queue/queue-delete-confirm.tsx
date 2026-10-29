'use client';

/**
 * Delete confirmation for a queued post (standing rule for destructive
 * actions): verb-named confirm, focus starts on Cancel, no
 * outside-click or Esc dismissal — Radix AlertDialog mechanics
 * provide all three.
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
import type { QueueItem } from '@/lib/api/schemas/queue';

export interface QueueDeleteConfirmProps {
  item: QueueItem | null;
  isDeleting: boolean;
  onClose: () => void;
  onConfirmDelete: () => Promise<void>;
}

export function QueueDeleteConfirm({
  item,
  isDeleting,
  onClose,
  onConfirmDelete,
}: Readonly<QueueDeleteConfirmProps>) {
  if (!item) return null;
  const preview = item.caption.trim().slice(0, 120);

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent data-testid="queue-delete-confirm" className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete post?</AlertDialogTitle>
          <AlertDialogDescription>
            This post will be removed from the queue and will not go out.
            {preview ? ` “${preview}”` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="queue-delete-confirm-btn"
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              void onConfirmDelete();
            }}
          >
            {isDeleting ? 'Deleting...' : 'Delete post'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
