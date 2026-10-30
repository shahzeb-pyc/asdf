'use client';

/**
 * Instagram disconnect dialogue — mirrors Facebook's
 * `DisconnectAccountDialog` pattern (shared/ui AlertDialog, no
 * outside-click/Esc dismissal, focus starts on Cancel, confirm names
 * the verb) but with Instagram copy and NO linked-pages warning: an
 * Instagram account has no linked pages. The notice states plainly
 * what goes away — the account, its Instagram destination, and any
 * scheduled content on it — and that it can be reconnected any time.
 * The dialog stays open while disconnecting and on failure; the parent
 * closes it on success, exactly as on Facebook.
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
import type { InstagramAccountItem } from './instagram-account-card';

interface InstagramDisconnectDialogProps {
  account: InstagramAccountItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (accountId: string) => Promise<void>;
  isDisconnecting?: boolean;
}

export function InstagramDisconnectDialog({
  account,
  open,
  onOpenChange,
  onConfirm,
  isDisconnecting = false,
}: Readonly<InstagramDisconnectDialogProps>) {
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
          data-testid="instagram-disconnect-notice"
          className="rounded-sm border border-signal-critical/25 bg-signal-critical/10 p-4 text-body leading-body text-ink"
        >
          <p className="m-0">
            Its Instagram destination and any scheduled content on it will be
            removed as well. You can reconnect it any time.
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="disconnect-cancel-btn"
            disabled={isDisconnecting}
          >
            Cancel
          </AlertDialogCancel>

          <Button
            type="button"
            variant="destructive"
            data-testid="disconnect-confirm-btn"
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
