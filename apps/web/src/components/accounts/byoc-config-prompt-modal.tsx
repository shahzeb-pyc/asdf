'use client';

/**
 * BYOC configuration prompt (spec 131 PR-131-1, spec §8.2/§8.4) —
 * extracted from the former accounts route and rebuilt on the
 * shared/ui `Dialog` primitive (focus trap, Esc, focus return per
 * UI Rule 18; the hand-rolled backdrop/container is deleted).
 * Heading, body copy, and actions are preserved verbatim (spec §6.3);
 * testids are preserved for the parity suites.
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

interface ByocConfigPromptModalProps {
  subdomain: string;
  open: boolean;
  onClose: () => void;
}

export function ByocConfigPromptModal({
  subdomain,
  open,
  onClose,
}: Readonly<ByocConfigPromptModalProps>) {
  const [isNavigating, setIsNavigating] = React.useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-testid="byoc-config-prompt-modal"
        className="sm:max-w-120"
        aria-labelledby="byoc-prompt-title"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-link/10">
              <MonitorIcon className="size-5 text-link" aria-hidden />
            </div>
            <div>
              <DialogTitle id="byoc-prompt-title" data-testid="byoc-prompt-title">
                Facebook App Credentials Required
              </DialogTitle>
              <DialogDescription>Workspace configuration needed</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <p data-testid="byoc-prompt-description" className="text-body leading-body text-ink">
          Before connecting Facebook accounts, your workspace must configure its Facebook App ID and App Secret. This ensures all account authorizations and publishing permissions run directly through your own Meta Developer App.
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="byoc-prompt-cancel-btn"
            onClick={onClose}
          >
            Not Now
          </Button>
          <Button asChild aria-disabled={isNavigating}>
            <Link
              href={`/tenant/${subdomain}/settings?tab=byoc`}
              data-testid="byoc-prompt-settings-link"
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
