/**
 * @file workspace-sidebar.test.tsx
 * @description Behavioural tests for WorkspaceSidebar (spec 130
 * PR-130-2a migration per spec 137 §4.1 duty 8: the legacy
 * static-markup assertions are replaced by rendered-behaviour
 * assertions — clicks, aria state, optimistic active paint — in the
 * jsdom project. The spec-110 single-click assertions are preserved
 * in substance and strengthened: a leaf click must paint the active
 * state WITHOUT calling router.push and WITHOUT preventDefault,
 * because the leaf is a Next.js <Link> that navigates itself.)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SidebarProvider } from '@/components/shared/ui/sidebar';
import { createQueryClient } from '@/lib/data/query-client';
import { WorkspaceSidebar } from '@/components/workspace/workspace-sidebar';

let mockPathname = '/tenant/acme';
const mockPush = vi.fn();
const mockPrefetch = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: mockPrefetch,
  }),
  // The sidebar reads ?view= for the Billing sub-leaves (added with
  // the subscription feature); no test here sets a query string, so
  // the search params are empty and Billing defaults to My Plan.
  useSearchParams: () => new URLSearchParams(),
}));

// Render next/link as a plain anchor tagged with data-next-link, so
// tests can prove leaves render through Next.js Link (client-side
// routing) rather than hand-rolled raw <a> elements.
vi.mock('next/link', async () => {
  const ReactModule = await import('react');
  type MockLinkProps = {
    href: string;
    children?: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>;
  return {
    default: ({ href, children, ...props }: MockLinkProps) =>
      ReactModule.createElement('a', { href, 'data-next-link': 'true', ...props }, children),
  };
});

function Shell({
  defaultOpen = true,
  subdomain = 'acme',
  adminOnly = false,
}: Readonly<{
  defaultOpen?: boolean;
  subdomain?: string;
  adminOnly?: boolean;
}>) {
  return (
    <QueryClientProvider client={createQueryClient(subdomain)}>
      <SidebarProvider defaultOpen={defaultOpen}>
        <WorkspaceSidebar
          subdomain={subdomain}
          adminOnly={adminOnly}
          user={{ name: 'Jane Doe', email: 'jane@example.com' }}
        />
      </SidebarProvider>
    </QueryClientProvider>
  );
}

describe('WorkspaceSidebar (spec 130 rebuild on shared/ui Sidebar)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/tenant/acme';
    // The switcher footer's workspace-list query (typed client) reads
    // the same response shape as GET /api/workspaces.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            workspaces: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                ownerId: '22222222-2222-4222-8222-222222222222',
                name: 'Acme',
                subdomain: 'acme',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
  });

  it('renders branding as a Home link with the FBUploadPro Studio wordmark', () => {
    render(<Shell />);
    const branding = screen.getByTestId('sidebar-branding-link');
    expect(branding).toHaveAttribute('aria-label', 'FBUploadPro Studio');
    expect(branding).toHaveAttribute('href', '/tenant/acme/');
    expect(branding).toHaveAttribute('data-next-link', 'true');
    expect(within(branding).getByText('FBUploadPro')).toBeInTheDocument();
    expect(within(branding).getByText('Studio')).toBeInTheDocument();
  });

  it('renders the primary leaves in order as Next.js Link anchors (spec 110)', () => {
    render(<Shell />);
    const expected: Array<[string, string]> = [
      ['Home', '/tenant/acme/'],
      ['Media Library', '/tenant/acme/media'],
      ['Fdola Studio', '/tenant/acme/fdola-studio'],
      ['Accounts', '/tenant/acme/accounts'],
      ['Pages', '/tenant/acme/pages'],
    ];
    for (const [label, href] of expected) {
      const link = screen.getByRole('link', { name: new RegExp(`^${label}`) });
      expect(link, label).toHaveAttribute('href', href);
      expect(link, label).toHaveAttribute('data-next-link', 'true');
    }
    // Spec 149: the Downloader leaf is deleted — downloads live in the
    // Media Library now, so no sidebar link may mention it.
    expect(screen.queryByRole('link', { name: /^Downloader/ })).toBeNull();
    // Order: Home -> Media Library -> Fdola Studio.
    const links = screen.getAllByRole('link');
    const labels = links.map((l) => l.textContent || '');
    const homeIdx = labels.findIndex((t) => t.includes('Home'));
    const mediaIdx = labels.findIndex((t) => t.includes('Media Library'));
    const fdolaIdx = labels.findIndex((t) => t.includes('Fdola Studio'));
    expect(mediaIdx).toBeGreaterThan(homeIdx);
    expect(fdolaIdx).toBeGreaterThan(mediaIdx);
  });

  it('spec 110: a single click on a leaf paints it active without router.push or preventDefault', () => {
    render(<Shell />);
    const media = screen.getByRole('link', { name: /^Media Library/ });
    expect(media).not.toHaveAttribute('data-active', 'true');

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(media, clickEvent);

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
    // The optimistic paint: the clicked leaf becomes the active item
    // immediately (≤100ms acknowledgement, spec §8 UX-24).
    expect(media).toHaveAttribute('data-active', 'true');
    expect(media).toHaveAttribute('aria-current', 'page');
  });

  it('marks the active leaf from the pathname (prefix match; Home exact)', () => {
    mockPathname = '/tenant/acme/media';
    render(<Shell />);
    expect(screen.getByRole('link', { name: /^Media Library/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('link', { name: /^Home/ })).not.toHaveAttribute('aria-current');
  });

  it('marks Pages (not Accounts) active on a page-detail path', () => {
    mockPathname = '/tenant/acme/pages/page-uuid-123';
    render(<Shell />);
    expect(screen.getByRole('link', { name: /^Pages/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^Accounts/ })).not.toHaveAttribute('aria-current');
  });

  it('Facebook group is a collapsible toggle button, open by default, that hides its leaves when closed', () => {
    render(<Shell />);
    const toggle = screen.getByRole('button', { name: /Facebook/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /^Pages/ })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /^Pages/ })).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /^Pages/ })).toBeInTheDocument();
  });

  it('renders all upcoming platforms in order below Facebook', () => {
    render(<Shell />);
    const buttons = screen.getAllByRole('button').map((b) => b.textContent || '');
    const order = ['Facebook', 'Instagram', 'Threads', 'X (Twitter)', 'TikTok', 'YouTube'].map(
      (label) => buttons.findIndex((t) => t.includes(label))
    );
    for (const idx of order) expect(idx).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('opening Threads shows its Accounts leaf with no testing note, while a still-testing platform shows ONLY the note (no Accounts leaf)', () => {
    mockPathname = '/tenant/acme/threads/accounts';
    render(<Shell />);
    // The active platform group opens by default. Threads is no longer
    // testing: opening it shows its Accounts leaf with no testing note
    // underneath, like Instagram.
    expect(screen.queryByTestId('sidebar-testing-note-threads')).not.toBeInTheDocument();
    const threadsLeaves = screen
      .getAllByRole('link', { name: /^Accounts/ })
      .map((l) => l.getAttribute('href'));
    expect(threadsLeaves).toContain('/tenant/acme/threads/accounts');

    // Instagram is no longer testing: opening it shows its Accounts leaf
    // with no testing note underneath.
    fireEvent.click(screen.getByRole('button', { name: /Instagram/ }));
    expect(screen.queryByTestId('sidebar-testing-note-instagram')).not.toBeInTheDocument();

    // A platform that is still testing (X) shows ONLY the note — its
    // Accounts leaf is removed, so no X accounts link may exist.
    fireEvent.click(screen.getByRole('button', { name: /X \(Twitter\)/ }));
    expect(screen.getByTestId('sidebar-testing-note-x')).toHaveTextContent(
      'Being tested — not available for public use'
    );
    const accountsLeaves = screen
      .getAllByRole('link', { name: /^Accounts/ })
      .map((l) => l.getAttribute('href'));
    expect(accountsLeaves).toContain('/tenant/acme/instagram/accounts');
    expect(accountsLeaves).not.toContain('/tenant/acme/x/accounts');
  });

  it('testing platforms (X, TikTok, YouTube) show only the testing note and no Accounts leaf', () => {
    render(<Shell />);
    for (const [label, key] of [
      ['X (Twitter)', 'x'],
      ['TikTok', 'tiktok'],
      ['YouTube', 'youtube'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(label.replace(/[()]/g, '\\$&')) }));
      expect(screen.getByTestId(`sidebar-testing-note-${key}`)).toBeInTheDocument();
    }
    // Open the non-testing platforms too, so their leaves are rendered.
    fireEvent.click(screen.getByRole('button', { name: /Instagram/ }));
    fireEvent.click(screen.getByRole('button', { name: /Threads/ }));
    const hrefs = screen
      .getAllByRole('link', { name: /^Accounts/ })
      .map((l) => l.getAttribute('href'));
    expect(hrefs).not.toContain('/tenant/acme/x/accounts');
    expect(hrefs).not.toContain('/tenant/acme/tiktok/accounts');
    expect(hrefs).not.toContain('/tenant/acme/youtube/accounts');
    // Facebook, Instagram and Threads keep their Accounts leaves.
    expect(hrefs).toContain('/tenant/acme/accounts');
    expect(hrefs).toContain('/tenant/acme/instagram/accounts');
    expect(hrefs).toContain('/tenant/acme/threads/accounts');
  });

  it('every non-testing platform Accounts leaf href is a tenant Link href (spec 110)', () => {
    render(<Shell />);
    for (const label of ['Instagram', 'Threads', 'X (Twitter)', 'TikTok', 'YouTube']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(label.replace(/[()]/g, '\\$&')) }));
    }
    const hrefs = screen
      .getAllByRole('link', { name: /^Accounts/ })
      .map((l) => l.getAttribute('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/tenant/acme/accounts',
        '/tenant/acme/instagram/accounts',
        '/tenant/acme/threads/accounts',
      ])
    );
    expect(hrefs).not.toContain('/tenant/acme/x/accounts');
    expect(hrefs).not.toContain('/tenant/acme/tiktok/accounts');
    expect(hrefs).not.toContain('/tenant/acme/youtube/accounts');
  });

  it('in icon-collapsed mode the Facebook toggle navigates via router.push (spec 110 parent model)', () => {
    render(<Shell defaultOpen={false} />);
    const toggle = screen.getByRole('button', { name: /Facebook/ });
    fireEvent.click(toggle);
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/accounts');
  });

  it('in icon-collapsed mode a testing platform header never navigates to its accounts route', () => {
    render(<Shell defaultOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: /X \(Twitter\)/ }));
    expect(mockPush).not.toHaveBeenCalled();
    // The click only expands the group, revealing the testing note.
    expect(screen.getByTestId('sidebar-testing-note-x')).toBeInTheDocument();
    // Non-testing platforms keep the collapsed navigate behaviour.
    fireEvent.click(screen.getByRole('button', { name: /Instagram/ }));
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/instagram/accounts');
  });

  it('renders the studio footer trigger with workspace identity and user email', () => {
    render(<Shell />);
    const trigger = screen.getByTestId('workspace-switcher-trigger');
    expect(trigger).toHaveAttribute('aria-label', 'Workspace and profile menu');
    expect(screen.getByTestId('workspace-user-avatar')).toHaveTextContent('AC');
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
  });
});

describe('WorkspaceSidebar header plan word', () => {
  const ZERO_COUNTS = {
    facebook: 0,
    instagram: 0,
    threads: 0,
    x: 0,
    tiktok: 0,
    youtube: 0,
  };

  const WORKSPACES_PAYLOAD = {
    workspaces: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        ownerId: '22222222-2222-4222-222222222222',
        name: 'Acme',
        subdomain: 'acme',
      },
    ],
  };

  function entitlementPayload(overrides: Record<string, unknown> = {}) {
    return {
      plan: 'free',
      active: false,
      counts: ZERO_COUNTS,
      usage: ZERO_COUNTS,
      periodEndsAt: null,
      periodStartsAt: null,
      canPost: false,
      readOnly: true,
      reason: null,
      hasPriorPeriod: false,
      ...overrides,
    };
  }

  function stubFetchWithEntitlement(entitlement: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string' ? input : ((input as { url?: string }).url ?? '');
        const body = url.includes('billing/entitlement')
          ? entitlement
          : WORKSPACES_PAYLOAD;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
  }

  function branding() {
    return screen.getByTestId('sidebar-branding-link');
  }

  it('shows Paid for an active paid period and leaves the Fdola Studio leaf untouched', async () => {
    stubFetchWithEntitlement(
      entitlementPayload({
        plan: 'paid',
        active: true,
        canPost: true,
        readOnly: false,
        periodEndsAt: '2026-07-01T00:00:00.000Z',
        periodStartsAt: '2026-06-01T00:00:00.000Z',
      })
    );
    render(<Shell />);
    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(within(branding()).queryByText('Studio')).toBeNull();
    expect(screen.getByRole('link', { name: /^Fdola Studio/ })).toHaveTextContent(
      'Fdola Studio'
    );
  });

  it('shows Free when no period was ever held', async () => {
    stubFetchWithEntitlement(entitlementPayload());
    render(<Shell />);
    expect(await screen.findByText('Free')).toBeInTheDocument();
  });

  it('shows Expired when the period lapsed (not Free)', async () => {
    stubFetchWithEntitlement(entitlementPayload({ hasPriorPeriod: true }));
    render(<Shell />);
    expect(await screen.findByText('Expired')).toBeInTheDocument();
  });

  it('shows Admin for the admin shell without waiting on an entitlement', () => {
    render(<Shell adminOnly />);
    expect(within(branding()).getByText('Admin')).toBeInTheDocument();
  });

  it('keeps the Studio placeholder when the entitlement fetch fails (never a failed-as-Free word)', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string' ? input : ((input as { url?: string }).url ?? '');
      if (url.includes('billing/entitlement')) {
        return new Response(JSON.stringify({ error: 'db down' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(WORKSPACES_PAYLOAD), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Shell />);
    // The entitlement query retries once before settling into its
    // error state; wait until that retry has fired so the assertion
    // runs against the settled error state, not the loading state.
    await waitFor(
      () => {
        const entitlementCalls = fetchMock.mock.calls.filter(([input]) => {
          const url =
            typeof input === 'string' ? input : ((input as { url?: string }).url ?? '');
          return url.includes('billing/entitlement');
        });
        expect(entitlementCalls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000 }
    );
    expect(within(branding()).getByText('Studio')).toBeInTheDocument();
    expect(within(branding()).queryByText('Free')).toBeNull();
    expect(within(branding()).queryByText('Paid')).toBeNull();
    expect(within(branding()).queryByText('Expired')).toBeNull();
  });

  it('keeps the Studio placeholder while the entitlement is unresolved', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string' ? input : ((input as { url?: string }).url ?? '');
        if (url.includes('billing/entitlement')) {
          return new Promise<Response>(() => {});
        }
        return new Response(JSON.stringify(WORKSPACES_PAYLOAD), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    render(<Shell />);
    expect(within(branding()).getByText('Studio')).toBeInTheDocument();
  });
});
