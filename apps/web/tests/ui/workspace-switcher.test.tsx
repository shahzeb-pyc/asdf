/**
 * @file workspace-switcher.test.tsx
 * @description Behavioural tests for the decomposed workspace
 * switcher / studio footer (spec 130 §5.3, PR-130-2b — replaces
 * tests/ui/workspace-studio-footer.test.tsx). The footer now reads
 * its workspace list through React Query over the typed API client,
 * so the suite stubs `fetch` at the client's seam and asserts on
 * rendered behaviour: popover contents and order, switch / sign-out
 * / theme flows, and the failure presentations that were silent in
 * the legacy file (spec §6 duty 2).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { SidebarProvider } from '@/components/shared/ui/sidebar';
import { createQueryClient } from '@/lib/data/query-client';
import { getPreference, preferences } from '@/lib/storage/preferences';
import { WorkspaceStudioFooter } from '@/components/workspace/workspace-switcher';
import { SwitcherActionsList } from '@/components/workspace/workspace-switcher-actions';
import { SwitcherWorkspaceList } from '@/components/workspace/workspace-switcher-list';
import {
  broadcastLogout,
  getMonogram,
} from '@/components/workspace/workspace-switcher-utils';
import {
  CreateWorkspaceModal,
  createWorkspaceFormSchema,
} from '@/components/workspace/create-workspace-modal';

const mockPathname = '/tenant/acme';
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
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

interface FetchScript {
  listStatus?: number;
  switchStatus?: number;
  switchError?: string;
  createStatus?: number;
  workspaces?: Array<typeof ACME>;
}

let fetchScript: FetchScript = {};
const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];

function installFetchStub() {
  fetchCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      fetchCalls.push({ url, method, body });
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (url === '/api/workspaces' && method === 'GET') {
        if (fetchScript.listStatus && fetchScript.listStatus >= 400) {
          return json({ error: 'List failed' }, fetchScript.listStatus);
        }
        return json({ workspaces: fetchScript.workspaces ?? [ACME, BETA] });
      }
      if (url === '/api/workspaces/switch') {
        if (fetchScript.switchStatus && fetchScript.switchStatus >= 400) {
          return json(
            { error: fetchScript.switchError ?? 'Switch failed' },
            fetchScript.switchStatus
          );
        }
        return json({
          success: true,
          targetSubdomain: 'beta',
          redirectUrl: '/tenant/beta',
        });
      }
      if (url === '/api/workspaces' && method === 'POST') {
        if (fetchScript.createStatus && fetchScript.createStatus >= 400) {
          return json({ error: 'Create failed' }, fetchScript.createStatus);
        }
        return json({
          success: true,
          workspace: {
            id: '44444444-4444-4444-8444-444444444444',
            ownerId: ACME.ownerId,
            name: 'New Co',
            subdomain: 'newco',
            createdAt: '2026-10-23T00:00:00.000Z',
            updatedAt: '2026-10-23T00:00:00.000Z',
          },
        });
      }
      if (url === '/api/auth/logout') {
        return json({ redirectUrl: '/login?logout=success' });
      }
      return json({});
    })
  );
}

function Footer({
  onNavigate,
}: Readonly<{ onNavigate?: (href: string) => void }> = {}) {
  return (
    <QueryClientProvider client={createQueryClient('acme')}>
      <SidebarProvider>
        <WorkspaceStudioFooter
          subdomain="acme"
          user={{ name: 'Jane Doe', email: 'jane@example.com' }}
          onNavigate={onNavigate}
        />
      </SidebarProvider>
    </QueryClientProvider>
  );
}

describe('workspace switcher utils', () => {
  it('computes monograms accurately for single and multi-word names', () => {
    expect(getMonogram('Alex Mercer')).toBe('AM');
    expect(getMonogram('SingleWord')).toBe('SI');
    expect(getMonogram('Three Word Name')).toBe('TW');
    expect(getMonogram('')).toBe('WS');
  });

  it('dispatches the cross-tab logout event when broadcastLogout is called', () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    class MockBroadcastChannel {
      postMessage = postMessage;
      close = close;
    }
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

    broadcastLogout();

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'LOGOUT' }));
  });
});

describe('WorkspaceStudioFooter (decomposed switcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchScript = {};
    installFetchStub();
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add('dark');
  });

  it('renders the trigger with workspace identity, email, and monogram avatar', async () => {
    render(<Footer />);
    const trigger = screen.getByTestId('workspace-switcher-trigger');
    expect(trigger).toHaveAttribute('aria-label', 'Workspace and profile menu');
    expect(screen.getByTestId('workspace-user-avatar')).toHaveTextContent('AC');
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    // The server-provided fallback name gives way to the loaded list name.
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });

  it('opens the popover with user header, workspace list, create, settings, theme, sign-out in order', async () => {
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));

    expect(await screen.findByTestId('workspace-option-beta')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-option-acme')).toBeInTheDocument();
    expect(screen.getByTestId('create-workspace-button')).toHaveTextContent('Create Workspace');
    expect(screen.getByTestId('workspace-settings-button')).toHaveTextContent('Settings');
    expect(screen.getByTestId('theme-toggle-button')).toHaveTextContent('Light Mode');
    expect(screen.getByTestId('logout-button')).toHaveTextContent('Sign Out');
    // Popover user header names the real session identity — never a
    // fabricated address (spec 137 §4.4).
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText(/@fbuploadpro\.com/)).not.toBeInTheDocument();
  });

  it('selecting the current workspace just closes the popover (no switch request)', async () => {
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));
    await user.click(await screen.findByTestId('workspace-option-acme'));
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-option-beta')).not.toBeInTheDocument();
    });
    expect(fetchCalls.some((c) => c.url === '/api/workspaces/switch')).toBe(false);
  });

  it('switches workspace through the typed client mutation', async () => {
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));
    await user.click(await screen.findByTestId('workspace-option-beta'));
    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) =>
            c.url === '/api/workspaces/switch' &&
            c.method === 'POST' &&
            (c.body as { subdomain: string }).subdomain === 'beta'
        )
      ).toBe(true);
    });
  });

  it('surfaces a switch failure in the popover and clears the switching state', async () => {
    fetchScript = { switchStatus: 500, switchError: 'You do not have access to this workspace' };
    installFetchStub();
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));
    await user.click(await screen.findByTestId('workspace-option-beta'));

    expect(
      await screen.findByText('You do not have access to this workspace')
    ).toBeInTheDocument();
    const beta = await screen.findByTestId('workspace-option-beta');
    expect(beta).not.toBeDisabled();
  });

  it('shows the current workspace + message + Retry when the list fails to load', async () => {
    fetchScript = { listStatus: 500 };
    installFetchStub();
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));

    expect(await screen.findByText("Couldn't load your workspaces.")).toBeInTheDocument();
    expect(screen.getByTestId('workspace-list-retry')).toBeInTheDocument();

    fetchScript = {};
    await user.click(screen.getByTestId('workspace-list-retry'));
    expect(await screen.findByTestId('workspace-option-beta')).toBeInTheDocument();
  });

  it('Settings closes the popover and navigates through the onNavigate seam', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<Footer onNavigate={onNavigate} />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));
    await user.click(await screen.findByTestId('workspace-settings-button'));
    expect(onNavigate).toHaveBeenCalledWith('/tenant/acme/settings');
  });

  it('theme toggle flips the document theme, writes the typed preference and the fbup_theme cookie', async () => {
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));
    await user.click(await screen.findByTestId('theme-toggle-button'));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(getPreference(preferences.theme)).toBe('light');
    expect(document.cookie).toContain('fbup_theme=light');
    expect(await screen.findByTestId('theme-toggle-button')).toHaveTextContent('Dark Mode');
  });

  it('sign-out posts to the typed client and broadcasts logout to other tabs', async () => {
    const postMessage = vi.fn();
    class MockBroadcastChannel {
      postMessage = postMessage;
      close = vi.fn();
    }
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));
    await user.click(await screen.findByTestId('logout-button'));

    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url === '/api/auth/logout' && c.method === 'POST')).toBe(
        true
      );
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'LOGOUT' }));
  });
});

describe('workspace list scroll region (spec 199)', () => {
  function twentyWorkspaces() {
    return Array.from({ length: 20 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      ownerId: ACME.ownerId,
      name: `Workspace ${i + 1}`,
      subdomain: `ws${i + 1}`,
    }));
  }

  function List({
    workspaces,
    currentSubdomain = 'ws1',
    isLoadingList = false,
    listError = null,
    switchError = null,
  }: Readonly<{
    workspaces: Array<{ id: string; ownerId: string; name: string; subdomain: string }>;
    currentSubdomain?: string;
    isLoadingList?: boolean;
    listError?: string | null;
    switchError?: string | null;
  }>) {
    return (
      <SwitcherWorkspaceList
        workspaces={workspaces}
        currentSubdomain={currentSubdomain}
        isSwitching={false}
        isLoadingList={isLoadingList}
        listError={listError}
        switchError={switchError}
        onSelectWorkspace={vi.fn()}
        onRetryList={vi.fn()}
        onOpenCreate={vi.fn()}
      />
    );
  }

  it('wraps only the workspace rows in a ~6-row scroll region; Create stays outside it', () => {
    render(<List workspaces={twentyWorkspaces()} />);

    const region = screen.getByTestId('workspace-list-scroll-region');
    expect(region.className).toContain('max-h-66');
    expect(region.className).toContain('overflow-y-auto');
    expect(within(region).getAllByRole('menuitem')).toHaveLength(20);
    // Create Workspace is pinned below the region, never scrolled away.
    expect(within(region).queryByTestId('create-workspace-button')).toBeNull();
    expect(screen.getByTestId('create-workspace-button')).toBeInTheDocument();
  });

  it('scrolls the active row into view on open — nearest, instant, on the active row', () => {
    const scrollMock = vi.fn();
    // jsdom does not implement scrollIntoView; read it through an
    // unknown-typed slot so the restore below typechecks.
    const proto = Element.prototype as unknown as {
      scrollIntoView?: unknown;
    };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollMock;
    try {
      render(<List workspaces={twentyWorkspaces()} currentSubdomain="ws15" />);

      expect(scrollMock).toHaveBeenCalled();
      expect(scrollMock.mock.calls[0]?.[0]).toEqual({ block: 'nearest', behavior: 'auto' });
      expect(scrollMock.mock.instances[0]).toBe(screen.getByTestId('workspace-option-ws15'));
    } finally {
      if (original === undefined) {
        delete proto.scrollIntoView;
      } else {
        proto.scrollIntoView = original;
      }
    }
  });

  it('keeps error alerts above the scroll region and the loading line below it', () => {
    render(
      <List
        workspaces={[ACME]}
        currentSubdomain="acme"
        isLoadingList={true}
        listError="Couldn't load your workspaces."
        switchError="Couldn't switch workspace. Please try again."
      />
    );

    const region = screen.getByTestId('workspace-list-scroll-region');
    expect(within(region).queryByRole('alert')).toBeNull();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(region.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    }
    const loading = screen.getByText('Loading workspaces…');
    expect(region.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(loading.compareDocumentPosition(screen.getByTestId('create-workspace-button')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with 20 workspaces the popover keeps every action pinned outside the region', async () => {
    const workspaces = twentyWorkspaces();
    // The active workspace sits deep in the list (index 14).
    workspaces[14] = { ...ACME, name: 'Acme' };
    fetchScript = { workspaces };
    installFetchStub();
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByTestId('workspace-switcher-trigger'));

    await screen.findByTestId('workspace-option-ws20');
    const region = screen.getByTestId('workspace-list-scroll-region');
    expect(within(region).getAllByRole('menuitem')).toHaveLength(20);
    expect(within(region).queryByTestId('create-workspace-button')).toBeNull();
    expect(within(region).queryByTestId('workspace-settings-button')).toBeNull();
    expect(within(region).queryByTestId('theme-toggle-button')).toBeNull();
    expect(within(region).queryByTestId('logout-button')).toBeNull();
    // Header and actions are still present in the popover.
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByTestId('create-workspace-button')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-settings-button')).toBeInTheDocument();
    expect(screen.getByTestId('logout-button')).toBeInTheDocument();
  });
});

describe('SwitcherActionsList sign-out states', () => {
  it('renders the Sign Out button enabled when not signing out', () => {
    render(
      <SwitcherActionsList
        currentSubdomain="acme"
        isThemeDark={true}
        isSettingsActive={false}
        isSigningOut={false}
        onOpenSettings={vi.fn()}
        onToggleTheme={vi.fn()}
        onSignOut={vi.fn()}
      />
    );
    const button = screen.getByTestId('logout-button');
    expect(button).toHaveTextContent('Sign Out');
    expect(button).not.toBeDisabled();
  });

  it('renders the disabled "Signing out..." state while signing out', () => {
    render(
      <SwitcherActionsList
        currentSubdomain="acme"
        isThemeDark={true}
        isSettingsActive={false}
        isSigningOut={true}
        onOpenSettings={vi.fn()}
        onToggleTheme={vi.fn()}
        onSignOut={vi.fn()}
      />
    );
    const button = screen.getByTestId('logout-button');
    expect(button).toHaveTextContent('Signing out...');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('invokes onSignOut when the logout button is clicked', async () => {
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(
      <SwitcherActionsList
        currentSubdomain="acme"
        isThemeDark={true}
        isSettingsActive={false}
        isSigningOut={false}
        onOpenSettings={vi.fn()}
        onToggleTheme={vi.fn()}
        onSignOut={onSignOut}
      />
    );
    await user.click(screen.getByTestId('logout-button'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('CreateWorkspaceModal (Dialog + form standard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchScript = {};
    installFetchStub();
  });

  it('validates with the §4.2 messages verbatim', () => {
    expect(createWorkspaceFormSchema.safeParse({ name: '' }).success).toBe(false);
    const empty = createWorkspaceFormSchema.safeParse({ name: '  ' });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toBe('Please provide a workspace name.');
    }
    const short = createWorkspaceFormSchema.safeParse({ name: 'a' });
    expect(short.success).toBe(false);
    if (!short.success) {
      expect(short.error.issues[0]?.message).toBe(
        'Workspace name must be at least 2 characters long.'
      );
    }
  });

  it('creates through the typed client and hands the workspace to onSuccess', async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient('acme')}>
        <CreateWorkspaceModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />
      </QueryClientProvider>
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Create Workspace', { selector: 'h2, [data-slot="dialog-title"]' })).toBeInTheDocument();
    const input = screen.getByLabelText('Workspace Name');
    expect(input).toHaveAttribute('placeholder', 'e.g. Acme Media or Brand Name');
    await user.type(input, 'New Co');
    await user.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Co', subdomain: 'newco' })
      );
    });
    expect(
      fetchCalls.some(
        (c) =>
          c.url === '/api/workspaces' &&
          c.method === 'POST' &&
          (c.body as { name: string }).name === 'New Co'
      )
    ).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the typed input and shows the server error when creation fails', async () => {
    fetchScript = { createStatus: 500 };
    installFetchStub();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient('acme')}>
        <CreateWorkspaceModal isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
      </QueryClientProvider>
    );

    const input = screen.getByLabelText('Workspace Name');
    await user.type(input, 'New Co');
    await user.click(screen.getByTestId('create-workspace-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Create failed');
    expect(input).toHaveValue('New Co');
  });
});
