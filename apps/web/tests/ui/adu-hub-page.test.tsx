/**
 * Facebook Auto Download/Upload hub — Add Page dialog source-platform tests.
 *
 * In the Add Page dialog, Facebook, Instagram, and YouTube must render as
 * DISABLED source-platform options (still listed, never selectable), TikTok
 * stays enabled, and the dialog's default source platform is TikTok — so the
 * dialog never opens with a disabled platform pre-selected and a bare
 * username entry never silently creates a non-TikTok source.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AduHubPage } from '@/components/auto-download-upload/adu-hub-page';

const fetchMock = vi.fn();

const HUB_BODY = {
  configs: [],
  stats: { totalPages: 0, followersGained: 0, totalFollowers: 0 },
  totalPages: 0,
  page: 1,
  limit: 9,
};

const OPTIONS_BODY = {
  accounts: [
    { id: 'acct-1', external_account_id: '111', display_name: 'My FB Account', avatar_url: null, status: 'connected' },
  ],
  pages: [
    { id: 'page-1', account_id: 'acct-1', external_destination_id: '222', name: 'My Page', avatar_url: null, status: 'connected', metadata: null },
    { id: 'page-2', account_id: 'acct-1', external_destination_id: '333', name: 'Second Page', avatar_url: null, status: 'connected', metadata: null },
  ],
  configured: [],
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

function installFetch() {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/auto-download-upload/options')) return jsonResponse(OPTIONS_BODY);
    if (init?.method === 'POST') return jsonResponse({ id: 'cfg-new', created: [{ id: 'cfg-a' }, { id: 'cfg-b' }], failed: [] });
    return jsonResponse(HUB_BODY);
  });
}

function renderWithQuery(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  renderWithQuery(<AduHubPage subdomain="acme" />);
  await screen.findByText('No pages found');
  await user.click(screen.getByRole('button', { name: '+ Add Page' }));
  expect(await screen.findByText('Add New Page')).toBeTruthy();
}

async function pickCheckboxFor(user: ReturnType<typeof userEvent.setup>, name: string) {
  const label = screen.getByText(name).closest('label');
  const checkbox = label?.querySelector('button[role="checkbox"]');
  expect(checkbox).toBeTruthy();
  await user.click(checkbox!);
}

// Radix renders the open SelectContent in a portal on document.body, not
// inside the dialog node, so options must be queried from the whole screen.
// Only one picker is open at a time, so the platform names are unambiguous.
function expectPlatformOptionsDisabled() {
  for (const platform of ['instagram', 'youtube', 'facebook']) {
    const option = screen.getByRole('option', { name: platform });
    expect(option.getAttribute('data-disabled')).not.toBeNull();
    expect(option.getAttribute('aria-disabled')).toBe('true');
  }
  const tiktok = screen.getByRole('option', { name: 'tiktok' });
  expect(tiktok.getAttribute('data-disabled')).toBeNull();
  expect(tiktok.getAttribute('aria-disabled')).not.toBe('true');
}

describe('AduHubPage Add Page dialog source platforms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('single add: Facebook, Instagram, and YouTube options are disabled, TikTok is enabled', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Source platform')).toBeTruthy();
    await user.click(document.getElementById('adu-source-platform')!);
    expectPlatformOptionsDisabled();
  });

  it('single add: the default source platform is TikTok when submitting without touching the picker', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Source platform')).toBeTruthy();
    await user.type(screen.getByPlaceholderText('@username'), 'creator_one');
    await user.click(screen.getByRole('button', { name: 'Start Automation' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post![1].body as string);
      expect(body.destinationId).toBe('page-1');
      expect(body.sourcePlatform).toBe('tiktok');
      expect(body.sourceUsername).toBe('creator_one');
    });
  });

  it('bulk add: per-page pickers disable Facebook, Instagram, and YouTube and default to TikTok', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(screen.getByRole('button', { name: 'Bulk Add' }));
    await user.click(screen.getByRole('button', { name: 'Select all pages' }));
    expect(screen.getByText('2 pages selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Per-Page Source Mapping')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    const triggers = within(dialog).getAllByRole('combobox');
    expect(triggers).toHaveLength(2);
    await user.click(triggers[0]!);
    expectPlatformOptionsDisabled();
    // Close the menu again: an open Radix menu leaves pointer-events none
    // on the rest of the page, which would block typing into the inputs.
    await user.keyboard('{Escape}');
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    expect(inputs).toHaveLength(2);
    await user.type(inputs[0]!, 'creator_one');
    await user.type(inputs[1]!, 'creator_two');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Schedule')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create Selected Pages' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post![1].body as string);
      expect(body.items).toHaveLength(2);
      expect(body.items.map((i: { sourcePlatform: string }) => i.sourcePlatform)).toEqual(['tiktok', 'tiktok']);
      expect(body.items.map((i: { sourceUsername: string }) => i.sourceUsername)).toEqual(['creator_one', 'creator_two']);
    });
  });
});
