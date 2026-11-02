/**
 * Facebook Auto Download/Upload hub — Add Page dialog 2-step flow tests.
 *
 * The dialog has ONE flow (no Single / Bulk / Multi-Account + CSV modes):
 * step 1 multi-selects accounts and pages, step 2 configures per-page
 * sources plus the schedule, and submitting sends the bulk POST shape.
 * In step 2, Facebook, Instagram, and YouTube must render as DISABLED
 * source-platform options (still listed, never selectable), TikTok stays
 * enabled, and the default source platform is TikTok — so the dialog
 * never opens with a disabled platform pre-selected and a bare username
 * entry never silently creates a non-TikTok source.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('next/image', () => ({
  default: ({ src, alt, ...props }: { src: string; alt: string }) => (
    <img src={src} alt={alt} {...props} />
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
    { id: 'acct-2', external_account_id: '444', display_name: 'Second Account', avatar_url: null, status: 'connected' },
  ],
  pages: [
    { id: 'page-1', account_id: 'acct-1', external_destination_id: '222', name: 'My Page', avatar_url: null, status: 'connected', metadata: null },
    { id: 'page-2', account_id: 'acct-1', external_destination_id: '333', name: 'Second Page', avatar_url: null, status: 'connected', metadata: null },
    { id: 'page-3', account_id: 'acct-2', external_destination_id: '555', name: 'Third Page', avatar_url: null, status: 'connected', metadata: null },
  ],
  configured: [],
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

function installFetch(options: unknown = OPTIONS_BODY) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/auto-download-upload/options')) return jsonResponse(options);
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

function lastPostBody() {
  const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
  expect(post).toBeTruthy();
  return JSON.parse(post![1].body as string);
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

// The shells under test render the feature-cap hook, which reads the
// shared entitlement. In the app the tenant shell provides it; these
// standalone shell tests do not mount that shell, so the hook reads
// the neutral unproven state (cap renders nothing) instead of
// throwing for a missing provider. The real provider path is covered
// by the feature-cap tests.
vi.mock('@/components/billing/entitlement-provider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSharedEntitlement: () => ({
      entitlement: null,
      isProven: false,
      isLoading: false,
      isUnproven: true,
      refetch: async () => undefined,
    }),
  };
});

describe('AduHubPage Add Page dialog 2-step flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has no mode tabs: step 1 is Select Pages, step 2 is Configure', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    expect(screen.queryByRole('button', { name: 'Single Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bulk Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Multi-Account + CSV' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull();
    expect(await screen.findByText('Step 1 of 2: Select Pages')).toBeTruthy();
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 2: Configure')).toBeTruthy();
  });

  it('step 1: Next is gated on at least one page, and both lists multi-select', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await pickCheckboxFor(user, 'My FB Account');
    await pickCheckboxFor(user, 'Second Account');
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Third Page');
    expect(screen.getByText('2 pages selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('step 1: pages filter by selected accounts, and all show when none selected', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    expect(screen.getByText('Third Page')).toBeTruthy();
    await pickCheckboxFor(user, 'My FB Account');
    expect(screen.queryByText('Third Page')).toBeNull();
    expect(screen.getByText('Second Page')).toBeTruthy();
    await pickCheckboxFor(user, 'My FB Account');
    expect(screen.getByText('Third Page')).toBeTruthy();
  });

  it('step 1: select-all pages covers visible pages only, Clear empties the selection', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Select all pages' }));
    expect(screen.getByText('2 pages selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('0 pages selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('step 1: already-configured pages are disabled, labelled, and excluded from select-all', async () => {
    const user = userEvent.setup();
    installFetch({
      ...OPTIONS_BODY,
      configured: [{ destination_id: 'page-2', source_platform: 'tiktok', source_username: 'taken' }],
    });
    await openDialog(user);
    expect(screen.getByText('Already configured')).toBeTruthy();
    const label = screen.getByText('Second Page').closest('label');
    const checkbox = label?.querySelector('button[role="checkbox"]');
    expect(checkbox?.getAttribute('data-disabled')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Select all pages' }));
    expect(screen.getByText('2 pages selected')).toBeTruthy();
  });

  it('step 2: per-page pickers disable Facebook, Instagram, and YouTube and default to TikTok', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(screen.getByRole('button', { name: 'Select all pages' }));
    expect(screen.getByText('3 pages selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Sources')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    const triggers = within(dialog).getAllByRole('combobox');
    expect(triggers).toHaveLength(3);
    await user.click(triggers[0]!);
    expectPlatformOptionsDisabled();
    // Close the menu again: an open Radix menu leaves pointer-events none
    // on the rest of the page, which would block typing into the inputs.
    await user.keyboard('{Escape}');
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    expect(inputs).toHaveLength(3);
  });

  it('step 2: Start Automation is gated until every selected page has a source', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    const start = screen.getByRole('button', { name: 'Start Automation' });
    expect(start).toBeDisabled();
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    await user.type(inputs[0]!, 'creator_one');
    expect(start).toBeDisabled();
    await user.type(inputs[1]!, 'creator_two');
    expect(start).toBeEnabled();
  });

  it('step 2: paste assigns sources to empty slots only and reports the count', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Paste sources (random assign)' }));
    const textarea = dialog.querySelector('textarea');
    expect(textarea).toBeTruthy();
    await user.type(textarea!, 'tiktok|creator_one\ntiktok|creator_two');
    await user.click(screen.getByRole('button', { name: 'Apply assignment' }));
    expect(await screen.findByText(/2 new sources assigned to 2 empty page slots/)).toBeTruthy();
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    expect(inputs.map((i) => (i as HTMLInputElement).value).sort()).toEqual(['creator_one', 'creator_two']);
    expect(screen.getByRole('button', { name: 'Start Automation' })).toBeEnabled();
  });

  it('step 2: shared schedule submits the bulk shape with TikTok sources', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    await user.type(inputs[0]!, 'creator_one');
    await user.type(inputs[1]!, 'creator_two');
    await user.click(screen.getByRole('button', { name: 'Start Automation' }));
    await waitFor(() => {
      const body = lastPostBody();
      expect(body.items).toHaveLength(2);
      expect(body.items.map((i: { sourcePlatform: string }) => i.sourcePlatform)).toEqual(['tiktok', 'tiktok']);
      expect(body.items.map((i: { sourceUsername: string }) => i.sourceUsername)).toEqual(['creator_one', 'creator_two']);
      expect(body.items[0].schedule).toBeUndefined();
      expect(body.timezone).toBe('Asia/Karachi');
      expect(body.postsPerDay).toBe(1);
      expect(body.scheduleType).toBe('dailyrandom');
      expect(body.postingTimes).toBeUndefined();
    });
  });

  it('step 2: separate scope submits one schedule per page', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('@username'), 'creator_one');
    await user.click(screen.getByRole('button', { name: 'Set separately' }));
    expect(await screen.findByText('My Page · My FB Account')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start Automation' }));
    await waitFor(() => {
      const body = lastPostBody();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].schedule).toEqual({ timezone: 'Asia/Karachi', postsPerDay: 1 });
    });
  });

  it('step 2: Back returns to step 1 and keeps the selection', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 2: Configure')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Step 1 of 2: Select Pages')).toBeTruthy();
    expect(screen.getByText('1 pages selected')).toBeTruthy();
  });
});

/**
 * ADU hub list cards — Pages-section structure with ADU data.
 *
 * The card mirrors `components/pages/page-card.tsx`: avatar with a
 * status ring + identity lines + circled arrow, source link row,
 * status mark + account footer, big signal-coloured counts, and the
 * ADU-specific Today line. The whole card navigates to the detail
 * page, except clicks inside the source link.
 */
