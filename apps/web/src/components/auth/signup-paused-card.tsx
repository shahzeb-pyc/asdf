'use client';

/**
 * SignupPausedCard (spec 136 §5.2) — the paused-registration state,
 * rebuilt on shared/ui primitives + tokens. Behaviour and copy are
 * preserved verbatim: the paused notice, the `Sign in`
 * primary action, and the WhatsApp early-access support action with its
 * prefilled message.
 */

import React from 'react';
import Link from 'next/link';

import { Button } from '@/components/shared/ui/button';
import { cn } from '@/lib/utils';
import { buildWhatsAppSupportUrl } from '@/lib/whatsapp';

export interface SignupPausedCardProps {
  className?: string;
}

export const SignupPausedCard: React.FC<SignupPausedCardProps> = ({ className }) => {
  const whatsAppUrl = buildWhatsAppSupportUrl({
    message: 'Hi! I am inquiring about account registration and early access for FBUploadPro.',
  });

  return (
    <div
      className={cn('flex w-full flex-col gap-6', className)}
      data-testid="signup-paused-card"
    >
      <div className="rounded-md border border-line border-l-4 border-l-primary bg-subtle px-5 py-4">
        <h3 className="mb-1 text-lg font-semibold leading-heading text-ink">
          New registrations are paused for now
        </h3>
        <p className="text-body leading-body text-ink-sub">
          Existing users can
          keep using their workspaces as usual.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Button asChild size="lg" className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>

        {whatsAppUrl && (
          <a
            href={whatsAppUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 items-center justify-center px-3 py-2 text-center text-metadata text-ink-sub no-underline transition-colors hover:text-ink"
          >
            Need early access? Contact support on WhatsApp
          </a>
        )}
      </div>
    </div>
  );
};
