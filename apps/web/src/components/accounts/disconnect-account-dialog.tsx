'use client';

/**
 * Disconnect account dialog (spec 131 PR-131-1, spec §8.2) — rebuilt
 * on the shared/ui alert-dialog pattern (UI Rule 3 / UX Rule 13):
 * Radix AlertDialog mechanics (no outside-click/Esc dismissal), focus
 * starts on Cancel, and the confirm button names the verb
 * ("Disconnect Account"). Copy, the linked-pages warning, and
 * testids are preserved verbatim. The confirm is a plain destructive
 * `Button` (not AlertDialogAction) so the dialog stays open while the
 * disconnect is in flight and when it fails — the parent closes it on
 * success, exactly as before.
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
import type { FacebookAccountItem } from './account-card';

interface DisconnectAccountDialogProps {
  account: FacebookAccountItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (accountId: string) => Promise<void>;
  isDisconnecting?: boolean;
  // Audit BG17: a disconnect failure must be visible INSIDE
  // the dialog, which stays open on failure. The old code put
  // the message only in the page-level banner, which sits
  // behind the dialog overlay — invisible until the user
  // cancels and notices it.
  error?: string | null;
}

export function DisconnectAccountDialog({
  account,
  open,
  onOpenChange,
  onConfirm,
  isDisconnecting = false,
  error = null,
}: Readonly<DisconnectAccountDialogProps>) {
  if (!account) return null;

  const handleConfirm = async () => {
    await onConfirm(account.id);
  };

  const pagesCount = account.connectedPagesCount;
  const pagesLabel = pagesCount === 1 ? 'Facebook page' : 'Facebook pages';
  const linkedPages = account.connectedPages ?? [];

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-115">
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {account.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This account and its linked Facebook pages will be removed
            from this app, along with their queued posts and post
            history. Posts already published on Facebook stay on
            Facebook. Disconnecting also asks Facebook to remove this
            app&apos;s access when the account&apos;s token can still
            be used — an expired account has nothing left to revoke,
            so it is removed right away.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {pagesCount === 0 ? (
          <div
            data-testid="disconnect-zero-pages-notice"
            className="rounded-sm border border-line bg-subtle p-4 text-body leading-body text-ink-sub"
          >
            <p className="m-0">
              No Facebook Pages are linked to this account yet. It&apos;s safe to disconnect — you can reconnect it any time.
            </p>
          </div>
        ) : (
          <div
            data-testid="disconnect-linked-pages-warning"
            className="rounded-sm border border-signal-critical/25 bg-signal-critical/10 p-4 text-body leading-body text-ink"
          >
            <p className="m-0 mb-2 font-semibold text-signal-critical-on-tint">
              Before you disconnect
            </p>
            <p className="m-0">
              <strong>{pagesCount} linked {pagesLabel}</strong> will be removed, and their queued posts and post history will be deleted from this app.
            </p>
            {linkedPages.length > 0 && (
              <ul
                data-testid="disconnect-linked-pages-list"
                className="mt-2 mb-0 pl-6 text-ink"
              >
                {linkedPages.map((page) => (
                  <li
                    key={page.id}
                    data-testid={`disconnect-linked-page-${page.id}`}
                    className="mb-0.5"
                  >
                    {page.pageName}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="disconnect-error"
            className="rounded-sm border border-brand-rose/25 bg-brand-rose/10 px-3 py-2 text-body text-brand-rose"
          >
            {error}
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
