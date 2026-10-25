'use client';

/**
 * Instagram tab — config + approved guide (spec 135 PR-135-3,
 * spec §5.3 / §8.2).
 *
 * A thin config file over the shared platform pattern in
 * `components/settings/platform/`: the config below and the guide
 * copy are spec 123's approved text, preserved byte-identical (grep
 * proof in the PR) — only the construction changed (tokens/primitives,
 * guide primitives imported from `platform/`). The legacy `initial*`
 * test-seam props are deleted; tests seed through the query client.
 */

import React from 'react';
import { PlatformCredentialsView } from '@/components/settings/platform/platform-credentials-view';
import {
  PlatformSetupCard,
  SettingsGuideStep,
  GuideDivider,
  MetaDashboardLink,
} from '@/components/settings/platform/platform-setup-card';
import { getPlatformCallbackUrls } from '@/lib/platforms/callback-urls';

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

export function InstagramSetupGuide() {
  return (
    <div data-testid="instagram-setup-guide" className="flex flex-col gap-6">
      <SettingsGuideStep number={1} title="Create your Meta app">
        Open your <MetaDashboardLink testIdPrefix="instagram" /> and choose Create app. Give your app a name, add your
        email address if asked, and choose the option for connecting an Instagram account. When
        your app is ready, you will see its home screen.
      </SettingsGuideStep>
      <GuideDivider />
      <SettingsGuideStep number={2} title="Add Instagram to your app">
        On your app&apos;s home screen, find Instagram in the list of things you can add, and
        choose Set up. Instagram will now appear in the left-hand menu of your app.
      </SettingsGuideStep>
      <GuideDivider />
      <SettingsGuideStep number={3} title="Finish the Instagram sign-in setup">
        Choose Instagram from the left-hand menu and open its settings. Complete the sign-in
        setup there — this is what lets people sign in with their Instagram account and connect
        it here. You do not need to change anything else on that screen.
      </SettingsGuideStep>
      <GuideDivider />
      <SettingsGuideStep number={4} title="Add the sign-in address we show">
        Copy the sign-in address in the “One more step” box below and paste it into the Instagram
        sign-in settings, in the field for addresses that can bring people back after they sign
        in. Save your changes in your app before you carry on.
      </SettingsGuideStep>
    </div>
  );
}

export function InstagramSettingsView({ subdomain }: Readonly<InstagramSettingsViewProps>) {
  const urls = getPlatformCallbackUrls('instagram');

  return (
    <PlatformCredentialsView
      subdomain={subdomain}
      config={INSTAGRAM_CREDENTIALS_CONFIG}
      setupCard={
        <PlatformSetupCard
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
    >
      <InstagramSetupGuide />
    </PlatformCredentialsView>
  );
}
