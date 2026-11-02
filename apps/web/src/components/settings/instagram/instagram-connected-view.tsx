'use client';

/**
 * Instagram App tab — connected state (Unified Login).
 *
 * Instagram-owned, mirroring Facebook's connected view: the Meta App ID
 * with Copy, the App Secret masked with a Show/Hide toggle (the value
 * is fetched only through the reveal action), the Configuration ID
 * shown with Copy (it is not a secret), and "Edit details" /
 * "Disconnect" actions. The Privacy Policy URL row is deliberately
 * absent here — it appears in the form states only.
 *
 * The app name block renders only when a name was saved; rows that
 * predate verification (or whose name read did not prove out) show
 * the App ID alone, per the locked fallback.
 */

import * as React from 'react';

import { Button } from '@/components/shared/ui/button';

const COPY_FEEDBACK_DURATION_MS = 2000;
const MASKED_SECRET = '••••••••••••••••••••••••';

export function formatInstagramConnectedDate(dateStr?: string | null): string {
  if (!dateStr) return 'Nov 2, 2026';
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return 'Nov 2, 2026';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return 'Nov 2, 2026';
  }
}

export interface InstagramConnectedViewProps {
  appId: string;
  configId: string | null;
  appName?: string | null | undefined;
  connectedAt?: string | null | undefined;
  onRevealSecret: () => Promise<string>;
  onEditDetails: () => void;
  onDisconnectClick: () => void;
}

function CopyRow({
  label,
  value,
  copyLabel,
}: Readonly<{ label: string; value: string; copyLabel: string }>) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    []
  );
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard unavailable: the value is still selectable text.
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">{label}</span>
      <div className="flex items-center justify-between gap-4 border-t border-line py-2.5">
        <span className="font-mono text-body text-ink break-all">{value}</span>
        <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
          {copied ? 'Copied' : copyLabel}
        </Button>
      </div>
    </div>
  );
}

export function InstagramConnectedView({
  appId,
  configId,
  appName,
  connectedAt,
  onRevealSecret,
  onEditDetails,
  onDisconnectClick,
}: Readonly<InstagramConnectedViewProps>) {
  const [showSecret, setShowSecret] = React.useState(false);
  const [revealedSecret, setRevealedSecret] = React.useState<string | null>(null);
  const [isRevealing, setIsRevealing] = React.useState(false);
  const [revealError, setRevealError] = React.useState<string | null>(null);

  const handleToggleSecret = async () => {
    if (showSecret) {
      setShowSecret(false);
      return;
    }
    setIsRevealing(true);
    setRevealError(null);
    try {
      const secret = await onRevealSecret();
      setRevealedSecret(secret);
      setShowSecret(true);
    } catch {
      setRevealError('Your App Secret could not be shown. Please try again.');
    } finally {
      setIsRevealing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {appName && (
        <div className="flex flex-col gap-2">
          <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">App name</span>
          <div className="border-t border-line py-2.5 text-body text-ink">{appName}</div>
        </div>
      )}
      <CopyRow label="Meta App ID" value={appId} copyLabel="Copy App ID" />
      <div className="flex flex-col gap-2">
        <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">App Secret</span>
        <div className="flex items-center justify-between gap-4 border-t border-line py-2.5">
          <span className="font-mono text-body text-ink break-all">
            {showSecret && revealedSecret ? revealedSecret : MASKED_SECRET}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={handleToggleSecret} disabled={isRevealing}>
            {showSecret ? 'Hide' : 'Show'}
          </Button>
        </div>
        <p className="text-body text-ink-sub">Only you can see this — it stays hidden until you choose to show it.</p>
        {revealError && (
          <p role="alert" className="text-body text-signal-critical">{revealError}</p>
        )}
      </div>
      {configId && <CopyRow label="Configuration ID" value={configId} copyLabel="Copy" />}
      <p className="text-body text-ink-sub">This is not a secret. It identifies your configuration.</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onEditDetails}>
          Edit details
        </Button>
        <Button type="button" variant="destructive" onClick={onDisconnectClick}>
          Disconnect
        </Button>
      </div>
      <p className="text-body text-ink-sub">Connected on {formatInstagramConnectedDate(connectedAt)}.</p>
    </div>
  );
}
