'use client';

/**
 * Threads BYOC configuration prompt — the Threads version of
 * Facebook's ByocConfigPromptModal: same dialog mechanics (shared/ui
 * Dialog, focus trap, Esc, focus return) and same semantics, Threads
 * copy and the Threads settings tab (`?tab=threads`).
 *
 * The shell opens this when a gated user clicks Connect (known-missing
 * Threads App ID/Secret) instead of leaving the button disabled with
 * nowhere to go.
 */
import * as React from 'react';
import Link from 'next/link';
import { MonitorIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';

interface ThreadsByocConfigPromptModalProps {
  subdomain: string;
  open: boolean;
  onClose: () => void;
}

export function ThreadsByocConfigPromptModal({
  subdomain,
  open,
  onClose,
}: Readonly<ThreadsByocConfigPromptModalProps>) {
  const [isNavigating, setIsNavigating] = React.useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-testid="threads-byoc-config-prompt-modal"
        className="sm:max-w-120"
        aria-labelledby="threads-byoc-prompt-title"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-link/10">
              <MonitorIcon className="size-5 text-link" aria-hidden />
            </div>
            <div>
              <DialogTitle id="threads-byoc-prompt-title" data-testid="threads-byoc-prompt-title">
                Threads App Credentials Required
              </DialogTitle>
              <DialogDescription>Workspace configuration needed</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <p data-testid="threads-byoc-prompt-description" className="text-body leading-body text-ink">
          Before connecting Threads accounts, your workspace must configure its Threads App ID and App Secret. This ensures all account authorizations and publishing permissions run directly through your own Meta Developer App.
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="threads-byoc-prompt-cancel-btn"
            onClick={onClose}
          >
            Not Now
          </Button>
          <Button asChild aria-disabled={isNavigating}>
            <Link
              href={`/tenant/${subdomain}/settings?tab=threads`}
              data-testid="threads-byoc-prompt-settings-link"
              onClick={() => {
                setIsNavigating(true);
                onClose();
              }}
              className={isNavigating ? 'pointer-events-none opacity-60' : undefined}
            >
              {isNavigating ? 'Opening settings…' : 'Configure in Settings'}
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
