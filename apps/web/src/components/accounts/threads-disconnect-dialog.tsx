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

  // Facebook parity: the dialog shows the real linked count from
  // the list API, never a fixed singular "its destination" — the
  // count is destinations, not pages.
  const destinationsCount = account.connectedDestinationsCount ?? 0;
  const destinationsLabel =
    destinationsCount === 1 ? 'Threads destination' : 'Threads destinations';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-115">
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {account.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This account will no longer be available
          </AlertDialogDescription>
        </AlertDialogHeader>

        {destinationsCount === 0 ? (
          <div
            data-testid="threads-disconnect-zero-destinations-notice"
            className="rounded-sm border border-line bg-subtle p-4 text-body leading-body text-ink-sub"
          >
            <p className="m-0">
              No Threads destinations are linked to this account yet. It&apos;s safe to remove — you can reconnect it any time.
            </p>
          </div>
        ) : (
          <div
            data-testid="threads-disconnect-linked-destinations-warning"
            className="rounded-sm border border-signal-critical/25 bg-signal-critical/10 p-4 text-body leading-body text-ink"
          >
            <p className="m-0 mb-2 font-semibold text-signal-critical-on-tint">
              Before you disconnect
            </p>
            <p className="m-0">
              <strong>
                {destinationsCount} linked {destinationsLabel}
              </strong>{' '}
              will be removed, and any scheduled content on them will be removed as well.
            </p>
          </div>
        )}

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