import { getAduStatusMarkKind } from '@/components/auto-download-upload/adu-hub-page';

const CARD_CONFIG = {
  id: 'cfg-1',
  destinationId: 'dest-1',
  destinationName: 'Ellie Blossom',
  destinationExternalId: '432724216597352',
  destinationAvatarUrl: null,
  sourcePlatform: 'tiktok',
  sourceUsername: 'sdf',
  sourceIdentity: '@sdf',
  sourceLink: 'https://www.tiktok.com/@sdf',
  destinationStatus: 'active',
  accountName: 'Shahzeb Malik',
  status: 'active',
  displayStatus: 'Scrape pending',
  followersCount: 0,
  followersGained: 0,
  createdAt: '2026-11-02T10:00:00.000Z',
  postedCount: 0,
  pendingCount: 0,
  failedCount: 0,
  postedToday: 0,
  pendingToday: 1,
  failedToday: 0,
  postsPerDay: 1,
};

function installFetchCards(configs: unknown[]) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/auto-download-upload/options')) return jsonResponse(OPTIONS_BODY);
    return jsonResponse({
      configs,
      stats: { totalPages: configs.length, followersGained: 0, totalFollowers: 0 },
      totalPages: 1,
      page: 1,
    });
  });
}

async function renderCards(configs: unknown[] = [CARD_CONFIG]) {
  renderWithQuery(<AduHubPage subdomain="acme" />);
  return screen.findByTestId('adu-page-card-cfg-1');
}

