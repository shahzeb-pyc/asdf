/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddPageDialog } from './adu-hub-page';

const ACCOUNTS = [
  { id: '11111111-1111-4111-8111-111111111111', external_account_id: 'fb-acc-111', display_name: 'Shahzeb Malik', avatar_url: null, status: 'active' },
  { id: '22222222-2222-4222-8222-222222222222', external_account_id: 'fb-acc-222', display_name: 'Example Account', avatar_url: null, status: 'active' },
  { id: 'a3', external_account_id: 'fb-acc-333', display_name: 'Old Account', avatar_url: null, status: 'expired' },
  { id: 'a4', external_account_id: 'fb-acc-444', display_name: 'Broken Account', avatar_url: null, status: 'error' },
];

const PAGES = [
  { id: 'p1', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: 'fb-page-101', name: 'Ellie Blossom', avatar_url: null, status: 'active', metadata: { category: 'Digital creator', current_followers: 1 } },
  { id: 'p2', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: 'fb-page-102', name: 'UK Videos', avatar_url: null, status: 'active', metadata: { category: 'Social media agency' } },
  { id: 'p5', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: 'fb-page-105', name: 'No Category Page', avatar_url: null, status: 'active', metadata: {} },
  { id: 'p3', account_id: '22222222-2222-4222-8222-222222222222', external_destination_id: 'fb-page-103', name: 'Example Page', avatar_url: null, status: 'active', metadata: { category: 'Example category', current_followers: 5000 } },
  { id: 'p4', account_id: 'a3', external_destination_id: 'fb-page-104', name: 'Stale Page', avatar_url: null, status: 'active', metadata: { category: 'Old', current_followers: 9 } },
  { id: 'p6', account_id: 'a4', external_destination_id: 'fb-page-106', name: 'Broken Page', avatar_url: null, status: 'active', metadata: { category: 'Broken', current_followers: 3 } },
  // Disconnected destination that DOES have an ADU config: it still
  // counts as linked in ADU (destination status is irrelevant).
  { id: 'p7', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: 'fb-page-109', name: 'Disconnected ADU Page', avatar_url: null, status: 'disconnected', metadata: { category: 'Gone' } },
];

const CONFIGURED = [
  { destination_id: 'p1', source_platform: 'tiktok', source_username: 'sdf' },
  { destination_id: 'p7', source_platform: 'tiktok', source_username: 'gone' },
];

function discoverPage(fbPageId: string, pageName: string, category: string | null, currentFollowers: number, isImported: boolean) {
  return {
    fbPageId,
    pageName,
    profilePictureUrl: null,
    category,
    currentFollowers,
    followersCount: currentFollowers,
    tasks: [],
    isImported,
  };
}

// Live Facebook pages per account, as the discover route returns
// them. fb-page-107 ("Janhvi Kapoor Lovers") has NO destinations
// row — step 2 must still show it. fb-page-108 ("Shared Page") is
// managed by BOTH accounts — step 2 must show it twice.
// UK Videos / Example Page carry isImported: true (they exist in
// `destinations` via another section) but have NO adu_config — the
// dialog must render them fresh, proving "Already added" comes
// from adu_configs only, never from isImported.
const DISCOVER: Record<string, unknown> = {
  '11111111-1111-4111-8111-111111111111': {
    accountId: '11111111-1111-4111-8111-111111111111',
    accountDisplayName: 'Shahzeb Malik',
    pages: [
      discoverPage('fb-page-101', 'Ellie Blossom', 'Digital creator', 1, true),
      discoverPage('fb-page-102', 'UK Videos', 'Social media agency', 0, true),
      discoverPage('fb-page-105', 'No Category Page', null, 0, false),
      discoverPage('fb-page-107', 'Janhvi Kapoor Lovers', 'Actor', 23099, false),
      discoverPage('fb-page-108', 'Shared Page', 'Shared', 12, false),
    ],
    total: 5,
    truncated: false,
    partial: false,
    droppedCount: 0,
  },
  '22222222-2222-4222-8222-222222222222': {
    accountId: '22222222-2222-4222-8222-222222222222',
    accountDisplayName: 'Example Account',
    pages: [
      discoverPage('fb-page-103', 'Example Page', 'Example category', 5000, true),
      discoverPage('fb-page-108', 'Shared Page', 'Shared', 12, false),
    ],
    total: 2,
    truncated: false,
    partial: false,
    droppedCount: 0,
  },
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockFetch(
  postBodies: unknown[],
  discover: Record<string, unknown> = DISCOVER,
) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      if (init.body) postBodies.push(JSON.parse(init.body));
      return jsonResponse({ created: [{ destinationId: 'x' }], failed: [] });
    }
    if (url.includes('/pages/discover')) {
      const accountId = url.split('/accounts/')[1]?.split('/')[0];
      const payload = accountId ? discover[accountId] : undefined;
      if (!payload) return jsonResponse({ error: 'Facebook account not found' }, false, 404);
      return jsonResponse(payload);
    }
    return jsonResponse({ accounts: ACCOUNTS, pages: PAGES, configured: CONFIGURED, migrationMissing: false });
  });
}

