/**
 * Settings shell — behavioural tests (spec 135 PR-135-1, T6).
 *
 * The shell island (settings-shell.tsx) owns: the deep-link contract
 * (§5.6 as amended 2026-10-25 — the 4 tab ids, the legacy `byoc` → facebook alias,
 * unknown/missing → general, `settings-tab-<id>` testids), the
 * shared/ui Tabs keyboard pattern, and URL ↔ tab sync via
 * `router.replace`. The per-tab views are stubbed here — each view's
 * own suite covers its panel; this suite proves the shell around
 * them.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const replace = vi.fn();
let searchParamsValue = new URLSearchParams('');

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => searchParamsValue,
  usePathname: () => '/tenant/acme/settings',
}));

vi.mock('@/components/settings/general-settings-view', () => ({
  GeneralSettingsView: () => <div>General panel</div>,
}));
vi.mock('@/components/settings/facebook/facebook-settings-view', () => ({
  FacebookSettingsView: () => <div>Facebook panel</div>,
}));
vi.mock('@/components/settings/instagram-settings-view', () => ({
  InstagramSettingsView: () => <div>Instagram panel</div>,
}));
vi.mock('@/components/settings/threads-settings-view', () => ({
  ThreadsSettingsView: () => <div>Threads panel</div>,
}));

import { SettingsShell, resolveSettingsTab } from '@/app/tenant/[subdomain]/settings/settings-shell';

beforeEach(() => {
  replace.mockClear();
  searchParamsValue = new URLSearchParams('');
});

afterEach(() => {
  cleanup();
});

describe('resolveSettingsTab — the §5.6 deep-link contract', () => {
  it('resolves every one of the 4 ids to itself', () => {
    for (const id of ['general', 'facebook', 'instagram', 'threads']) {
      expect(resolveSettingsTab(id)).toBe(id);
    }
  });

  it('lands removed tab ids (youtube, x, tiktok) on General', () => {
    for (const id of ['youtube', 'x', 'tiktok']) {
      expect(resolveSettingsTab(id)).toBe('general');
    }
  });

  it('keeps the legacy `byoc` value landing on Facebook', () => {
    expect(resolveSettingsTab('byoc')).toBe('facebook');
  });

  it('lands missing and unknown values on General', () => {
    expect(resolveSettingsTab(null)).toBe('general');
    expect(resolveSettingsTab(undefined)).toBe('general');
    expect(resolveSettingsTab('')).toBe('general');
    expect(resolveSettingsTab('nonsense')).toBe('general');
  });
});

describe('SettingsShell', () => {
  it('renders the heading and all 4 tabs with their preserved testids, General active by default, and no removed tabs', () => {
    render(<SettingsShell subdomain="acme" initialTab="general" />);

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    for (const id of ['general', 'facebook', 'instagram', 'threads']) {
      expect(screen.getByTestId(`settings-tab-${id}`)).toBeTruthy();
    }
    for (const id of ['youtube', 'x', 'tiktok']) {
      expect(screen.queryByTestId(`settings-tab-${id}`)).toBeNull();
    }
    expect(screen.getByTestId('settings-tab-general').getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getByText('General panel')).toBeTruthy();
  });

  it('honours the server-resolved initial tab (deep link)', () => {
    render(<SettingsShell subdomain="acme" initialTab="facebook" />);

    expect(screen.getByTestId('settings-tab-facebook').getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('clicking a tab selects it and syncs the URL via replace (no history entry)', async () => {
    const user = userEvent.setup();
    render(<SettingsShell subdomain="acme" initialTab="general" />);

    await user.click(screen.getByTestId('settings-tab-instagram'));

    expect(screen.getByTestId('settings-tab-instagram').getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(replace).toHaveBeenCalledWith('/tenant/acme/settings?tab=instagram');
    await waitFor(() => {
      expect(screen.getByText('Instagram panel')).toBeTruthy();
    });
  });

  it('keyboard: ArrowRight from a focused tab activates the next tab (Radix pattern)', async () => {
    const user = userEvent.setup();
    render(<SettingsShell subdomain="acme" initialTab="general" />);

    const general = screen.getByTestId('settings-tab-general');
    general.focus();
    expect(document.activeElement).toBe(general);

    await user.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(screen.getByTestId('settings-tab-facebook').getAttribute('aria-selected')).toBe(
        'true'
      );
    });
    expect(replace).toHaveBeenCalledWith('/tenant/acme/settings?tab=facebook');
  });

  it('an inbound ?tab= deep link moves the selection (URL → tab direction)', async () => {
    searchParamsValue = new URLSearchParams('tab=byoc');
    render(<SettingsShell subdomain="acme" initialTab="general" />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-tab-facebook').getAttribute('aria-selected')).toBe(
        'true'
      );
    });
  });
});
