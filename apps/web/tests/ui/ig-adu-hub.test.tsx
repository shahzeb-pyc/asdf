/**
 * Instagram Auto Download/Upload hub — behavioural render + add-flow tests.
 * The hub must list ONLY Instagram configs (platform filtering lives in the
 * IG route, not here), show Instagram copy, and drive the Single / Bulk add
 * flows against the Instagram API base. No Facebook copy, no page picker.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { IgAduHubPage } from '@/components/instagram/auto-download-upload/ig-adu-hub-page';

const fetchMock = vi.fn();

const CONFIG = {
  id: 'cfg-1',
  destinationId: 'dest-1',
  destinationName: 'My IG Account',
  destinationExternalId: '17841400008460056',
  sourcePlatform: 'instagram',
  sourceUsername: 'creator_one',
  sourceIdentity: '@creator_one',
  destinationStatus: 'active',
  accountName: 'My IG Account',
  status: 'active',
  displayStatus: 'Active',
  followersCount: 1000,
  followersGained: 1250,
  createdAt: '2026-10-20T00:00:00.000Z',
  postedCount: 10,
  pendingCount: 3,
  failedCount: 1,
  postedToday: 2,
  pendingToday: 1,
  failedToday: 0,
  postsPerDay: 2,
};

const HUB_BODY = {
  configs: [CONFIG],
  stats: { totalPages: 1, followersGained: 250, totalFollowers: 1250 },
  totalPages: 1,
  page: 1,
  limit: 9,
};

const OPTIONS_BODY = {
  destinations: [
    {
      id: 'dest-1',
      account_id: 'acct-1',
      external_destination_id: '17841400008460056',
      name: 'My IG Account',
      avatar_url: null,
      status: 'connected',
      metadata: null,
    },
    {
      id: 'dest-2',
      account_id: 'acct-2',
      external_destination_id: '17841400008460057',
      name: 'Second IG Account',
      avatar_url: null,
      status: 'connected',
      metadata: null,
    },
  ],
  pages: [
    {
      id: 'dest-1',
      account_id: 'acct-1',
      external_destination_id: '17841400008460056',
      name: 'My IG Account',
      avatar_url: null,
      status: 'connected',
      metadata: null,
    },
    {
      id: 'dest-2',
      account_id: 'acct-2',
      external_destination_id: '17841400008460057',
      name: 'Second IG Account',
      avatar_url: null,
      status: 'connected',
      metadata: null,
    },
  ],
  configured: [{ destination_id: 'dest-1', source_platform: 'instagram', source_username: 'creator_one' }],
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

function installFetch(postBody: unknown = { id: 'cfg-new' }) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/instagram/auto-download-upload/options')) return jsonResponse(OPTIONS_BODY);
    if (init?.method === 'POST') return jsonResponse(postBody);
    return jsonResponse(HUB_BODY);
  });
}

describe('IgAduHubPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders Instagram hub copy, stats, and the account card with an account link', async () => {
    render(<IgAduHubPage subdomain="acme" />);
    expect(await screen.findByText('Auto Download/Upload')).toBeTruthy();
    expect(screen.getByText('Connected Instagram accounts for automated reel download and posting.')).toBeTruthy();
    expect(screen.getByText('Total Accounts')).toBeTruthy();
    expect(screen.getByText('Followers Gained')).toBeTruthy();
    expect(await screen.findByText('My IG Account')).toBeTruthy();
    expect(screen.getByText('17841400008460056')).toBeTruthy();
    expect(screen.getByText(/Posted 10 · Pending 3 · Failed 1/)).toBeTruthy();
    const link = screen.getByText('Open account →');
    expect(link.getAttribute('href')).toBe('/tenant/acme/instagram/auto-download-upload/cfg-1');
    // No Facebook copy and no "via account" duplication line.
    expect(document.body.textContent).not.toContain('Open page');
    expect(document.body.textContent).not.toContain('Facebook');
  });

  it('shows the migration banner, not the empty state, when the ADU tables are missing', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/options')) return jsonResponse(OPTIONS_BODY);
      return jsonResponse({ configs: [], total: 0, page: 1, migrationMissing: true });
    });
    render(<IgAduHubPage subdomain="acme" />);
    expect(await screen.findByText('ADU tables are not created yet')).toBeTruthy();
    expect(screen.queryByText('No accounts found')).toBeNull();
  });

  it('shows the first-use empty state when no accounts are configured', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/options')) return jsonResponse(OPTIONS_BODY);
      return jsonResponse({ configs: [], stats: { totalPages: 0, followersGained: 0, totalFollowers: 0 }, totalPages: 0, page: 1, limit: 9 });
    });
    render(<IgAduHubPage subdomain="acme" />);
    expect(await screen.findByText('No accounts found')).toBeTruthy();
  });

  it('single add: picks one Instagram account, enters a source, and POSTs a single config', async () => {
    render(<IgAduHubPage subdomain="acme" />);
    await screen.findByText('My IG Account');
    fireEvent.click(screen.getByText('+ Add Account'));
    expect(await screen.findByText('Add New Account')).toBeTruthy();
    // dest-1 is already configured and must be disabled; pick dest-2.
    const already = screen.getByText('Already configured');
    const disabledLabel = already.closest('label');
    const disabledCheckbox = disabledLabel?.querySelector('button[role="checkbox"]');
    // Radix renders the disabled state as a present (empty) data-disabled
    // attribute plus the native disabled attribute on the button.
    expect(disabledCheckbox?.hasAttribute('disabled')).toBe(true);
    const checkboxes = screen.getAllByRole('checkbox');
    const enabled = checkboxes.find((c) => !c.hasAttribute('disabled'));
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled!);
    expect(screen.getByText('1 accounts selected')).toBeTruthy();
    fireEvent.click(screen.getByText('Next'));
    expect(await screen.findByText('Step 2 of 2: Configure Settings')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'creator_two' } });
    fireEvent.click(screen.getByText('Start Automation'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post![1].body as string);
      expect(body.destinationId).toBe('dest-2');
      expect(body.sourcePlatform).toBe('instagram');
      expect(body.sourceUsername).toBe('creator_two');
      expect(body.scheduleType).toBe('dailyrandom');
    });
    // Single success closes the dialog and reloads the hub.
    await waitFor(() => {
      expect(screen.queryByText('Add New Account')).toBeNull();
    });
  });

  it('bulk add: picks two accounts, maps sources, and POSTs one item per account', async () => {
    // Neither account is configured here, so "Select all" picks both.
    const unconfiguredOptions = { ...OPTIONS_BODY, configured: [] };
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/instagram/auto-download-upload/options')) return jsonResponse(unconfiguredOptions);
      if (init?.method === 'POST') return jsonResponse({ created: [{ id: 'cfg-a' }, { id: 'cfg-b' }], failed: [] });
      return jsonResponse(HUB_BODY);
    });
    render(<IgAduHubPage subdomain="acme" />);
    await screen.findByText('My IG Account');
    fireEvent.click(screen.getByText('+ Add Account'));
    await screen.findByText('Add New Account');
    fireEvent.click(screen.getByText('Bulk Add'));
    fireEvent.click(screen.getByText('Select all accounts'));
    expect(screen.getByText('2 accounts selected')).toBeTruthy();
    fireEvent.click(screen.getByText('Next'));
    expect(await screen.findByText('Step 2 of 3: Add Source Usernames')).toBeTruthy();
    const inputs = screen.getAllByPlaceholderText('@username');
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0], { target: { value: 'creator_one' } });
    fireEvent.change(inputs[1], { target: { value: 'creator_two' } });
    fireEvent.click(screen.getByText('Next'));
    expect(await screen.findByText('Step 3 of 3: Schedule')).toBeTruthy();
    fireEvent.click(screen.getByText('Create Selected Accounts'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post![1].body as string);
      expect(body.items).toHaveLength(2);
      expect(body.items.map((i: { destinationId: string }) => i.destinationId)).toEqual(['dest-1', 'dest-2']);
      expect(body.items.map((i: { sourceUsername: string }) => i.sourceUsername)).toEqual(['creator_one', 'creator_two']);
    });
  });
});
