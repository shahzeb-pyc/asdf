/**
 * @file platform-placeholder-accounts.test.tsx
 * @description Behavioural tests for the shared platform accounts shell
 * (Spec 047 placeholder, rebuilt as spec 131 PR-131-5's
 * `PlatformAccountsShell` — audit #12: five duplicate route shells, one
 * shared shell).
 *
 * Migration note (named in PR-131-5): this suite previously rendered the
 * legacy `PlatformPlaceholderAccounts` component through the static-markup
 * helper and asserted its inline-style CSS variables (`var(--bg-panel`,
 * `var(--shadow-card`, `var(--text-sub`). The shell is now built on the
 * shared/ui primitives with token-backed utilities and zero inline
 * styles, so the suite renders the new shell into jsdom and asserts
 * behaviour instead: heading, the exact testing notice, the icon
 * container, the verbatim description fallback, the connect area, and
 * the Return to Overview navigation.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAccountsShell } from '@/components/accounts/platform-accounts-shell';
import {
  InstagramIcon,
  ThreadsIcon,
  XTwitterIcon,
  TikTokIcon,
  YouTubeIcon,
  TESTING_PLACEHOLDER_TEXT,
} from '@/components/workspace/platform-nav-config';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
  }),
}));

const PLATFORMS = [
  { platformName: 'Instagram', icon: <InstagramIcon /> },
  { platformName: 'Threads', icon: <ThreadsIcon /> },
  { platformName: 'X (Twitter)', icon: <XTwitterIcon /> },
  { platformName: 'TikTok', icon: <TikTokIcon /> },
  { platformName: 'YouTube', icon: <YouTubeIcon /> },
];

describe('PlatformAccountsShell (Spec 047 / spec 131 PR-131-5)', () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  it('renders the shell testids, heading and the exact testing placeholder notice', () => {
    const { container } = render(
      <PlatformAccountsShell
        platformName="Instagram"
        subdomain="acme"
        icon={<InstagramIcon />}
      />
    );

    expect(screen.getByTestId('platform-placeholder-accounts')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Instagram Accounts' })
    ).toBeTruthy();
    expect(screen.getByTestId('testing-placeholder-notice').textContent).toBe(
      TESTING_PLACEHOLDER_TEXT
    );
    expect(
      container.querySelector('[data-slot="platform-icon-container"]')
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Return to Overview' })
    ).toBeTruthy();
  });

  it('renders the default description when none is passed', () => {
    render(
      <PlatformAccountsShell
        platformName="Instagram"
        subdomain="acme"
        icon={<InstagramIcon />}
      />
    );

    expect(
      screen.getByText(
        'Instagram integration is currently undergoing testing and verification. Account connectivity and publishing tools for this channel will be enabled once public validation completes.'
      )
    ).toBeTruthy();
  });

  it('renders a verbatim custom description and the connect area', () => {
    render(
      <PlatformAccountsShell
        platformName="Instagram"
        subdomain="acme"
        icon={<InstagramIcon />}
        description="Connect your Instagram account to schedule and publish posts from one place."
        connectArea={
          <a href="/api/connect/instagram" data-testid="instagram-connect-link">
            Connect Instagram
          </a>
        }
      />
    );

    expect(
      screen.getByText(
        'Connect your Instagram account to schedule and publish posts from one place.'
      )
    ).toBeTruthy();
    expect(screen.getByTestId('instagram-connect-link')).toBeTruthy();
  });

  it('Return to Overview navigates to the tenant overview', async () => {
    const user = userEvent.setup();
    render(
      <PlatformAccountsShell
        platformName="Threads"
        subdomain="acme"
        icon={<ThreadsIcon />}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Return to Overview' })
    );
    // The shell navigates via buildTenantHref, which normalizes the
    // empty home path to '/', so the prefixed home carries a trailing
    // slash — the same tenant-overview route as before.
    expect(pushMock).toHaveBeenCalledWith('/tenant/acme/');
  });

  it.each(PLATFORMS)(
    'renders correctly for $platformName',
    ({ platformName, icon }) => {
      const { container } = render(
        <PlatformAccountsShell
          platformName={platformName}
          subdomain="acme"
          icon={icon}
        />
      );

      expect(
        screen.getByRole('heading', { name: `${platformName} Accounts` })
      ).toBeTruthy();
      expect(screen.getByTestId('testing-placeholder-notice').textContent).toBe(
        TESTING_PLACEHOLDER_TEXT
      );
      expect(
        container.querySelector('[data-slot="platform-icon-container"]')
      ).toBeTruthy();
    }
  );
});
