'use client';

/**
 * Instagram tab — config over the shared platform pattern in
 * `components/settings/platform/` (spec 135 PR-135-3, spec §5.3 / §8.2).
 *
 * 2026-10-25 redesign: the tab is renamed "Instagram App" in the tab
 * row (settings-tabs.ts), renders in the shared container's
 * single-column variant (title + description + tick/cross status on
 * top, full-width panel below — never split into side-by-side
 * columns on desktop), and the 4-step "Set up your Meta app" guide is REMOVED
 * entirely — Shahzeb: it does not need to be shown. Threads keeps its
 * own guide; this file no longer passes any guide children to the
 * container, so the container renders the form without a guide. The
 * "One more step" sign-in address is folded into the panel (bare card)
 * in the add/edit states, and the Privacy Policy URL row is shown in
 * both states, built from the workspace subdomain via the shared
 * privacy-url helper.
 */

import React from 'react';
import { PlatformCredentialsView } from '@/components/settings/platform/platform-credentials-view';
import { PlatformSetupCard } from '@/components/settings/platform/platform-setup-card';
import { getPlatformCallbackUrls } from '@/lib/platforms/callback-urls';
import { buildPrivacyPolicyUrl } from '@/lib/privacy-url';

export const INSTAGRAM_CREDENTIALS_CONFIG = {
  platform: 'instagram',
  displayName: 'Instagram',
  appIdLabel: 'Instagram App ID',
  appSecretLabel: 'Instagram App Secret',
  testIdPrefix: 'instagram',
  appIdHelper: "You'll find this in your Meta app under Settings → Basic.",
} as const;

export interface InstagramSettingsViewProps {
  subdomain: string;
}

export function InstagramSettingsView({ subdomain }: Readonly<InstagramSettingsViewProps>) {
  const urls = getPlatformCallbackUrls('instagram');

  return (
    <PlatformCredentialsView
      subdomain={subdomain}
      config={INSTAGRAM_CREDENTIALS_CONFIG}
      privacyUrl={buildPrivacyPolicyUrl(subdomain)}
      setupCard={
        <PlatformSetupCard
          bare
          testIdPrefix="instagram"
          description="Add this address to your Meta app so Instagram can bring you back here after you sign in."
          addresses={[
            {
              key: 'signin',
              label: 'Sign-in address',
              url: urls.signInCallback,
              helper:
                'Paste this into the address field in the Instagram sign-in settings in your Meta app.',
            },
          ]}
        />
      }
    />
  );
}
