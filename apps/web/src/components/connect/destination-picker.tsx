'use client';

/**
 * Destination picker (Spec 123, Part C) — rebuilt on the design
 * system (spec 131 PR-131-4): token-backed utilities only, avatar via
 * next/image. Native checkbox/button controls (as in the original)
 * keep this route inside its enforced bundle budget (spec 139 D137-3);
 * the controls carry the token styling + 44px targets directly.
 *
 * Reuses the spec 109 Pages-discovery behaviour from add-page-modal:
 * destinations that share a name are never merged — each row is
 * distinguished by its handle, avatar, and an ID suffix.
 *
 * Modes:
 *  - 'picker': multi-select checkboxes, confirm adds the picked rows.
 *  - 'single-confirm': the one destination is shown as a read-back with a
 *    single confirm button (platforms whose flow yields exactly one).
 */
import React, { useMemo, useState } from 'react';
import Image from 'next/image';

import { getPlatformAccountsPath } from '@fbuploadpro/contracts';
import { formatPageIdSuffix } from '@/components/pages/page-card';
import {
  PLATFORM_LABELS,
  type DiscoveredDestination,
  type Platform,
} from '@/lib/connect/registry';

export type DestinationPickResult =
  | { ok: true; accountsUrl: string }
  | { ok: false; error: string };

