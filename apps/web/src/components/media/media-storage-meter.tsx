'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MediaStorageResponse } from '@fbuploadpro/contracts';

import { api, buildTenantApiPath } from '@/lib/api';
import { MediaStorageResponseSchema } from '@/lib/api/schemas/billing';
import { queryKeys } from '@/lib/data';
import {
  formatStorageGbOneDecimal,
  type MediaStorageDisplay,
} from '@/lib/billing/storage-display';

/**
 * Media Library storage meter (billing storage display). The numbers
 * come from GET billing/storage, which computes them from the SAME
 * quota/usage source as upload enforcement — the meter never counts
 * rows itself, so display and enforcement cannot disagree.
 *
 * Placement: directly under the library header, compact plain text
 * (no box, no new component family). On fetch failure the meter
 * renders nothing — a wrong limit is worse than no meter, and the
 * server gates remain the enforcement backstop.
 */

export function mediaStorageQuery(subdomain: string) {
  return {
    queryKey: [...queryKeys.tenant(subdomain).media.all, 'storage'] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<MediaStorageResponse> =>
      api.get(buildTenantApiPath(subdomain, '/billing/storage'), {
        schema: MediaStorageResponseSchema,
        signal,
      }),
  };
}

export function useMediaStorage(subdomain: string) {
  const definition = mediaStorageQuery(subdomain);
  return useQuery({
    queryKey: definition.queryKey,
    queryFn: definition.queryFn,
  });
}

export function MediaStorageMeter({
  display,
}: Readonly<{ display: MediaStorageDisplay }>) {
  if (display.state === null) return null;

  const used = formatStorageGbOneDecimal(display.usedBytes);
  const total = formatStorageGbOneDecimal(display.quotaBytes);
  const remaining = formatStorageGbOneDecimal(display.remainingBytes);
  const over = formatStorageGbOneDecimal(display.overBytes);

  return (
    <div data-testid="media-storage-meter" className="mb-4 flex flex-col gap-1">
      <p className="text-body text-ink-sub">
        Storage: {used} of {total}
        {display.state === 'over' ? (
          <> · {over} over limit</>
        ) : (
          <> · {remaining} remaining</>
        )}
      </p>
      {display.state === 'near' && (
        <p
          data-testid="media-storage-near-warning"
          className="text-body text-signal-critical"
        >
          You are reaching your storage limit.
        </p>
      )}
      {display.state === 'full' && (
        <p
          data-testid="media-storage-full-message"
          className="text-body text-signal-critical"
        >
          Media Library full — uploads are blocked until you free space.
        </p>
      )}
      {display.state === 'over' && (
        <p
          data-testid="media-storage-readonly-banner"
          className="text-body text-signal-critical"
        >
          Media Library is read-only — remove media to be able to use it again.
        </p>
      )}
    </div>
  );
}