/** Stubs window.location with a plain getter/setter so card
 * navigation (window.location.href = ...) is observable in jsdom
 * without jsdom's "not implemented: navigation" path. Restores the
 * original descriptor afterwards. */
function stubLocation() {
  let href = '';
  const original = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      set href(next: string) {
        href = next;
      },
    },
  });
  return {
    get href() {
      return href;
    },
    restore() {
      if (original) Object.defineProperty(window, 'location', original);
    },
  };
}

describe('AduHubPage list cards (Pages-section structure)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('renders avatar initials, name, Added date, bold current followers, source link, status mark, account, counts, Today line', async () => {
    installFetchCards([CARD_CONFIG]);
    const card = await renderCards();
    expect(card.textContent).toContain('EB');
    expect(screen.getByTestId('adu-page-name').textContent).toBe('Ellie Blossom');
    expect(screen.getByTestId('adu-page-added-line').textContent).toBe('Added 2 Nov 2026');
    const followers = screen.getByTestId('adu-page-current-followers');
    expect(followers.textContent).toBe('0');
    expect(followers.className).toContain('font-bold');
    expect(screen.getByTestId('adu-page-followers-line').textContent).toContain('followers · tiktok');
    const sourceLink = screen.getByTestId('adu-page-source-link');
    expect(sourceLink.textContent).toContain('@sdf');
    expect(sourceLink.getAttribute('href')).toBe('https://www.tiktok.com/@sdf');
    const status = screen.getByTestId('adu-page-status');
    expect(status.textContent).toContain('Scrape pending');
    expect(status.getAttribute('data-status')).toBe('queued');
    expect(screen.getByTestId('adu-page-parent-account').textContent).toBe('Account: Shahzeb Malik');
    expect(screen.getByTestId('adu-page-queued-count').textContent).toBe('0');
    expect(screen.getByTestId('adu-page-posted-count').textContent).toBe('0');
    expect(screen.getByTestId('adu-page-failed-count').textContent).toBe('0');
    expect(screen.getByTestId('adu-page-today-line').textContent).toContain('Today: Pending 1 · Posted 0 · Failed 0');
  });

  it('shows the page photo when destinationAvatarUrl is set, initials otherwise', async () => {
    installFetchCards([
      { ...CARD_CONFIG, destinationAvatarUrl: 'https://example.invalid/avatar.jpg' },
    ]);
    await renderCards();
    const img = screen.getByTestId('adu-page-avatar-img');
    expect(img.getAttribute('src')).toBe('https://example.invalid/avatar.jpg');
    expect(screen.queryByTestId('adu-page-avatar-initials')).toBeNull();
  });

  it('shows ADU totals with signal colours in Queued / Posted / Failed order', async () => {
    installFetchCards([
      { ...CARD_CONFIG, pendingCount: 5, postedCount: 12, failedCount: 2 },
    ]);
    await renderCards();
    const row = screen.getByTestId('adu-page-queue-counts');
    expect(Array.from(row.children).map((el) => el.getAttribute('data-testid'))).toEqual([
      'adu-page-queued-stat',
      'adu-page-posted-stat',
      'adu-page-failed-stat',
    ]);
    const queued = screen.getByTestId('adu-page-queued-count');
    const posted = screen.getByTestId('adu-page-posted-count');
    const failed = screen.getByTestId('adu-page-failed-count');
    expect(queued.textContent).toBe('5');
    expect(posted.textContent).toBe('12');
    expect(failed.textContent).toBe('2');
    expect(queued.className).toContain('text-signal-queued');
    expect(posted.className).toContain('text-signal-operational');
    expect(failed.className).toContain('text-signal-critical');
    expect(queued.className).toContain('text-xxl');
  });

  it('followers line shows the CURRENT count and the gained indicator when net gained > 0', async () => {
    installFetchCards([
      { ...CARD_CONFIG, followersCount: 100, followersGained: 150 },
    ]);
    await renderCards();
    expect(screen.getByTestId('adu-page-current-followers').textContent).toBe('150');
    expect(screen.getByTestId('adu-page-followers-gained').textContent).toBe('+50 gained');
  });

  it('hides the gained indicator when net gained is 0', async () => {
    installFetchCards([
      { ...CARD_CONFIG, followersCount: 100, followersGained: 100 },
    ]);
    await renderCards();
    expect(screen.queryByTestId('adu-page-followers-gained')).toBeNull();
  });

  it('Today line emphasises nonzero counts and mutes zeros', async () => {
    installFetchCards([{ ...CARD_CONFIG, pendingToday: 1, postedToday: 0, failedToday: 3 }]);
    await renderCards();
    const line = screen.getByTestId('adu-page-today-line');
    const pending = within(line).getByText('1');
    const failed = within(line).getByText('3');
    expect(pending.className).toContain('font-semibold');
    expect(failed.className).toContain('font-semibold');
    expect(within(line).getByText('0').className).not.toContain('font-semibold');
  });

  it('omits the Added line for an unparseable date, never garbage', async () => {
    installFetchCards([{ ...CARD_CONFIG, createdAt: 'not-a-date' }]);
    await renderCards();
    expect(screen.queryByTestId('adu-page-added-line')).toBeNull();
  });

  it('drops the old card lines: no external id, no Starting, no Open page link', async () => {
    installFetchCards([CARD_CONFIG]);
    await renderCards();
    expect(screen.queryByText('432724216597352')).toBeNull();
    expect(screen.queryByText(/Starting/)).toBeNull();
    expect(screen.queryByText(/Open page/)).toBeNull();
  });

  it('whole-card click, Enter, and Space navigate to the detail page', async () => {
    installFetchCards([CARD_CONFIG]);
    const card = await renderCards();
    const loc = stubLocation();
    try {
      fireEvent.click(card);
      expect(loc.href).toBe('/tenant/acme/auto-download-upload/cfg-1');
      loc.restore();
      const loc2 = stubLocation();
      try {
        fireEvent.keyDown(card, { key: 'Enter' });
        expect(loc2.href).toBe('/tenant/acme/auto-download-upload/cfg-1');
        fireEvent.keyDown(card, { key: ' ' });
        expect(loc2.href).toBe('/tenant/acme/auto-download-upload/cfg-1');
      } finally {
        loc2.restore();
      }
    } finally {
      loc.restore();
    }
  });

  it('clicking the source link does not navigate the card', async () => {
    installFetchCards([CARD_CONFIG]);
    await renderCards();
    const loc = stubLocation();
    try {
      fireEvent.click(screen.getByTestId('adu-page-source-link'));
      expect(loc.href).toBe('');
    } finally {
      loc.restore();
    }
  });

  it('maps every ADU display status to the right StatusMark kind', () => {
    expect(getAduStatusMarkKind('Active posting')).toBe('operational');
    expect(getAduStatusMarkKind('All reels posted')).toBe('operational');
    expect(getAduStatusMarkKind('Scrape pending')).toBe('queued');
    expect(getAduStatusMarkKind('Scraping reels')).toBe('queued');
    expect(getAduStatusMarkKind('Posting inactive')).toBe('queued');
    expect(getAduStatusMarkKind('Source not found')).toBe('critical');
    expect(getAduStatusMarkKind('Verification required')).toBe('critical');
    expect(getAduStatusMarkKind('Invalid token')).toBe('critical');
    expect(getAduStatusMarkKind('Rate limited')).toBe('critical');
    expect(getAduStatusMarkKind('Page not accessible')).toBe('critical');
    expect(getAduStatusMarkKind('Source disabled')).toBe('critical');
    expect(getAduStatusMarkKind('Creator suspended')).toBe('critical');
    expect(getAduStatusMarkKind('BM 2FA required')).toBe('critical');
    expect(getAduStatusMarkKind('Check developer app')).toBe('critical');
    expect(getAduStatusMarkKind('Account suspended')).toBe('critical');
    expect(getAduStatusMarkKind('Something unexpected')).toBe('critical');
  });
});
