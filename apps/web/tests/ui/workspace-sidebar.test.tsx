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
import { render, screen, fireEvent, within } from '@testing-library/react';
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
}: Readonly<{ defaultOpen?: boolean; subdomain?: string }>) {
  return (
    <QueryClientProvider client={createQueryClient(subdomain)}>
      <SidebarProvider defaultOpen={defaultOpen}>
        <WorkspaceSidebar
          subdomain={subdomain}
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
      ['Downloader', '/tenant/acme/downloader'],
      ['Fdola Studio', '/tenant/acme/fdola-studio'],
      ['Accounts', '/tenant/acme/accounts'],
      ['Pages', '/tenant/acme/pages'],
    ];
    for (const [label, href] of expected) {
      const link = screen.getByRole('link', { name: new RegExp(`^${label}`) });
      expect(link, label).toHaveAttribute('href', href);
      expect(link, label).toHaveAttribute('data-next-link', 'true');
    }
    // Order: Home -> Media Library -> Downloader -> Fdola Studio.
    const links = screen.getAllByRole('link');
    const labels = links.map((l) => l.textContent || '');
    const homeIdx = labels.findIndex((t) => t.includes('Home'));
    const mediaIdx = labels.findIndex((t) => t.includes('Media Library'));
    const downloaderIdx = labels.findIndex((t) => t.includes('Downloader'));
    const fdolaIdx = labels.findIndex((t) => t.includes('Fdola Studio'));
    expect(mediaIdx).toBeGreaterThan(homeIdx);
    expect(downloaderIdx).toBeGreaterThan(mediaIdx);
    expect(fdolaIdx).toBeGreaterThan(downloaderIdx);
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

  it('opening a still-testing platform shows its Accounts leaf and the testing note, while Instagram shows no testing note', () => {
    mockPathname = '/tenant/acme/threads/accounts';
    render(<Shell />);
    // The active platform group opens by default.
    expect(screen.getByTestId('sidebar-testing-note-threads')).toHaveTextContent(
      'Being tested — not available for public use'
    );
    const threadsLeaves = screen
      .getAllByRole('link', { name: /^Accounts/ })
      .map((l) => l.getAttribute('href'));
    expect(threadsLeaves).toContain('/tenant/acme/threads/accounts');

    // Instagram is no longer testing: opening it shows its Accounts leaf
    // with no testing note underneath.
    fireEvent.click(screen.getByRole('button', { name: /Instagram/ }));
    expect(screen.queryByTestId('sidebar-testing-note-instagram')).not.toBeInTheDocument();
    const accountsLeaves = screen
      .getAllByRole('link', { name: /^Accounts/ })
      .map((l) => l.getAttribute('href'));
    expect(accountsLeaves).toContain('/tenant/acme/instagram/accounts');
  });

  it('every platform Accounts leaf href is a tenant Link href (spec 110)', () => {
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
        '/tenant/acme/x/accounts',
        '/tenant/acme/tiktok/accounts',
        '/tenant/acme/youtube/accounts',
      ])
    );
  });

  it('in icon-collapsed mode the Facebook toggle navigates via router.push (spec 110 parent model)', () => {
    render(<Shell defaultOpen={false} />);
    const toggle = screen.getByRole('button', { name: /Facebook/ });
    fireEvent.click(toggle);
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/accounts');
  });

  it('renders the studio footer trigger with workspace identity and user email', () => {
    render(<Shell />);
    const trigger = screen.getByTestId('workspace-switcher-trigger');
    expect(trigger).toHaveAttribute('aria-label', 'Workspace and profile menu');
    expect(screen.getByTestId('workspace-user-avatar')).toHaveTextContent('AC');
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
  });
});
