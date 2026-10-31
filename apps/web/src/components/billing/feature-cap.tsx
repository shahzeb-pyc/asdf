'use client';

/**
 * Feature-section cap display (Facebook / Instagram / Threads).
 *
 * Reads the billing entitlement endpoint — the same source the
 * server gates enforce — so the numbers shown are the numbers the
 * add endpoints enforce: `used` counts destinations registered
 * against the plan, `allowed` is the purchased count, and
 * `remaining` is what is left. The display renders only for an
 * active paid plan: while loading, on error, for Free/expired
 * users, and for admins (who are never capped) it renders nothing,
 * so it can never flash a wrong number. Freshness comes from
 * `staleTime: 0` plus the app's window-focus refetch — returning to
 * a list re-reads the entitlement; no polling.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  EntitlementResponseSchema,
  type SubscriptionPlatform,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath } from '@/lib/api';
import { queryKeys } from '@/lib/data';

export interface FeatureCap {
  used: number;
  allowed: number;
  remaining: number;
  atCap: boolean;
}

type CapPlatform = Extract<SubscriptionPlatform, 'facebook' | 'instagram' | 'threads'>;

export function useFeatureCap(
  subdomain: string,
  platform: CapPlatform
): { cap: FeatureCap | null; isLoading: boolean } {
  const query = useQuery({
    queryKey: queryKeys.tenant(subdomain).billing.entitlement,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/billing/entitlement'), {
        schema: EntitlementResponseSchema,
        signal,
      }),
    staleTime: 0,
  });
  const data = query.data;
  const cap = React.useMemo<FeatureCap | null>(() => {
    if (!data || data.plan !== 'paid' || !data.active) return null;
    const used = data.usage[platform];
    const allowed = data.counts[platform];
    const remaining = Math.max(0, allowed - used);
    return { used, allowed, remaining, atCap: remaining === 0 };
  }, [data, platform]);
  return { cap, isLoading: query.isPending };
}

export function FeatureCapText({
  cap,
  platform,
}: Readonly<{ cap: FeatureCap; platform: CapPlatform }>) {
  const noun = platform === 'facebook' ? 'pages' : 'accounts';
  const text = cap.atCap
    ? `${cap.used} of ${cap.allowed} ${noun} connected · Limit reached`
    : `${cap.used} of ${cap.allowed} ${noun} connected · ${cap.remaining} remaining`;
  return (
    <p data-testid="feature-cap-text" className="m-0 text-body text-ink-dim">
      {text}
    </p>
  );
}
