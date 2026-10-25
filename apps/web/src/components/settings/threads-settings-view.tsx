'use client';

/**
 * Threads tab — config over the shared platform pattern in
 * `components/settings/platform/` (2026-10-25 redesign: "Threads App").
 *
 * Changes from the pre-redesign tab, all per Shahzeb's decisions on
 * 2026-10-25:
 * - The 5-step setup guide is REMOVED entirely — no guide is shown in
 *   this tab. The Threads pair warning is NOT lost: it survives
 *   verbatim as the App ID helper below ("You'll find this in the
 *   Threads settings of your Meta app — not under Settings →
 *   Basic."), which is the same sentence the guide's step 3 carried.
 * - "One more step" shows ONLY the sign-in callback address. The
 *   deauthorize and data deletion addresses are removed from the UI
 *   only — their backend endpoints
 *   (`api/connect/[platform]/deauthorize`, `api/connect/[platform]/data-deletion`)
 *   are untouched, because Shahzeb has something else in mind for
 *   them later. Do not re-add the UI addresses without his say-so.
 * - The Privacy Policy URL row and the tick/cross status mark come
 *   from the shared platform container, matching Facebook App and
 *   Instagram App.
 */

import React from 'react';
import { PlatformCredentialsView } from '@/components/settings/platform/platform-credentials-view';
import { PlatformSetupCard } from '@/components/settings/platform/platform-setup-card';
import { getPlatformCallbackUrls } from '@/lib/platforms/callback-urls';

export const THREADS_CREDENTIALS_CONFIG = {
  platform: 'threads',
  displayName: 'Threads',
  appIdLabel: 'Threads App ID',
  appSecretLabel: 'Threads App Secret',
  testIdPrefix: 'threads',
  appIdHelper:
    "You'll find this in the Threads settings of your Meta app — not under Settings → Basic.",
} as const;

export interface ThreadsSettingsViewProps {
  subdomain: string;
}

export function ThreadsSettingsView({ subdomain }: Readonly<ThreadsSettingsViewProps>) {
  const urls = getPlatformCallbackUrls('threads');

  return (
    <PlatformCredentialsView
      subdomain={subdomain}
      config={THREADS_CREDENTIALS_CONFIG}
      setupCard={
        <PlatformSetupCard
          testIdPrefix="threads"
          description="Add this address to the Threads settings in your Meta app so Threads can bring you back here after you sign in."
          addresses={[
            {
              key: 'signin',
              label: 'Sign-in callback address',
              url: urls.signInCallback,
              helper:
                'Paste this into the sign-in callback field in the Threads settings of your app.',
            },
          ]}
        />
      }
    />
  );
}
