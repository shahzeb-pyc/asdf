'use client';

/**
 * Instagram App tab — disconnect confirmation (Unified Login).
 *
 * Built on the shared/ui AlertDialog (destructive pattern), mirroring
 * Facebook's dialog: it cannot be dismissed by outside click or Esc,
 * focus starts on "Keep connected", and the confirm action stays open
 * while disconnecting and on failure (the container toasts the
 * failure and closes the dialog only on success).
 *
 * Disconnect removes ONLY the Meta App ID, App Secret and
 * Configuration ID from the workspace; connected accounts and posting
 * continue, and no reconnect or new account is possible until new
 * details are added.
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

export interface InstagramDisconnectDialogProps {
  open: boolean;
  isDisconnecting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

export function InstagramDisconnectDialog({
  open,
  isDisconnecting,
  onOpenChange,
  onConfirm,
}: Readonly<InstagramDisconnectDialogProps>) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        data-testid="instagram-disconnect-modal"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect Instagram?</AlertDialogTitle>
          <AlertDialogDescription>
            Your Meta App ID, App Secret and Configuration ID will be removed from this workspace.
            Your connected accounts and posting will continue to work, but you will not be able to
            reconnect or add new accounts until you add new details.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDisconnecting}>Keep connected</AlertDialogCancel>
          <AlertDialogAction
            disabled={isDisconnecting}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
