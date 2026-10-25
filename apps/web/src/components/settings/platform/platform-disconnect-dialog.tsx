'use client';

/**
 * Platform credentials — disconnect confirmation (spec 135
 * PR-135-3, spec §5.3/§5.4 / §6.4).
 *
 * Built on the shared/ui AlertDialog (destructive pattern) with
 * exactly the configuration PR-135-2 established for Facebook.
 * Decision OD-135-2 = (a): the dialog adopts the research pattern —
 * it CANNOT be dismissed by outside click or Esc (the primitive
 * enforces both), focus starts on "Keep connected", and "Keep
 * connected" is the exit. Focus returns to the Disconnect button that
 * opened it when it closes.
 *
 * Disconnect behaviour (preserved exactly, per platform): Disconnect
 * removes ONLY this platform's App ID and App Secret from the
 * workspace; access tokens stay intact and posting continues; the
 * user cannot reconnect or connect new accounts until new details are
 * added. The dialog body states that consequence in full, with the
 * platform's labels substituted into the §5.2 sentence.
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

import type { PlatformCredentialsConfig } from './platform-credentials-helpers';

export interface PlatformDisconnectDialogProps {
  config: PlatformCredentialsConfig;
  open: boolean;
  isDisconnecting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

export function PlatformDisconnectDialog({
  config,
  open,
  isDisconnecting,
  onOpenChange,
  onConfirm,
}: Readonly<PlatformDisconnectDialogProps>) {
  const { displayName, appIdLabel, appSecretLabel, testIdPrefix } = config;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        data-testid={`${testIdPrefix}-disconnect-modal`}
        onCloseAutoFocus={(event) => {
          // Return focus to the trigger (the connected view's
          // Disconnect button) — the dialog is opened from container
          // state, so there is no Radix Trigger element to return to.
          event.preventDefault();
          document
            .querySelector<HTMLElement>(`[data-testid="${testIdPrefix}-disconnect-btn"]`)
            ?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle data-testid={`${testIdPrefix}-disconnect-title`}>
            {`Disconnect ${displayName}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {`We'll remove your ${appIdLabel} and ${appSecretLabel} from this workspace. Your connected accounts and posting will keep working, but you won't be able to reconnect or add new accounts until you add new details.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid={`${testIdPrefix}-disconnect-keep-btn`}
            disabled={isDisconnecting}
          >
            Keep connected
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid={`${testIdPrefix}-disconnect-confirm-btn`}
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
