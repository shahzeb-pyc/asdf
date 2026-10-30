'use client';

/**
 * Instagram disconnect dialogue — Facebook's `DisconnectAccountDialog`
 * structure exactly (shared/ui AlertDialog, no outside-click/Esc
 * dismissal, focus starts on Cancel, confirm names the verb), with the
 * Instagram analogue in the warning slot: the account's publishing
 * destinations (normally one, the account itself) instead of linked
 * Facebook Pages. Zero destinations → the subtle "safe to remove"
 * notice; N > 0 → the critical "Before you disconnect" warning with
 * the destination list and the scheduled-content consequence. The
 * dialog stays open while disconnecting and on failure; the parent
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

  const destinationCount = account.destinationCount ?? 0;
  const destinationsLabel =
    destinationCount === 1 ? 'Instagram destination' : 'Instagram destinations';
  const destinationLabel =
    account.destinationName ??
    (account.destinationHandle ? `@${account.destinationHandle}` : null);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-115">
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {account.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This account will no longer be available
          </AlertDialogDescription>
        </AlertDialogHeader>

        {destinationCount === 0 ? (
          <div
            data-testid="instagram-disconnect-zero-destinations-notice"
            className="rounded-sm border border-line bg-subtle p-4 text-body leading-body text-ink-sub"
          >
            <p className="m-0">
              No Instagram destination is linked to this account yet. It&apos;s safe to remove — you can reconnect it any time.
            </p>
          </div>
        ) : (
          <div
            data-testid="instagram-disconnect-destinations-warning"
            className="rounded-sm border border-signal-critical/25 bg-signal-critical/10 p-4 text-body leading-body text-ink"
          >
            <p className="m-0 mb-2 font-semibold text-signal-critical-on-tint">
              Before you disconnect
            </p>
            <p className="m-0">
              <strong>{destinationCount} linked {destinationsLabel}</strong> will be removed, and any scheduled content on them will be removed as well.
            </p>
            {destinationLabel && (
              <ul
                data-testid="instagram-disconnect-destinations-list"
                className="mt-2 mb-0 pl-6 text-ink"
              >
                <li
                  data-testid="instagram-disconnect-destination"
                  className="mb-0.5"
                >
                  {destinationLabel}
                </li>
              </ul>
            )}
          </div>
        )}

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
