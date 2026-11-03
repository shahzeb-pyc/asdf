/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddPageDialog } from './adu-hub-page';

const ACCOUNTS = [
  { id: 'a1', external_account_id: 'fb-acc-111', display_name: 'Shahzeb Malik', avatar_url: null, status: 'active' },
  { id: 'a2', external_account_id: 'fb-acc-222', display_name: 'Example Account', avatar_url: null, status: 'active' },
  { id: 'a3', external_account_id: 'fb-acc-333', display_name: 'Old Account', avatar_url: null, status: 'expired' },
  { id: 'a4', external_account_id: 'fb-acc-444', display_name: 'Broken Account', avatar_url: null, status: 'error' },
];

const PAGES = [
  { id: 'p1', account_id: 'a1', external_destination_id: 'fb-page-101', name: 'Ellie Blossom', avatar_url: null, status: 'active', metadata: { category: 'Digital creator', current_followers: 1 } },
  { id: 'p2', account_id: 'a1', external_destination_id: 'fb-page-102', name: 'UK Videos', avatar_url: null, status: 'active', metadata: { category: 'Social media agency' } },
  { id: 'p5', account_id: 'a1', external_destination_id: 'fb-page-105', name: 'No Category Page', avatar_url: null, status: 'active', metadata: {} },
  { id: 'p3', account_id: 'a2', external_destination_id: 'fb-page-103', name: 'Example Page', avatar_url: null, status: 'active', metadata: { category: 'Example category', current_followers: 5000 } },
  { id: 'p4', account_id: 'a3', external_destination_id: 'fb-page-104', name: 'Stale Page', avatar_url: null, status: 'active', metadata: { category: 'Old', current_followers: 9 } },
  { id: 'p6', account_id: 'a4', external_destination_id: 'fb-page-106', name: 'Broken Page', avatar_url: null, status: 'active', metadata: { category: 'Broken', current_followers: 3 } },
];

const CONFIGURED = [{ destination_id: 'p1', source_platform: 'tiktok', source_username: 'sdf' }];

function mockFetch(postBodies: unknown[]) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      if (init.body) postBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ created: [{ destinationId: 'x' }], failed: [] }) };
    }
    return {
      ok: true,
      json: async () => ({ accounts: ACCOUNTS, pages: PAGES, configured: CONFIGURED, migrationMissing: false }),
    };
  });
}

