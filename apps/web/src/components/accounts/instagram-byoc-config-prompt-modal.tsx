'use client';

/**
 * Instagram BYOC configuration prompt — Facebook's
 * `ByocConfigPromptModal` structure exactly (shared/ui `Dialog`,
 * focus trap, Esc, focus return), with Instagram copy and the Instagram
 * App settings link (`?tab=instagram`).
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

interface InstagramByocConfigPromptModalProps {
  subdomain: string;
  open: boolean;
  onClose: () => void;
}

export function InstagramByocConfigPromptModal({
  subdomain,
  open,
  onClose,
}: Readonly<InstagramByocConfigPromptModalProps>) {
  const [isNavigating, setIsNavigating] = React.useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-testid="instagram-byoc-config-prompt-modal"
        className="sm:max-w-120"
        aria-labelledby="instagram-byoc-prompt-title"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-link/10">
              <MonitorIcon className="size-5 text-link" aria-hidden />
            </div>
            <div>
              <DialogTitle id="instagram-byoc-prompt-title" data-testid="instagram-byoc-prompt-title">
                Instagram App Credentials Required
              </DialogTitle>
              <DialogDescription>Workspace configuration needed</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <p data-testid="instagram-byoc-prompt-description" className="text-body leading-body text-ink">
          Before connecting Instagram accounts, your workspace must configure its Instagram App ID and App Secret. This ensures all account authorizations and publishing permissions run directly through your own Meta Developer App.
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="instagram-byoc-prompt-cancel-btn"
            onClick={onClose}
          >
            Not Now
          </Button>
          <Button asChild aria-disabled={isNavigating}>
            <Link
              href={`/tenant/${subdomain}/settings?tab=instagram`}
              data-testid="instagram-byoc-prompt-settings-link"
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