async function openDialog(postBodies: unknown[] = [], discover: Record<string, unknown> = DISCOVER) {
  const onCreated = vi.fn();
  vi.stubGlobal('fetch', mockFetch(postBodies, discover));
  render(
    <AddPageDialog subdomain="testws" open onOpenChange={() => {}} onCreated={onCreated} />
  );
  await screen.findByText('Shahzeb Malik');
  return { onCreated };
}

function checkboxState(testId: string) {
  return screen.getByTestId(testId).getAttribute('data-state');
}

async function goToPagesStep() {
  fireEvent.click(screen.getByText('Shahzeb Malik'));
  fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
  await screen.findByTestId('adu-pages-list');
}

async function goToPostingStep(postBodies: unknown[] = []) {
  const { onCreated } = await openDialog(postBodies);
  await goToPagesStep();
  fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102'));
  fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
  await screen.findByText('Sources');
  fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'sdf' } });
  fireEvent.click(screen.getByTestId('adu-sources-next-btn'));
  await screen.findByText('Posting Time');
  return { onCreated };
}

describe('ADU Add Page dialog — live discovery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch([]));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('step 1 shows only active accounts, with ADU-only pages-linked counts', async () => {
    await openDialog();
    expect(screen.getByText('Step 1 of 4: Select Accounts')).toBeTruthy();
    expect(screen.getByText('Shahzeb Malik')).toBeTruthy();
    // ADU-only: Shahzeb has 2 ADU configs (p1 + the disconnected p7),
    // Example Account has 0 — the old counts (3 and 1) counted every
    // section's destinations.
    expect(screen.getByText('2 pages linked')).toBeTruthy();
    expect(screen.getByText('0 pages linked')).toBeTruthy();
    // No account id and no page id anywhere in the picker.
    expect(screen.queryByText('fb-acc-111')).toBeNull();
    expect(screen.queryByText('fb-acc-222')).toBeNull();
    expect(screen.queryByText('fb-page-101')).toBeNull();
    expect(screen.queryByText('1 Connected')).toBeNull();
    // Expired / error accounts do not appear at all — no dimmed
    // sections, no Accounts link.
    expect(screen.queryByText(/Session expired/)).toBeNull();
    expect(screen.queryByText(/Connection issue/)).toBeNull();
    expect(screen.queryByTestId('adu-expired-account-a3')).toBeNull();
    expect(screen.queryByTestId('adu-error-account-a4')).toBeNull();
    expect(screen.queryByText('Go to Facebook Accounts')).toBeNull();
    expect(screen.queryByTestId('adu-account-checkbox-a3')).toBeNull();
    expect(screen.queryByTestId('adu-account-checkbox-a4')).toBeNull();
    // Next is gated on at least one account.
    expect((screen.getByTestId('adu-accounts-next-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clicking anywhere on an account row toggles it, not just the checkbox', async () => {
    await openDialog();
    // Click the account NAME (not the checkbox box) — the row toggles.
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    expect(checkboxState('adu-account-checkbox-11111111-1111-4111-8111-111111111111')).toBe('checked');
    expect((screen.getByTestId('adu-accounts-next-btn') as HTMLButtonElement).disabled).toBe(false);
    // Clicking the name again deselects.
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    expect(checkboxState('adu-account-checkbox-11111111-1111-4111-8111-111111111111')).toBe('unchecked');
    expect((screen.getByTestId('adu-accounts-next-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('account search filters by name and select-all toggles all active accounts', async () => {
    await openDialog();
    fireEvent.change(screen.getByTestId('adu-accounts-search-input'), { target: { value: 'Example' } });
    expect(screen.queryByText('Shahzeb Malik')).toBeNull();
    expect(screen.getByText('Example Account')).toBeTruthy();
    fireEvent.change(screen.getByTestId('adu-accounts-search-input'), { target: { value: '' } });

    fireEvent.click(screen.getByTestId('adu-select-all-accounts-btn'));
    expect(checkboxState('adu-account-checkbox-11111111-1111-4111-8111-111111111111')).toBe('checked');
    expect(checkboxState('adu-account-checkbox-22222222-2222-4222-8222-222222222222')).toBe('checked');
    expect(screen.getByTestId('adu-select-all-accounts-btn').textContent).toBe('Deselect All');
    expect(screen.getByTestId('adu-select-all-accounts-btn').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('adu-select-all-accounts-btn'));
    expect(checkboxState('adu-account-checkbox-11111111-1111-4111-8111-111111111111')).toBe('unchecked');
    expect(checkboxState('adu-account-checkbox-22222222-2222-4222-8222-222222222222')).toBe('unchecked');
  });

  it('step 2 shows live discovered pages, including a page with no destinations row', async () => {
    await openDialog();
    await goToPagesStep();
    expect(screen.getByText('Step 2 of 4: Select Pages')).toBeTruthy();
    expect(screen.getByText('5 pages found')).toBeTruthy();
    expect(screen.getByText('Ellie Blossom')).toBeTruthy();
    expect(screen.getByText('UK Videos')).toBeTruthy();
    expect(screen.getByText('No Category Page')).toBeTruthy();
    // The bug: this page exists on Facebook but has no destinations
    // row, so the old destinations-only step 2 could never show it.
    expect(screen.getByText('Janhvi Kapoor Lovers')).toBeTruthy();
    expect(screen.getByText('Shared Page')).toBeTruthy();
    expect(screen.queryByText('Example Page')).toBeNull();
    expect(screen.queryByText('Stale Page')).toBeNull();
    // Every row names the account it came from.
    expect(screen.getAllByText('via Shahzeb Malik')).toHaveLength(5);

    // Back, add the second account, and the union grows — the page
    // both accounts manage appears twice, once per account.
    fireEvent.click(screen.getByTestId('adu-pages-back-btn'));
    fireEvent.click(screen.getByText('Example Account'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(screen.getByText('7 pages found')).toBeTruthy();
    expect(screen.getByText('Example Page')).toBeTruthy();
    expect(screen.getAllByText('Shared Page')).toHaveLength(2);
    expect(screen.getAllByText('via Shahzeb Malik')).toHaveLength(5);
    expect(screen.getAllByText('via Example Account')).toHaveLength(2);
    expect(screen.queryByText('Stale Page')).toBeNull();
    expect(screen.queryByText('Broken Page')).toBeNull();
  });

  it('already-configured pages are disabled, checked, and labelled Already added; select-all skips them', async () => {
    await openDialog();
    await goToPagesStep();
    const configuredBox = screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-101');
    expect(configuredBox.getAttribute('data-state')).toBe('checked');
    expect((configuredBox as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Already added')).toHaveLength(1);

    // UK Videos / Example Page carry discover's isImported: true
    // (they exist in `destinations` via another section) but have
    // NO adu_config — they must render fresh and selectable.
    const importedElsewhere = screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102');
    expect(importedElsewhere.getAttribute('data-state')).toBe('unchecked');
    expect((importedElsewhere as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('adu-select-all-pages-btn'));
    expect(checkboxState('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102')).toBe('checked');
    expect(screen.getByTestId('adu-select-all-pages-btn').textContent).toBe('Deselect All');
    fireEvent.click(screen.getByTestId('adu-select-all-pages-btn'));
    expect(checkboxState('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102')).toBe('unchecked');
    // The configured row stays checked-and-disabled through select-all toggling.
    expect(checkboxState('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-101')).toBe('checked');
    expect((screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-101') as HTMLButtonElement).disabled).toBe(true);
  });

  it('page rows always show category and followers with the Pages fallback rule', async () => {
    await openDialog();
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(screen.getByText('Example Account'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(screen.getByText('Digital creator • 1 followers')).toBeTruthy();
    expect(screen.getByText('Social media agency • 0 followers')).toBeTruthy();
    expect(screen.getByText('Example category • 5,000 followers')).toBeTruthy();
    expect(screen.getByText('Facebook Page • 0 followers')).toBeTruthy();
    expect(screen.getByText('Actor • 23,099 followers')).toBeTruthy();
    expect(screen.queryByText('Already configured')).toBeNull();
  });

  it('page search filters by name only', async () => {
    await openDialog();
    await goToPagesStep();
    fireEvent.change(screen.getByTestId('adu-pages-search-input'), { target: { value: 'UK' } });
    expect(screen.queryByText('Ellie Blossom')).toBeNull();
    expect(screen.getByText('UK Videos')).toBeTruthy();
  });

  it('deselecting an account drops its pages from the selection and gates step-2 Next', async () => {
    await openDialog();
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(screen.getByText('Example Account'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    fireEvent.click(screen.getByTestId('adu-page-checkbox-22222222-2222-4222-8222-222222222222-fb-page-103'));
    expect(checkboxState('adu-page-checkbox-22222222-2222-4222-8222-222222222222-fb-page-103')).toBe('checked');

    fireEvent.click(screen.getByTestId('adu-pages-back-btn'));
    fireEvent.click(screen.getByText('Example Account'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(screen.queryByText('Example Page')).toBeNull();
    expect((screen.getByTestId('adu-pages-next-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Back preserves accounts and page selection', async () => {
    await openDialog();
    await goToPagesStep();
    fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102'));
    fireEvent.click(screen.getByTestId('adu-pages-back-btn'));
    expect(checkboxState('adu-account-checkbox-11111111-1111-4111-8111-111111111111')).toBe('checked');
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(checkboxState('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102')).toBe('checked');
  });

  it('step-2 Next is gated on at least one page', async () => {
    await openDialog();
    await goToPagesStep();
    expect((screen.getByTestId('adu-pages-next-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102'));
    expect((screen.getByTestId('adu-pages-next-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('one account’s discover failure shows error + Retry for that account only', async () => {
    const discover: Record<string, unknown> = { '11111111-1111-4111-8111-111111111111': DISCOVER['11111111-1111-4111-8111-111111111111'] };
    const { onCreated } = await openDialog([], discover);
    expect(onCreated).toBeDefined();
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(screen.getByText('Example Account'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-discover-error-22222222-2222-4222-8222-222222222222');
    expect(screen.getByText(/Example Account: Couldn't load pages/)).toBeTruthy();
    // The healthy account's pages stay listed; no empty state
    // appears next to the error.
    expect(screen.getByText('Janhvi Kapoor Lovers')).toBeTruthy();
    expect(screen.queryByText('No pages on the selected accounts.')).toBeNull();

    // Retry after the account recovers: its pages join the list.
    discover['22222222-2222-4222-8222-222222222222'] = DISCOVER['22222222-2222-4222-8222-222222222222'];
    fireEvent.click(screen.getByTestId('adu-discover-retry-22222222-2222-4222-8222-222222222222'));
    await screen.findByText('Example Page');
    expect(screen.queryByTestId('adu-discover-error-22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(screen.getByText('7 pages found')).toBeTruthy();
  });

  it('step 4 submits the existing shape for pages from the selected account', async () => {
    const postBodies: unknown[] = [];
    const { onCreated } = await openDialog(postBodies);
    await goToPagesStep();
    fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102'));
    fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
    await screen.findByText('Sources');

    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'sdf' } });
    fireEvent.click(screen.getByTestId('adu-sources-next-btn'));
    await screen.findByText('Posting Time');
    fireEvent.click(screen.getByText('Start Automation'));
    await screen.findByText('Created 1 page.');
    expect(onCreated).toHaveBeenCalled();
    expect(postBodies).toHaveLength(1);
    const body = postBodies[0] as {
      items: { destinationId: string; sourcePlatform: string; sourceUsername: string }[];
      timezone: string;
      postsPerDay: number;
      scheduleType: string;
    };
    expect(body.items).toEqual([{ destinationId: 'p2', sourcePlatform: 'tiktok', sourceUsername: 'sdf' }]);
    expect(body.timezone).toBe('Asia/Karachi');
    expect(body.postsPerDay).toBe(1);
    expect(body.scheduleType).toBe('dailyrandom');
  });

  it('step 4 submits a never-imported page by discovered reference, not destination id', async () => {
    const postBodies: unknown[] = [];
    const { onCreated } = await openDialog(postBodies);
    await goToPagesStep();
    fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-107'));
    fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
    await screen.findByText('Sources');

    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'janhvi' } });
    fireEvent.click(screen.getByTestId('adu-sources-next-btn'));
    await screen.findByText('Posting Time');
    fireEvent.click(screen.getByText('Start Automation'));
    await screen.findByText('Created 1 page.');
    expect(onCreated).toHaveBeenCalled();
    expect(postBodies).toHaveLength(1);
    const body = postBodies[0] as {
      items: { discovered: { fbPageId: string; accountId: string }; sourcePlatform: string; sourceUsername: string }[];
    };
    expect(body.items).toEqual([
      { discovered: { fbPageId: 'fb-page-107', accountId: '11111111-1111-4111-8111-111111111111' }, sourcePlatform: 'tiktok', sourceUsername: 'janhvi' },
    ]);
  });

  it('step 3 shows sources only and its Next is gated on filled sources', async () => {
    const { onCreated } = await openDialog([]);
    await goToPagesStep();
    fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102'));
    fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
    await screen.findByText('Sources');
    expect(screen.getByText('Step 3 of 4: Sources')).toBeTruthy();
    // No schedule controls on the sources step, and no submit yet.
    expect(screen.queryByText('Posting Time')).toBeNull();
    expect(screen.queryByText('Random Posting Times')).toBeNull();
    expect(screen.queryByText('Posts Per Day')).toBeNull();
    expect(screen.queryByText('Start Automation')).toBeNull();
    // Next is blocked until every selected page has a source.
    expect((screen.getByTestId('adu-sources-next-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'sdf' } });
    expect((screen.getByTestId('adu-sources-next-btn') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('adu-sources-next-btn'));
    await screen.findByText('Posting Time');
    expect(screen.getByText('Step 4 of 4: Posting Time')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('step 4 shows posting time only and Back keeps the sources and selection', async () => {
    await openDialog([]);
    await goToPagesStep();
    fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102'));
    fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
    await screen.findByText('Sources');
    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'sdf' } });
    fireEvent.click(screen.getByTestId('adu-sources-next-btn'));
    await screen.findByText('Posting Time');
    // No source rows on the posting-time step.
    expect(screen.queryByPlaceholderText('@username')).toBeNull();
    expect(screen.queryByText('Sources')).toBeNull();
    // Back keeps the entered source.
    fireEvent.click(screen.getByTestId('adu-posting-back-btn'));
    await screen.findByText('Sources');
    expect((screen.getByPlaceholderText('@username') as HTMLInputElement).value).toBe('sdf');
    // Back again keeps the page selection.
    fireEvent.click(screen.getByTestId('adu-sources-back-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(checkboxState('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102')).toBe('checked');
  });

  it('step 4 Start Automation is blocked until separate schedules are complete', async () => {
    await openDialog([]);
    await goToPagesStep();
    fireEvent.click(screen.getByTestId('adu-page-checkbox-11111111-1111-4111-8111-111111111111-fb-page-102'));
    fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
    await screen.findByText('Sources');
    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'sdf' } });
    fireEvent.click(screen.getByTestId('adu-sources-next-btn'));
    await screen.findByText('Posting Time');
    // The shared schedule is complete by default, so Start Automation
    // starts enabled — switching to per-page fixed times with empty
    // times blocks it until every page's times are filled.
    expect((screen.getByText('Start Automation') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Set separately'));
    fireEvent.click(screen.getByText('Fixed Posting Times'));
    expect((screen.getByText('Start Automation') as HTMLButtonElement).disabled).toBe(true);
    const timeInput = document.querySelector('input[type="time"]') as HTMLInputElement;
    expect(timeInput).not.toBeNull();
    fireEvent.change(timeInput, { target: { value: '09:00' } });
    expect((screen.getByText('Start Automation') as HTMLButtonElement).disabled).toBe(false);
  });

  it('step 4 timezone is the Pages searchable picker, preselected with Asia/Karachi', async () => {
    const postBodies: unknown[] = [];
    const { onCreated } = await goToPostingStep(postBodies);
    // No free-text timezone input remains anywhere in step 4.
    expect(document.querySelector('#adu-timezone')).toBeNull();
    expect(document.querySelector('#adu-bulk-11111111-1111-4111-8111-111111111111-fb-page-102-timezone')).toBeNull();
    // The Pages picker loads (lazy) with the current timezone
    // selected — the user must not re-pick a timezone they have.
    const note = await screen.findByTestId('add-page-timezone-note');
    expect(note.textContent).toMatch(/Karachi/);
    expect(note.textContent).toMatch(/Asia\/Karachi/);
    // The shortened note, with no 5-hour promise.
    expect(screen.getByText('Balanced random times will be automatically generated upon saving.')).toBeTruthy();
    expect(screen.queryByText(/5-hour/)).toBeNull();
    // Search narrows the directory; picking another zone changes
    // the submitted timezone.
    fireEvent.change(screen.getByTestId('add-page-timezone-search-input'), { target: { value: 'Tokyo' } });
    fireEvent.click(await screen.findByTestId('add-page-timezone-option-Asia/Tokyo'));
    expect(note.textContent).toMatch(/Tokyo/);
    expect(note.textContent).toMatch(/Asia\/Tokyo/);
    fireEvent.click(screen.getByText('Start Automation'));
    await screen.findByText('Created 1 page.');
    expect(onCreated).toHaveBeenCalled();
    const body = postBodies[0] as { timezone: string; postsPerDay: number; scheduleType: string };
    expect(body.timezone).toBe('Asia/Tokyo');
    expect(body.postsPerDay).toBe(1);
    expect(body.scheduleType).toBe('dailyrandom');
  });

  it('step 4 Posts Per Day is a 1–12 dropdown that resizes the fixed times', async () => {
    const user = userEvent.setup();
    await goToPostingStep();
    fireEvent.click(screen.getByText('Fixed Posting Times'));
    // One time input for the default 1 post per day.
    expect(screen.getAllByTestId(/^adu-fixed-time-/)).toHaveLength(1);
    // The dropdown lists 1–12; picking 3 resizes the times to 3.
    await user.click(screen.getByTestId('adu-posts-per-day-select'));
    expect(screen.getByRole('option', { name: '12' })).toBeTruthy();
    await user.click(screen.getByRole('option', { name: '3' }));
    expect(screen.getByTestId('adu-posts-per-day-select').textContent).toContain('3');
    expect(screen.getAllByTestId(/^adu-fixed-time-/)).toHaveLength(3);
    // And back to 1 — a dropdown cannot be cleared or jump values.
    await user.click(screen.getByTestId('adu-posts-per-day-select'));
    await user.click(screen.getByRole('option', { name: '1' }));
    expect(screen.getByTestId('adu-posts-per-day-select').textContent).toContain('1');
    expect(screen.getAllByTestId(/^adu-fixed-time-/)).toHaveLength(1);
  });

  it('step 4 fixed times show a 12-hour preview and a duplicate warning', async () => {
    const user = userEvent.setup();
    await goToPostingStep();
    fireEvent.click(screen.getByText('Fixed Posting Times'));
    // The default 09:00 previews in 12-hour form.
    expect(screen.getByText('Posts will go out at 09:00 AM.')).toBeTruthy();
    // Two posts a day both default to 09:00 — both warn.
    await user.click(screen.getByTestId('adu-posts-per-day-select'));
    await user.click(screen.getByRole('option', { name: '2' }));
    expect(screen.getAllByText('Choose a different time for each posting time.')).toHaveLength(2);
    // Changing one clears the warning and updates its preview.
    fireEvent.change(screen.getByTestId('adu-fixed-time-1'), { target: { value: '10:00' } });
    expect(screen.queryByText('Choose a different time for each posting time.')).toBeNull();
    expect(screen.getByText('Posts will go out at 10:00 AM.')).toBeTruthy();
    expect(screen.getByText('Posts will go out at 09:00 AM.')).toBeTruthy();
  });

  it('step 4 separate scope uses the same pickers per page', async () => {
    const user = userEvent.setup();
    const postBodies: unknown[] = [];
    const { onCreated } = await goToPostingStep(postBodies);
    fireEvent.click(screen.getByText('Set separately'));
    // The shortened note, with no 5-hour promise.
    expect(screen.getByText('Balanced random times will be automatically generated upon saving.')).toBeTruthy();
    expect(screen.queryByText(/5-hour/)).toBeNull();
    // One timezone picker for the one selected page, preselected.
    const notes = await screen.findAllByTestId('add-page-timezone-note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toMatch(/Asia\/Karachi/);
    // Per-page Posts Per Day is a dropdown; picking 2 gives two
    // fixed-time fields for that page.
    fireEvent.click(screen.getByText('Fixed Posting Times'));
    const pageKey = '11111111-1111-4111-8111-111111111111:fb-page-102';
    await user.click(screen.getByTestId(`adu-posts-per-day-select-${pageKey}`));
    await user.click(screen.getByRole('option', { name: '2' }));
    expect(screen.getAllByTestId(new RegExp(`^adu-fixed-time-${pageKey.replace(/:/g, '\\:')}-`))).toHaveLength(2);
    // Fill both times and submit: the per-page schedule carries the
    // picked timezone, count, and times.
    fireEvent.change(screen.getByTestId(`adu-fixed-time-${pageKey}-0`), { target: { value: '09:00' } });
    fireEvent.change(screen.getByTestId(`adu-fixed-time-${pageKey}-1`), { target: { value: '10:00' } });
    fireEvent.click(screen.getByText('Start Automation'));
    await screen.findByText('Created 1 page.');
    expect(onCreated).toHaveBeenCalled();
    const body = postBodies[0] as {
      items: { schedule: { timezone: string; postsPerDay: number; postingTimes: string[] } }[];
    };
    expect(body.items[0]?.schedule).toEqual({
      timezone: 'Asia/Karachi',
      postsPerDay: 2,
      postingTimes: ['09:00', '10:00'],
    });
  });
});
