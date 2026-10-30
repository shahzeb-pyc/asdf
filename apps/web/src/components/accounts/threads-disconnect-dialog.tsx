'use client';

/**
 * Threads disconnect dialog — Threads-specific, modelled on the
 * Facebook disconnect dialog's mechanics (Radix AlertDialog, no
 * outside-click/Esc dismissal, focus starts on Cancel, confirm names
 * the verb) but with Threads copy only: no pages warning, because
 * Threads has no pages. The destination note is honest about what
 * disconnect removes: the account and its Threads destination.
 */
import * as React from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Button } from '@/components/shared/ui/button';
import type { ThreadsAccountItem } from './threads-account-card';

interface ThreadsDisconnectDialogProps {
  account: ThreadsAccountItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (accountId: string) => Promise<void>;
  isDisconnecting?: boolean;
}

export function ThreadsDisconnectDialog({
  account,
  open,
  onOpenChange,
  onConfirm,
  isDisconnecting = false,
}: Readonly<ThreadsDisconnectDialogProps>) {
  if (!account) return null;

  const handleConfirm = async () => {
    await onConfirm(account.id);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-115">
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {account.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This account will no longer be available
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div
          data-testid="threads-disconnect-notice"
          className="rounded-sm border border-line bg-subtle p-4 text-body leading-body text-ink-sub"
        >
          <p className="m-0">
            This Threads account and its destination will be removed.
            It&apos;s safe to remove — you can reconnect it any time.
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="threads-disconnect-cancel-btn"
            disabled={isDisconnecting}
          >
            Cancel
          </AlertDialogCancel>

          <Button
            type="button"
            variant="destructive"
            data-testid="threads-disconnect-confirm-btn"
            disabled={isDisconnecting}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {isDisconnecting ? 'Disconnecting...' : 'Disconnect Account'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
