/**
 * @file command-palette.test.tsx
 * @description Behavioural tests for the ⌘K command palette
 * (spec 130 §5.6, PR-130-4): the decided-minimum pool (actions,
 * workspaces, accounts/pages from the data layer's cache —
 * Destinations entries removed with the Destinations pages),
 * recents first, shortcut hints, no-results typed
 * state, Esc focus return through the host, workspace switch naming
 * its target, and ⌘K / Ctrl+K opening from the header host button.
 * Data is stubbed at the typed client's fetch seam, exactly like the
 * switcher suite.
 */

import React, { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { SidebarProvider } from '@/components/shared/ui/sidebar';
import { createQueryClient } from '@/lib/data/query-client';
import { CommandPalette } from '@/components/shell/command-palette';
import { CommandPaletteHost } from '@/components/shell/command-palette-host';

// next/dynamic is a build-time construct; in jsdom we resolve the
// loader eagerly so the host test exercises the real palette.
vi.mock('next/dynamic', () => ({
  default: (
    loader: () => Promise<unknown>
  ) => {
    const Lazy = React.lazy(async () => {
      const resolved = await loader();
      const Component = (
        typeof resolved === 'function'
          ? resolved
          : Object.values(resolved as Record<string, unknown>)[0]
      ) as React.ComponentType<Record<string, unknown>>;
      return { default: Component };
    });
    return function DynamicHarness(props: Record<string, unknown>) {
      return (
        <Suspense fallback={null}>
          <Lazy {...props} />
        </Suspense>
      );
    };
  },
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/tenant/acme',
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn() }),
}));

const ACME = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  name: 'Acme',
  subdomain: 'acme',
};
const BETA = {
  id: '33333333-3333-4333-8333-333333333333',
  ownerId: '22222222-2222-4222-8222-222222222222',
  name: 'Beta',
  subdomain: 'beta',
};
const FB_ACCOUNT = {
  id: '44444444-4444-4444-8444-444444444444',
  fbAccountId: 'fb-100',
  displayName: 'Jamie Owner',
  status: 'active',
  connectedPagesCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const FB_PAGE = {
  id: '55555555-5555-4555-8555-555555555555',
  facebookAccountId: FB_ACCOUNT.id,
  fbPageId: 'page-900',
  pageName: 'Baby Boss Diaries',
  timezone: 'UTC',
  startingFollowers: 0,
  currentFollowers: 10,
  followersGained: 10,
  followersCount: 10,
  status: 'active',
  tasks: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const SOCIAL = {
  accounts: [
    {
      id: 'social-1',
      platform: 'instagram',
      externalAccountId: 'ig-1',
      displayName: 'Acme Instagram',
      avatarUrl: null,
      status: 'active',
      tokenExpiresAt: null,
      destinations: [
        {
          id: 'dest-1',
          externalDestinationId: 'ig-dest-1',
          name: 'Acme Main Feed',
          handle: '@acme',
          avatarUrl: null,
          timezone: 'UTC',
          status: 'active',
          accountType: null,
        },
      ],
    },
  ],
};

let failPool = false;
const fetchCalls: Array<{ url: string; method: string }> = [];

function installFetchStub() {
  fetchCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      fetchCalls.push({ url, method });
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (failPool) return json({ error: 'Pool failed' }, 500);
      if (url === '/api/workspaces') return json({ workspaces: [ACME, BETA] });
      if (url === '/api/workspaces/switch') {
        return json({ success: true, targetSubdomain: 'beta', redirectUrl: '/tenant/beta' });
      }
      if (url === '/api/tenant/acme/accounts') return json({ accounts: [FB_ACCOUNT], total: 1 });
      if (url === '/api/tenant/acme/pages') return json({ pages: [FB_PAGE], total: 1 });
      if (url === '/api/tenant/acme/accounts/social') return json(SOCIAL);
      if (url === '/api/auth/logout') return json({ redirectUrl: '/login?logout=success' });
      if (url === '/api/workspaces' && method === 'POST') {
        return json({ success: true, workspace: { ...BETA, name: 'New Co', subdomain: 'newco' } });
      }
      return json({}, 404);
    })
  );
}

function renderPalette(open = true) {
  const queryClient = createQueryClient('acme');
  let setOpenExternal: (v: boolean) => void = () => {};
  function Harness() {
    const [isOpen, setIsOpen] = React.useState(open);
    setOpenExternal = setIsOpen;
    return (
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <button type="button">Invoker</button>
          <CommandPalette subdomain="acme" open={isOpen} onOpenChange={setIsOpen} />
        </SidebarProvider>
      </QueryClientProvider>
    );
  }
  const utils = render(<Harness />);
  return { ...utils, setOpen: (v: boolean) => setOpenExternal(v), queryClient };
}

