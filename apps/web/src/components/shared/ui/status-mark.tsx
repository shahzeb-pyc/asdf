import * as React from 'react';

import { CheckIcon, CircleIcon, ClockIcon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Shared status mark — icon + text, NEVER a dot. This is the single
 * home for the mark that PageStatusMark (Pages cards) and
 * AccountHealthMark (Accounts cards) used to duplicate: same icon and
 * signal-colour mapping, with the caller supplying its own testid and
 * any surface-specific type tweaks so each consumer's rendered output
 * is unchanged. The shared `StatusDot` primitive is a different
 * component (it renders a coloured dot) and is untouched by this mark.
 */
export type StatusMarkKind = 'operational' | 'queued' | 'critical' | 'idle';

const STATUS_MARK_META = {
  operational: {
    Icon: CheckIcon,
    iconName: 'check',
    textClass: 'text-signal-operational',
  },
  queued: {
    Icon: ClockIcon,
    iconName: 'clock',
    textClass: 'text-signal-queued',
  },
  critical: {
    Icon: XIcon,
    iconName: 'cross',
    textClass: 'text-signal-critical',
  },
  idle: {
    Icon: CircleIcon,
    iconName: 'circle',
    textClass: 'text-signal-idle',
  },
} as const;

export function StatusMark({
  kind,
  label,
  testId,
  className,
  labelClassName,
}: Readonly<{
  kind: StatusMarkKind;
  label: string;
  testId: string;
  className?: string;
  labelClassName?: string;
}>) {
  const meta = STATUS_MARK_META[kind];
  const { Icon } = meta;
  return (
    <span
      data-testid={testId}
      data-status={kind}
      role="status"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1.5 text-metadata',
        meta.textClass,
        className
      )}
    >
      <Icon aria-hidden data-icon={meta.iconName} className="size-3.5 shrink-0" />
      <span className={labelClassName}>{label}</span>
    </span>
  );
}