async function openDialog(postBodies: unknown[] = []) {
  const onCreated = vi.fn();
  vi.stubGlobal('fetch', mockFetch(postBodies));
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

describe('ADU Add Page dialog — Pages picker flow', () => {
  beforeEach(() => { vi.stubGlobal('fetch', mockFetch([])); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('step 1 shows accounts with pages-linked counts, no ids, and dimmed unhealthy sections with an accounts link', async () => {
    await openDialog();
    expect(screen.getByText('Step 1 of 3: Select Accounts')).toBeTruthy();
    expect(screen.getByText('Shahzeb Malik')).toBeTruthy();
    expect(screen.getByText('3 pages linked')).toBeTruthy();
    expect(screen.getByText('1 page linked')).toBeTruthy();
    // No account id and no page id anywhere in the picker.
    expect(screen.queryByText('fb-acc-111')).toBeNull();
    expect(screen.queryByText('fb-acc-222')).toBeNull();
    expect(screen.queryByText('fb-page-101')).toBeNull();
    expect(screen.queryByText('1 Connected')).toBeNull();
    // Expired / error accounts are dimmed, labelled, and not selectable.
    expect(screen.getByText(/Session expired/)).toBeTruthy();
    expect(screen.getByText(/Connection issue/)).toBeTruthy();
    expect(screen.getByTestId('adu-expired-account-a3')).toBeTruthy();
    expect(screen.getByTestId('adu-error-account-a4')).toBeTruthy();
    expect(screen.queryByTestId('adu-account-checkbox-a3')).toBeNull();
    expect(screen.queryByTestId('adu-account-checkbox-a4')).toBeNull();
    const link = screen.getByText('Go to Facebook Accounts');
    expect(link.getAttribute('href')).toBe('/tenant/testws/accounts');
    // Next is gated on at least one account.
    expect((screen.getByTestId('adu-accounts-next-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clicking anywhere on an account row toggles it, not just the checkbox', async () => {
    await openDialog();
    // Click the account NAME (not the checkbox box) — the row toggles.
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    expect(checkboxState('adu-account-checkbox-a1')).toBe('checked');
    expect((screen.getByTestId('adu-accounts-next-btn') as HTMLButtonElement).disabled).toBe(false);
    // Clicking the name again deselects.
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    expect(checkboxState('adu-account-checkbox-a1')).toBe('unchecked');
    expect((screen.getByTestId('adu-accounts-next-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('account search filters by name and select-all toggles all active accounts', async () => {
    await openDialog();
    fireEvent.change(screen.getByTestId('adu-accounts-search-input'), { target: { value: 'Example' } });
    expect(screen.queryByText('Shahzeb Malik')).toBeNull();
    expect(screen.getByText('Example Account')).toBeTruthy();
    fireEvent.change(screen.getByTestId('adu-accounts-search-input'), { target: { value: '' } });

    fireEvent.click(screen.getByTestId('adu-select-all-accounts-btn'));
    expect(checkboxState('adu-account-checkbox-a1')).toBe('checked');
    expect(checkboxState('adu-account-checkbox-a2')).toBe('checked');
    expect(screen.getByTestId('adu-select-all-accounts-btn').textContent).toBe('Deselect All');
    expect(screen.getByTestId('adu-select-all-accounts-btn').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('adu-select-all-accounts-btn'));
    expect(checkboxState('adu-account-checkbox-a1')).toBe('unchecked');
    expect(checkboxState('adu-account-checkbox-a2')).toBe('unchecked');
  });

  it('step 2 shows only the union of the selected accounts’ pages, with a union count', async () => {
    await openDialog();
    await goToPagesStep();
    expect(screen.getByText('Step 2 of 3: Select Pages')).toBeTruthy();
    expect(screen.getByText('3 pages found')).toBeTruthy();
    expect(screen.getByText('Ellie Blossom')).toBeTruthy();
    expect(screen.getByText('UK Videos')).toBeTruthy();
    expect(screen.getByText('No Category Page')).toBeTruthy();
    expect(screen.queryByText('Example Page')).toBeNull();
    expect(screen.queryByText('Stale Page')).toBeNull();

    // Back, add the second account, and the union grows — still no expired pages.
    fireEvent.click(screen.getByTestId('adu-pages-back-btn'));
    fireEvent.click(screen.getByText('Example Account'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(screen.getByText('4 pages found')).toBeTruthy();
    expect(screen.getByText('Example Page')).toBeTruthy();
    expect(screen.queryByText('Stale Page')).toBeNull();
    expect(screen.queryByText('Broken Page')).toBeNull();
  });

  it('already-configured pages are disabled, checked, and labelled Already added; select-all skips them', async () => {
    await openDialog();
    await goToPagesStep();
    const configuredBox = screen.getByTestId('adu-page-checkbox-p1');
    expect(configuredBox.getAttribute('data-state')).toBe('checked');
    expect((configuredBox as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Already added')).toBeTruthy();

    fireEvent.click(screen.getByTestId('adu-select-all-pages-btn'));
    expect(checkboxState('adu-page-checkbox-p2')).toBe('checked');
    expect(screen.getByTestId('adu-select-all-pages-btn').textContent).toBe('Deselect All');
    fireEvent.click(screen.getByTestId('adu-select-all-pages-btn'));
    expect(checkboxState('adu-page-checkbox-p2')).toBe('unchecked');
    // The configured row stays checked-and-disabled through select-all toggling.
    expect(checkboxState('adu-page-checkbox-p1')).toBe('checked');
    expect((screen.getByTestId('adu-page-checkbox-p1') as HTMLButtonElement).disabled).toBe(true);
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
    fireEvent.click(screen.getByTestId('adu-page-checkbox-p3'));
    expect(checkboxState('adu-page-checkbox-p3')).toBe('checked');

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
    fireEvent.click(screen.getByTestId('adu-page-checkbox-p2'));
    fireEvent.click(screen.getByTestId('adu-pages-back-btn'));
    expect(checkboxState('adu-account-checkbox-a1')).toBe('checked');
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(checkboxState('adu-page-checkbox-p2')).toBe('checked');
  });

  it('step-2 Next is gated on at least one page', async () => {
    await openDialog();
    await goToPagesStep();
    expect((screen.getByTestId('adu-pages-next-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('adu-page-checkbox-p2'));
    expect((screen.getByTestId('adu-pages-next-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('step 3 keeps the existing submit shape for pages from the selected account', async () => {
    const postBodies: unknown[] = [];
    const { onCreated } = await openDialog(postBodies);
    await goToPagesStep();
    fireEvent.click(screen.getByTestId('adu-page-checkbox-p2'));
    fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
    await screen.findByText('Sources');

    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'sdf' } });
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

  it('pages-linked count excludes disconnected pages but keeps disconnected-paused pages (Pages parity)', async () => {
    const pages = [
      ...PAGES,
      { id: 'p7', account_id: 'a1', external_destination_id: 'fb-page-107', name: 'Gone Page', avatar_url: null, status: 'disconnected', metadata: { category: 'Gone' } },
      { id: 'p8', account_id: 'a1', external_destination_id: 'fb-page-108', name: 'Paused Page', avatar_url: null, status: 'disconnected', metadata: { category: 'Paused', fb_status: 'paused' } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ accounts: ACCOUNTS, pages, configured: CONFIGURED, migrationMissing: false }),
    })));
    render(
      <AddPageDialog subdomain="testws" open onOpenChange={() => {}} onCreated={() => {}} />
    );
    await screen.findByText('Shahzeb Malik');
    // 3 connected + 1 disconnected-paused = 4; the plain disconnected page is excluded.
    expect(screen.getByText('4 pages linked')).toBeTruthy();
    // Count-only fix: the disconnected row still appears in the step-2 union.
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    expect(screen.getByText('5 pages found')).toBeTruthy();
    expect(screen.getByText('Gone Page')).toBeTruthy();
    expect(screen.getByText('Paused Page')).toBeTruthy();
  });
});
