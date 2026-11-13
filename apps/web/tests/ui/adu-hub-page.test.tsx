/**
 * Facebook Auto Download/Upload hub — Add Page dialog 4-step flow tests.
 *
 * The dialog has ONE flow (no Single / Bulk / Multi-Account + CSV modes):
 * step 1 multi-selects accounts, step 2 selects the union of the
 * selected accounts' pages, step 3 configures per-page sources, step 4
 * configures the posting time, and submitting sends the bulk POST shape.
 * In step 3, Facebook, Instagram, and YouTube must render as DISABLED
 * source-platform options (still listed, never selectable), TikTok stays
 * enabled, and the default source platform is TikTok — so the dialog
 * never opens with a disabled platform pre-selected and a bare username
 * entry never silently creates a non-TikTok source.
 * Picker rows carry a photo avatar (initials fallback) plus, for pages,
 * a "category • followers" meta line from the destinations metadata
 * (followers always shown via current_followers ?? 0) — neither the
 * page id nor the account id is rendered. The result message is
 * singular for one created page ("Created 1 page.") and plural otherwise.
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

// The hub reads its filter/page state from the URL and navigates
// cards with router.push (adu-opt-b): both need the app router.
// The replace spy is plain — these tests never change the URL, so no
// URL simulation is needed here (the colocated client tests cover it).
const navMocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: navMocks.push, replace: navMocks.replace }),
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
    { id: '11111111-1111-4111-8111-111111111111', external_account_id: '111', display_name: 'My FB Account', avatar_url: null, status: 'connected' },
    { id: '22222222-2222-4222-8222-222222222222', external_account_id: '444', display_name: 'Second Account', avatar_url: null, status: 'connected' },
  ],
  pages: [
    { id: 'page-1', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: '222', name: 'My Page', avatar_url: null, status: 'connected', metadata: null },
    { id: 'page-2', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: '333', name: 'Second Page', avatar_url: null, status: 'connected', metadata: null },
    { id: 'page-3', account_id: '22222222-2222-4222-8222-222222222222', external_destination_id: '555', name: 'Third Page', avatar_url: null, status: 'connected', metadata: null },
  ],
  configured: [],
};

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

type OptionsBody = typeof OPTIONS_BODY;

// Builds the live-discover payload the dialog's typed `api.get`
// (`DiscoverPagesResponseSchema`) parses: one entry per account, from
// the options fixture's own pages, so step 2 shows the union of the
// selected accounts' pages exactly as the real discover route would.
// The account id must be a UUID — the schema rejects anything else,
// which is what left step 2 stuck on "loading" before this helper.
function discoverResponse(options: OptionsBody, url: string) {
  const accountId = url.split('/accounts/')[1]?.split('/')[0];
  const account = options.accounts.find((a) => a.id === accountId);
  if (!accountId || !account) {
    return jsonResponse({ error: 'Facebook account not found' }, false, 404);
  }
  const pages = options.pages.filter((p) => p.account_id === accountId);
  return jsonResponse({
    accountId,
    accountDisplayName: account.display_name,
    pages: pages.map((p) => {
      const metadata = (p.metadata ?? {}) as { category?: string; current_followers?: number };
      const followers = typeof metadata.current_followers === 'number' ? metadata.current_followers : 0;
      return {
        fbPageId: p.external_destination_id,
        pageName: p.name,
        profilePictureUrl: p.avatar_url,
        category: metadata.category ?? null,
        currentFollowers: followers,
        followersCount: followers,
        tasks: [],
        isImported: true,
      };
    }),
    total: pages.length,
    truncated: false,
    partial: false,
    droppedCount: 0,
  });
}

function installFetch(options: unknown = OPTIONS_BODY) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/auto-download-upload/options')) return jsonResponse(options);
    if (url.includes('/pages/discover')) return discoverResponse(options as OptionsBody, url);
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
  await user.click(screen.getByRole('button', { name: 'Add Page' }));
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
// Only Instagram is disabled: Facebook and YouTube were unblocked by
// PR #202, and TikTok is the default platform.
function expectPlatformOptions() {
  const instagram = screen.getByRole('option', { name: 'instagram' });
  expect(instagram.getAttribute('data-disabled')).not.toBeNull();
  expect(instagram.getAttribute('aria-disabled')).toBe('true');
  for (const platform of ['facebook', 'youtube', 'tiktok']) {
    const option = screen.getByRole('option', { name: platform });
    expect(option.getAttribute('data-disabled')).toBeNull();
    expect(option.getAttribute('aria-disabled')).not.toBe('true');
  }
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

describe('AduHubPage Add Page dialog 4-step flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Step 1 selects accounts, step 2 selects pages (the union of the
  // selected accounts), step 3 configures sources, step 4 configures
  // the posting time. The old single-screen step 1 (accounts and pages together, 'N pages
  // selected' line, bordered Select-all/Clear buttons, 'Already
  // configured' label, account ids) is gone by owner order.

  it('has no mode tabs: step 1 is Select Accounts, step 2 is Select Pages, step 3 is Sources, step 4 is Posting Time', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    expect(screen.queryByRole('button', { name: 'Single Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bulk Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Multi-Account + CSV' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull();
    expect(await screen.findByText('Step 1 of 4: Select Accounts')).toBeTruthy();
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 4: Select Pages')).toBeTruthy();
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 3 of 4: Sources')).toBeTruthy();
    // Step 3 Next is gated until every selected page has a source.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('@username'), 'creator_one');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
  });

  it('step 1: Next is gated on at least one account; step 2: Next is gated on at least one page; both lists multi-select', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await pickCheckboxFor(user, 'My FB Account');
    await pickCheckboxFor(user, 'Second Account');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 4: Select Pages')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Third Page');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('step 2: pages show only the union of the selected accounts’ pages', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('My Page')).toBeTruthy();
    expect(screen.getByText('Second Page')).toBeTruthy();
    expect(screen.queryByText('Third Page')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await pickCheckboxFor(user, 'Second Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Third Page')).toBeTruthy();
  });

  it('step 2: Select All covers selectable pages only, Deselect All empties the selection', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    const checked = () =>
      within(dialog).getAllByRole('checkbox').filter((c) => c.getAttribute('data-state') === 'checked');
    expect(checked()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Deselect All' }));
    expect(checked()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('step 2: already-configured pages are disabled, labelled Already added, and excluded from select-all', async () => {
    const user = userEvent.setup();
    installFetch({
      ...OPTIONS_BODY,
      configured: [{ destination_id: 'page-2', source_platform: 'tiktok', source_username: 'taken' }],
    });
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Already added')).toBeTruthy();
    expect(screen.queryByText('Already configured')).toBeNull();
    const label = screen.getByText('Second Page').closest('label');
    const checkbox = label?.querySelector('button[role="checkbox"]');
    expect(checkbox?.getAttribute('data-disabled')).not.toBeNull();
    expect(checkbox?.getAttribute('data-state')).toBe('checked');
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    // Only the unconfigured page becomes newly checked; the
    // configured row stays checked-and-disabled.
    const myPageLabel = screen.getByText('My Page').closest('label');
    expect(myPageLabel?.querySelector('button[role="checkbox"]')?.getAttribute('data-state')).toBe('checked');
    await user.click(screen.getByRole('button', { name: 'Deselect All' }));
    expect(myPageLabel?.querySelector('button[role="checkbox"]')?.getAttribute('data-state')).toBe('unchecked');
    expect(checkbox?.getAttribute('data-state')).toBe('checked');
    expect(checkbox?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('step 3: per-page pickers disable only Instagram and default to TikTok', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await pickCheckboxFor(user, 'Second Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Sources')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    const triggers = within(dialog).getAllByRole('combobox');
    expect(triggers).toHaveLength(3);
    // Every picker defaults to TikTok before anything is chosen.
    for (const trigger of triggers) {
      expect(trigger).toHaveTextContent('tiktok');
    }
    await user.click(triggers[0]!);
    expectPlatformOptions();
    // Close the menu again: an open Radix menu leaves pointer-events none
    // on the rest of the page, which would block typing into the inputs.
    await user.keyboard('{Escape}');
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    expect(inputs).toHaveLength(3);
  });

  it('step 3: Next is gated until every selected page has a source; step 4: Start Automation is then enabled', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    await user.type(inputs[0]!, 'creator_one');
    expect(next).toBeDisabled();
    await user.type(inputs[1]!, 'creator_two');
    expect(next).toBeEnabled();
    await user.click(next);
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Automation' })).toBeEnabled();
  });

  it('step 3: paste assigns sources to empty slots and reports the count', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Paste sources (random assign)' }));
    const textarea = dialog.querySelector('textarea');
    expect(textarea).toBeTruthy();
    await user.type(textarea!, 'tiktok|creator_one\ntiktok|creator_two');
    await user.click(screen.getByRole('button', { name: 'Apply assignment' }));
    expect(await screen.findByText(/2 sources assigned to 2 empty page slots/)).toBeTruthy();
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    expect(inputs.map((i) => (i as HTMLInputElement).value).sort()).toEqual(['creator_one', 'creator_two']);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Automation' })).toBeEnabled();
  });

  it('step 3: paste assigns a source that is already used on another page (reuse allowed)', async () => {
    const user = userEvent.setup();
    // creator_one is already configured on Third Page (Second Account),
    // which is not among the pages picked here — the paste must still
    // assign it instead of skipping it as "already used".
    installFetch({
      ...OPTIONS_BODY,
      configured: [{ destination_id: 'page-3', source_platform: 'tiktok', source_username: 'creator_one' }],
    });
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Paste sources (random assign)' }));
    const textarea = dialog.querySelector('textarea');
    expect(textarea).toBeTruthy();
    await user.type(textarea!, 'tiktok|creator_one\ntiktok|creator_two');
    await user.click(screen.getByRole('button', { name: 'Apply assignment' }));
    expect(await screen.findByText(/2 sources assigned to 2 empty page slots/)).toBeTruthy();
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    expect(inputs.map((i) => (i as HTMLInputElement).value).sort()).toEqual(['creator_one', 'creator_two']);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('step 4: shared schedule submits the bulk shape with TikTok sources', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    await user.type(inputs[0]!, 'creator_one');
    await user.type(inputs[1]!, 'creator_two');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
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

  it('step 4: separate scope submits one schedule per page', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('@username'), 'creator_one');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Set separately' }));
    expect(await screen.findByText('My Page · My FB Account')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start Automation' }));
    await waitFor(() => {
      const body = lastPostBody();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].schedule).toEqual({ timezone: 'Asia/Karachi', postsPerDay: 1 });
    });
  });

  it('step 4: Back returns to step 3 and keeps the sources; Back again returns to step 2, then step 1, keeping selections', async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 3 of 4: Sources')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('@username'), 'creator_one');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Step 3 of 4: Sources')).toBeTruthy();
    expect((within(screen.getByRole('dialog')).getByPlaceholderText('@username') as HTMLInputElement).value).toBe('creator_one');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Step 2 of 4: Select Pages')).toBeTruthy();
    const myPageLabel = screen.getByText('My Page').closest('label');
    expect(myPageLabel?.querySelector('button[role="checkbox"]')?.getAttribute('data-state')).toBe('checked');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Step 1 of 4: Select Accounts')).toBeTruthy();
    const accountLabel = screen.getByText('My FB Account').closest('label');
    expect(accountLabel?.querySelector('button[role="checkbox"]')?.getAttribute('data-state')).toBe('checked');
  });

  it('step 1 and 2: rows show photos when avatar URLs exist, initials otherwise', async () => {
    const user = userEvent.setup();
    installFetch({
      ...OPTIONS_BODY,
      accounts: [
        { id: '11111111-1111-4111-8111-111111111111', external_account_id: '111', display_name: 'My FB Account', avatar_url: 'https://images.example.com/acct.jpg', status: 'connected' },
        { id: '22222222-2222-4222-8222-222222222222', external_account_id: '444', display_name: 'Second Account', avatar_url: null, status: 'connected' },
      ],
      pages: [
        { id: 'page-1', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: '222', name: 'My Page', avatar_url: 'https://images.example.com/page.jpg', status: 'connected', metadata: null },
        { id: 'page-2', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: '333', name: 'Second Page', avatar_url: null, status: 'connected', metadata: null },
        { id: 'page-3', account_id: '22222222-2222-4222-8222-222222222222', external_destination_id: '555', name: 'Third Page', avatar_url: null, status: 'connected', metadata: null },
      ],
    });
    await openDialog(user);
    const accountLabel = screen.getByText('My FB Account').closest('label');
    const accountImg = within(accountLabel as HTMLElement).getByTestId('picker-avatar-img');
    expect(accountImg.getAttribute('src')).toBe('https://images.example.com/acct.jpg');
    const secondAccountLabel = screen.getByText('Second Account').closest('label');
    expect(within(secondAccountLabel as HTMLElement).getByText('SA')).toBeTruthy();
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const pageLabel = screen.getByText('My Page').closest('label');
    const pageImg = within(pageLabel as HTMLElement).getByTestId('picker-avatar-img');
    expect(pageImg.getAttribute('src')).toBe('https://images.example.com/page.jpg');
    const secondPageLabel = screen.getByText('Second Page').closest('label');
    expect(within(secondPageLabel as HTMLElement).getByText('SP')).toBeTruthy();
  });

  it('step 2: a failed avatar photo falls back to initials', async () => {
    const user = userEvent.setup();
    installFetch({
      ...OPTIONS_BODY,
      pages: [
        { id: 'page-1', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: '222', name: 'My Page', avatar_url: 'https://images.example.com/broken.jpg', status: 'connected', metadata: null },
        ...OPTIONS_BODY.pages.slice(1),
      ],
    });
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const label = screen.getByText('My Page').closest('label');
    const img = within(label as HTMLElement).getByTestId('picker-avatar-img');
    fireEvent.error(img);
    expect(within(label as HTMLElement).getByTestId('picker-avatar-initials')).toBeTruthy();
    expect(within(label as HTMLElement).queryByTestId('picker-avatar-img')).toBeNull();
    expect(within(label as HTMLElement).getByText('MP')).toBeTruthy();
  });

  it('step 2: page rows always show category and followers in Pages format, never ids', async () => {
    const user = userEvent.setup();
    installFetch({
      ...OPTIONS_BODY,
      pages: [
        { id: 'page-1', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: '222', name: 'My Page', avatar_url: null, status: 'connected', metadata: { category: 'Digital creator', current_followers: 23108 } },
        { id: 'page-2', account_id: '11111111-1111-4111-8111-111111111111', external_destination_id: '333', name: 'Second Page', avatar_url: null, status: 'connected', metadata: { category: 'Music video' } },
        { id: 'page-3', account_id: '22222222-2222-4222-8222-222222222222', external_destination_id: '555', name: 'Third Page', avatar_url: null, status: 'connected', metadata: { current_followers: 1 } },
        { id: 'page-4', account_id: '22222222-2222-4222-8222-222222222222', external_destination_id: '666', name: 'Fourth Page', avatar_url: null, status: 'connected', metadata: {} },
      ],
    });
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await pickCheckboxFor(user, 'Second Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Digital creator • 23,108 followers')).toBeTruthy();
    expect(screen.getByText('Music video • 0 followers')).toBeTruthy();
    expect(screen.getByText('Facebook Page • 1 followers')).toBeTruthy();
    expect(screen.getByText('Facebook Page • 0 followers')).toBeTruthy();
    // No page ids and no account ids anywhere in the picker.
    expect(screen.queryByText('222')).toBeNull();
    expect(screen.queryByText('333')).toBeNull();
    expect(screen.queryByText('555')).toBeNull();
    expect(screen.queryByText('666')).toBeNull();
    expect(screen.queryByText('111')).toBeNull();
    expect(screen.queryByText('444')).toBeNull();
  });

  it('step 4: result message is singular for one created page', async () => {
    const user = userEvent.setup();
    // One created + one failed: partial failure keeps the dialog open
    // so the banner stays visible (a clean success closes it).
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/auto-download-upload/options')) return jsonResponse(OPTIONS_BODY);
      if (url.includes('/pages/discover')) return discoverResponse(OPTIONS_BODY, url);
      if (init?.method === 'POST') return jsonResponse({ id: 'cfg-new', created: [{ id: 'cfg-a' }], failed: [{ destinationId: 'page-2', error: 'boom' }] });
      return jsonResponse(HUB_BODY);
    });
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('@username'), 'creator_one');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start Automation' }));
    expect(await screen.findByText(/Created 1 page\./)).toBeTruthy();
  });

  it('step 4: result message stays plural for multiple created pages', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/auto-download-upload/options')) return jsonResponse(OPTIONS_BODY);
      if (url.includes('/pages/discover')) return discoverResponse(OPTIONS_BODY, url);
      if (init?.method === 'POST') return jsonResponse({ id: 'cfg-new', created: [{ id: 'cfg-a' }, { id: 'cfg-b' }], failed: [{ destinationId: 'page-3', error: 'boom' }] });
      return jsonResponse(HUB_BODY);
    });
    await openDialog(user);
    await pickCheckboxFor(user, 'My FB Account');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await pickCheckboxFor(user, 'My Page');
    await pickCheckboxFor(user, 'Second Page');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog');
    const inputs = within(dialog).getAllByPlaceholderText('@username');
    await user.type(inputs[0]!, 'creator_one');
    await user.type(inputs[1]!, 'creator_two');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 4 of 4: Posting Time')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start Automation' }));
    expect(await screen.findByText(/Created 2 pages\./)).toBeTruthy();
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
    expect(screen.getByTestId('adu-page-pending-count').textContent).toBe('0');
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

  it('shows ADU totals with signal colours in Pending / Posted / Failed order', async () => {
    installFetchCards([
      { ...CARD_CONFIG, pendingCount: 5, postedCount: 12, failedCount: 2 },
    ]);
    await renderCards();
    const row = screen.getByTestId('adu-page-pending-counts');
    expect(Array.from(row.children).map((el) => el.getAttribute('data-testid'))).toEqual([
      'adu-page-pending-stat',
      'adu-page-posted-stat',
      'adu-page-failed-stat',
    ]);
    const pending = screen.getByTestId('adu-page-pending-count');
    const posted = screen.getByTestId('adu-page-posted-count');
    const failed = screen.getByTestId('adu-page-failed-count');
    expect(pending.textContent).toBe('5');
    expect(posted.textContent).toBe('12');
    expect(failed.textContent).toBe('2');
    expect(pending.className).toContain('text-signal-queued');
    expect(posted.className).toContain('text-signal-operational');
    expect(failed.className).toContain('text-signal-critical');
    expect(pending.className).toContain('text-xxl');
    expect(screen.getByTestId('adu-page-pending-stat').textContent).toContain('Pending');
    expect(screen.getByTestId('adu-page-card-cfg-1').textContent).not.toContain('Queued');
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
    // Client navigation (adu-opt-b): the card calls router.push, not
    // window.location.href, so the shell and QueryClient survive.
    fireEvent.click(card);
    expect(navMocks.push).toHaveBeenCalledWith('/tenant/acme/auto-download-upload/cfg-1');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(navMocks.push).toHaveBeenCalledWith('/tenant/acme/auto-download-upload/cfg-1');
    fireEvent.keyDown(card, { key: ' ' });
    expect(navMocks.push).toHaveBeenCalledWith('/tenant/acme/auto-download-upload/cfg-1');
    expect(window.location.href).not.toContain('cfg-1');
  });

  it('clicking the source link does not navigate the card', async () => {
    installFetchCards([CARD_CONFIG]);
    await renderCards();
    fireEvent.click(screen.getByTestId('adu-page-source-link'));
    expect(navMocks.push).not.toHaveBeenCalled();
  });

  it('maps every ADU display status to the right StatusMark kind', () => {
    expect(getAduStatusMarkKind('Active posting')).toBe('operational');
    expect(getAduStatusMarkKind('All reels posted')).toBe('operational');
    expect(getAduStatusMarkKind('Scrape pending')).toBe('queued');
    expect(getAduStatusMarkKind('Scraping reels')).toBe('queued');
    expect(getAduStatusMarkKind('Posting inactive')).toBe('critical');
    expect(getAduStatusMarkKind('Paused')).toBe('queued');
    expect(getAduStatusMarkKind('Missing page access')).toBe('critical');
    expect(getAduStatusMarkKind('Missing permission')).toBe('critical');
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
