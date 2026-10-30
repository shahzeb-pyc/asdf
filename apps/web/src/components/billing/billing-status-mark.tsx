import * as React from 'react';
import { CheckIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Billing status mark, per the owner's standing rule: a tick in a
 * green circle for OK, a cross in a red circle for failed/expired,
 * always with text — never a dot, never colour alone.
 */
export function BillingStatusMark({
  kind,
  label,
}: Readonly<{ kind: 'ok' | 'failed'; label: string }>) {
  const Icon = kind === 'ok' ? CheckIcon : XIcon;
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-1.5 text-metadata">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          kind === 'ok'
            ? 'bg-signal-operational/15 text-signal-operational'
            : 'bg-signal-critical/15 text-signal-critical'
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span
        className={kind === 'ok' ? 'text-signal-operational' : 'text-signal-critical'}
      >
        {label}
      </span>
    </span>
  );
}