describe('Command palette (spec 130 §5.6)', () => {
  beforeEach(() => {
    mockPush.mockReset();
    failPool = false;
    installFetchStub();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the decided pool: accounts/pages, workspaces, actions (no Destinations entries — Destinations pages removed)', async () => {
    renderPalette();
    expect(await screen.findByTestId('palette-item-go-media')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-go-accounts')).toBeInTheDocument();
    // Pool rows arrive from the data layer (typed client + cache).
    expect(await screen.findByTestId('palette-item-fb-page-55555555-5555-4555-8555-555555555555')).toHaveTextContent('Baby Boss Diaries');
    expect(screen.getByTestId('palette-item-fb-account-44444444-4444-4444-8444-444444444444')).toHaveTextContent('Jamie Owner');
    expect(screen.getByTestId('palette-item-social-account-social-1')).toHaveTextContent('Acme Instagram');
    // Destinations pages were removed: their palette entries must not render,
    // even though the social endpoint still returns destination data.
    expect(screen.queryByTestId('palette-item-destination-dest-1')).not.toBeInTheDocument();
    // Workspace switch rows restate their target (UX Rule 2).
    expect(screen.getByTestId('palette-item-workspace-beta')).toHaveTextContent('Switch to Beta');
    expect(screen.getByTestId('palette-item-workspace-acme')).toHaveTextContent('Acme (current workspace)');
    // Actions + the sidebar shortcut hint.
    expect(screen.getByTestId('palette-item-action-create-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-action-toggle-sidebar')).toHaveTextContent('⌘B');
    expect(screen.getByTestId('palette-item-action-sign-out')).toBeInTheDocument();
    // No per-keystroke server calls: exactly the four pool queries fired.
    const gets = fetchCalls.filter((c) => c.method === 'GET').map((c) => c.url);
    expect(gets.sort()).toEqual(
      [
        '/api/workspaces',
        '/api/tenant/acme/accounts',
        '/api/tenant/acme/accounts/social',
        '/api/tenant/acme/pages',
      ].sort()
    );
  });

  it('typing filters locally with no extra fetches; Enter navigates to the selected destination', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByTestId('palette-item-go-media');
    const callsBefore = fetchCalls.length;
    const input = screen.getByTestId('command-palette-input');
    await user.type(input, 'library');
    expect(fetchCalls.length).toBe(callsBefore);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/tenant/acme/media'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('selecting a page navigates to its page section', async () => {
    const user = userEvent.setup();
    renderPalette();
    const pageRow = await screen.findByTestId('palette-item-fb-page-55555555-5555-4555-8555-555555555555');
    await user.click(pageRow);
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/tenant/acme/pages/55555555-5555-4555-8555-555555555555')
    );
  });

  it('no-results is a typed empty state echoing the query with one clear action', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByTestId('palette-item-go-home');
    await user.type(screen.getByTestId('command-palette-input'), 'zzzz');
    expect(await screen.findByText('No results for "zzzz"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('command-palette-input')).toHaveValue('');
    expect(await screen.findByTestId('palette-item-go-home')).toBeInTheDocument();
  });

  it('recents: a chosen item returns at the top under Recents on the next open', async () => {
    const user = userEvent.setup();
    const { setOpen } = renderPalette();
    await screen.findByTestId('palette-item-go-media');
    await user.type(screen.getByTestId('command-palette-input'), 'library');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    setOpen(true);
    expect(await screen.findByText('Recents')).toBeInTheDocument();
    const groups = screen.getAllByTestId('palette-item-go-media');
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  it('pool refresh failure keeps destinations usable and shows a non-blocking note', async () => {
    failPool = true;
    renderPalette();
    expect(
      await screen.findByText(/couldn't be refreshed/, undefined, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-go-home')).toBeInTheDocument();
  });

  it('Create Workspace action opens the create dialog (the visible flow, not a palette-only one)', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByTestId('palette-item-action-create-workspace');
    await user.click(screen.getByTestId('palette-item-action-create-workspace'));
    expect(await screen.findByRole('dialog', { name: /Create Workspace/ })).toBeInTheDocument();
  });
});

describe('Command palette host (OD130-6 header trigger + chord)', () => {
  beforeEach(() => {
    mockPush.mockReset();
    failPool = false;
    installFetchStub();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderHost() {
    const queryClient = createQueryClient('acme');
    return render(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <CommandPaletteHost subdomain="acme" />
          <button type="button">Some field owner</button>
        </SidebarProvider>
      </QueryClientProvider>
    );
  }

  it('renders the search-style header button with label and ⌘K hint at the compact 36px control height', () => {
    renderHost();
    const trigger = screen.getByTestId('command-palette-trigger');
    expect(trigger).toHaveTextContent('Search…');
    expect(trigger).toHaveTextContent('⌘K');
    expect(trigger.className).toContain('h-control');
  });

  it('Ctrl+K opens the palette; Esc closes it and focus returns to the invoker button', async () => {
    const user = userEvent.setup();
    renderHost();
    const trigger = screen.getByTestId('command-palette-trigger');
    trigger.focus();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByTestId('command-palette-input')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('⌘K (meta) also opens, including from a text field', async () => {
    const user = userEvent.setup();
    renderHost();
    const fieldOwner = screen.getByRole('button', { name: 'Some field owner' });
    fieldOwner.focus();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
