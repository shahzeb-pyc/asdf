/**
 * Connect status layout — the terminal-state frame for the Facebook
 * magic-link connect outcomes (spec 136 PR-136D, spec §5.6).
 *
 * Rebuilt on the shared/ui Card primitive + design tokens. Status is
 * presented as colour + icon + text (OD-3 / UX Rule 27): the `variant`
 * prop selects a token-backed status treatment — an icon in a tinted
 * medallion whose shape (check vs. cross) and accessible label carry
 * the meaning even in greyscale — replacing the former raw-alpha tint
 * props, which were literal colour values passed in by each page.
 *
 * The layout's only consumers are the two connect outcome pages
 * (`app/connect/facebook/success` and `app/connect/facebook/error`);
 * ownership sits with spec 136 per plan.md.
 */
import * as React from 'react';
import { CheckIcon, XIcon } from 'lucide-react';

import { Card } from '@/components/shared/ui/card';
import { cn } from '@/lib/utils';

const STATUS_VARIANTS = {
  success: {
    label: 'Success',
    Icon: CheckIcon,
    medallionClass: 'border-brand-emerald bg-brand-emerald/15 text-brand-emerald',
  },
  error: {
    label: 'Error',
    Icon: XIcon,
    medallionClass: 'border-signal-critical bg-signal-critical/15 text-signal-critical',
  },
} as const;

type ConnectStatusVariant = keyof typeof STATUS_VARIANTS;

interface ConnectStatusLayoutProps {
  testId: string;
  variant: ConnectStatusVariant;
  title: string;
  description: string;
  children?: React.ReactNode;
}

export function ConnectStatusLayout({
  testId,
  variant,
  title,
  description,
  children,
}: Readonly<ConnectStatusLayoutProps>) {
  const { label, Icon, medallionClass } = STATUS_VARIANTS[variant];
  return (
    <main className="flex min-h-svh items-center justify-center bg-canvas p-3">
      <Card
        data-testid={testId}
        data-variant={variant}
        className="w-full max-w-110 items-center gap-0 px-6 py-6 text-center"
      >
        <div
          className={cn(
            'mb-4 flex size-12 items-center justify-center rounded-full border',
            medallionClass
          )}
        >
          <Icon className="size-6" strokeWidth={2.5} aria-hidden />
          <span className="sr-only">{label}</span>
        </div>

        <h1 className="mb-2 text-xl leading-heading font-bold text-ink">{title}</h1>

        <p className="mb-6 text-body leading-body text-ink-sub">{description}</p>

        {children}
      </Card>
    </main>
  );
}

export { STATUS_VARIANTS };
export type { ConnectStatusLayoutProps, ConnectStatusVariant };
