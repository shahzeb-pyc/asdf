'use client';

/**
 * Facebook tab — disconnect confirmation (spec 135 PR-135-2,
 * spec §5.2 / §6.4).
 *
 * Built on the shared/ui AlertDialog (destructive pattern). Decision
 * OD-135-2 = (a), recorded in the PR: the dialog adopts the research
 * pattern — it CANNOT be dismissed by outside click or Esc (the
 * primitive enforces both), focus starts on "Keep connected", and
 * "Keep connected" is the exit. Focus returns to the Disconnect
 * button that opened it when it closes.
 *
 * Disconnect behaviour (Shahzeb's 2026-10-16 decision, preserved
 * exactly): Disconnect removes ONLY the App ID and App Secret from
 * the workspace; access tokens stay intact and posting continues;
 * the user cannot reconnect or connect new accounts until new
 * details are added. The dialog body states that consequence in
 * full, verbatim from §5.2.
 *
 * The confirm action is async: the click's default (Radix's
 * auto-close) is prevented so the dialog stays open while the
 * disconnect runs and stays open if it fails (the failure is toasted
 * by the container); the container closes the dialog on success.
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

export interface FacebookDisconnectDialogProps {
  open: boolean;
  isDisconnecting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

export function FacebookDisconnectDialog({
  open,
  isDisconnecting,
  onOpenChange,
  onConfirm,
}: Readonly<FacebookDisconnectDialogProps>) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        data-testid="fb-disconnect-modal"
        onCloseAutoFocus={(event) => {
          // Return focus to the trigger (the connected view's
          // Disconnect button) — the dialog is opened from container
          // state, so there is no Radix Trigger element to return to.
          event.preventDefault();
          document
            .querySelector<HTMLElement>('[data-testid="fb-disconnect-btn"]')
            ?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle data-testid="fb-disconnect-title">
            Disconnect Facebook?
          </AlertDialogTitle>
          <AlertDialogDescription>
            We&apos;ll remove your App ID and App Secret from this workspace. Your
            connected accounts and posting will keep working, but you
            won&apos;t be able to reconnect or add new accounts until you add new
            details.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="fb-disconnect-keep-btn" disabled={isDisconnecting}>
            Keep connected
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="fb-disconnect-confirm-btn"
            disabled={isDisconnecting}
            onClick={(event) => {
              // Keep the dialog open until the disconnect settles:
              // the container closes it on success and toasts the
              // failure (dialog stays open) otherwise.
              event.preventDefault();
              void onConfirm();
            }}
          >
            {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