/** Confirms the pick with the connect complete route. */
export async function submitDestinationPick(
  platform: Platform,
  subdomain: string,
  destinationIds: string[],
  fetcher: typeof fetch = fetch
): Promise<DestinationPickResult> {
  try {
    const res = await fetcher(`/api/connect/${platform}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationIds }),
    });
    if (!res.ok) {
      return { ok: false, error: "Couldn't save your choices. Please try again." };
    }
    const data = (await res.json()) as { accountsUrl?: string };
    return {
      ok: true,
      // Fallback only when the complete route omits the URL (it does
      // not today): per-platform Accounts page, not Facebook's.
      accountsUrl:
        data.accountsUrl ??
        `/tenant/${subdomain}${getPlatformAccountsPath(platform)}`,
    };
  } catch {
    return { ok: false, error: "Couldn't save your choices. Please try again." };
  }
}

export function confirmButtonLabel(
  isSaving: boolean,
  isSingleConfirm: boolean,
  platformName: string,
  selectedCount: number
): string {
  if (isSaving) return 'Adding…';
  if (isSingleConfirm) return `Add this ${platformName} destination`;
  return `Add selected (${selectedCount})`;
}

interface DestinationRowProps {
  destination: DiscoveredDestination;
  isSingleConfirm: boolean;
  isChecked: boolean;
  isDuplicateName: boolean;
  onToggle: (externalDestinationId: string) => void;
}

function DestinationRow({
  destination,
  isSingleConfirm,
  isChecked,
  isDuplicateName,
  onToggle,
}: Readonly<DestinationRowProps>) {
  const subtitle = destinationSubtitle(destination, isDuplicateName);
  const rowClassName = `flex min-h-11 items-center gap-3 border-b border-line px-3 py-2 ${
    isChecked && !isSingleConfirm ? 'bg-subtle' : ''
  }`;
  const content = (
    <>
      {!isSingleConfirm && (
        <input
          type="checkbox"
          data-testid={`destination-checkbox-${destination.externalDestinationId}`}
          checked={isChecked}
          onChange={() => onToggle(destination.externalDestinationId)}
          aria-label={destination.name}
          className="size-4 shrink-0 cursor-pointer accent-primary"
        />
      )}
      <DestinationAvatar
        name={destination.name}
        avatarUrl={destination.avatarUrl ?? null}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold text-ink">
          {destination.name}
        </div>
        {subtitle && (
          <div className="mt-0.5 text-metadata text-ink-sub">{subtitle}</div>
        )}
      </div>
    </>
  );
  if (isSingleConfirm) {
    return (
      <div
        data-testid={`destination-row-${destination.externalDestinationId}`}
        className={rowClassName}
      >
        {content}
      </div>
    );
  }
  return (
    <label
      data-testid={`destination-row-${destination.externalDestinationId}`}
      className={`${rowClassName} cursor-pointer`}
    >
      {content}
    </label>
  );
}

export interface DestinationPickerProps {
  platform: Platform;
  subdomain: string;
  destinations: DiscoveredDestination[];
  mode: 'picker' | 'single-confirm';
}

/** Names that appear more than once — those rows get an ID suffix line. */
export function findDuplicateDestinationNames(
  destinations: DiscoveredDestination[]
): Set<string> {
  const counts = new Map<string, number>();
  for (const destination of destinations) {
    const key = destination.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) duplicates.add(key);
  }
  return duplicates;
}

function DestinationAvatar({
  name,
  avatarUrl,
}: Readonly<{ name: string; avatarUrl?: string | null }>) {
  if (avatarUrl) {
    return (
      <Image
        src={avatarUrl}
        alt=""
        width={36}
        height={36}
        className="size-9 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-active text-body font-semibold text-ink-sub"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function destinationSubtitle(
  destination: DiscoveredDestination,
  isDuplicateName: boolean
): string {
  const parts: string[] = [];
  if (destination.handle) {
    parts.push(
      destination.handle.startsWith('@')
        ? destination.handle
        : `@${destination.handle}`
    );
  }
  if (isDuplicateName) {
    const suffix = formatPageIdSuffix(destination.externalDestinationId);
    if (suffix) parts.push(`ID ${suffix}`);
  }
  return parts.join(' · ');
}

export function DestinationPicker({
  platform,
  subdomain,
  destinations,
  mode,
}: Readonly<DestinationPickerProps>) {
  const platformName = PLATFORM_LABELS[platform];
  const isSingleConfirm = mode === 'single-confirm';
  const confirmTarget = isSingleConfirm ? destinations.slice(0, 1) : destinations;

  const [selectedIds, setSelectedIds] = useState<string[]>(
    isSingleConfirm
      ? confirmTarget.map((d) => d.externalDestinationId)
      : []
  );
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const duplicateNames = useMemo(
    () => findDuplicateDestinationNames(destinations),
    [destinations]
  );

  const handleToggle = (externalDestinationId: string) => {
    setSelectedIds((prev) =>
      prev.includes(externalDestinationId)
        ? prev.filter((id) => id !== externalDestinationId)
        : [...prev, externalDestinationId]
    );
  };

  const handleConfirm = async () => {
    if (selectedIds.length === 0 || isSaving) return;
    setIsSaving(true);
    setErrorMessage(null);
    const result = await submitDestinationPick(
      platform,
      subdomain,
      selectedIds
    );
    if (result.ok) {
      window.location.assign(result.accountsUrl);
      return;
    }
    setErrorMessage(result.error);
    setIsSaving(false);
  };

  const rows = isSingleConfirm ? confirmTarget : destinations;

  return (
    <div data-testid="destination-picker" className="w-full">
      <div className="flex flex-col border-t border-line">
        {rows.map((destination) => (
          <DestinationRow
            key={destination.externalDestinationId}
            destination={destination}
            isSingleConfirm={isSingleConfirm}
            isChecked={selectedIds.includes(destination.externalDestinationId)}
            isDuplicateName={duplicateNames.has(
              destination.name.trim().toLowerCase()
            )}
            onToggle={handleToggle}
          />
        ))}
      </div>

      {errorMessage && (
        <p
          data-testid="destination-picker-error"
          className="mt-4 mb-0 text-body text-signal-critical"
        >
          {errorMessage}
        </p>
      )}

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          data-testid="destination-picker-confirm-btn"
          disabled={selectedIds.length === 0 || isSaving}
          aria-busy={isSaving || undefined}
          onClick={() => void handleConfirm()}
          className="inline-flex h-11 items-center justify-center rounded-sm bg-primary px-6 text-body font-semibold text-on-primary transition-colors outline-none hover:bg-brand-peru focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:pointer-events-none disabled:opacity-50"
        >
          {confirmButtonLabel(
            isSaving,
            isSingleConfirm,
            platformName,
            selectedIds.length
          )}
        </button>
      </div>
    </div>
  );
}
