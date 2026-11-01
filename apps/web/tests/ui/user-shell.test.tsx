/**
 * @file user-shell.test.tsx
 * @description Frame-composition test for UserShell (shell isolation,
 * spec §9.1): the tenant frame extracted from the old layout must
 * still render its full chrome — skip link first, focusable content
 * region, workspace topbar, banner slot, toaster, children — with
 * exactly the user sidebar sections and zero admin/seller leaves.
 *
 * The palette host and download tray are mocked out: they are
 * accessories with their own tests, and this test proves the frame
 * composition, not their internals.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UserShell } from '@/components/shell/user-shell';
import type { EntitlementResponse } from '@/lib/api/schemas/billing';

const apiGet = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiGet: (...args: unknown[]) => apiGet(...args) };
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/tenant/acme',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

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

vi.mock('@/components/shell/command-palette-host', () => ({
  CommandPaletteHost: () => null,
}));
vi.mock('@/components/shell/download-tray', () => ({
  DownloadTray: () => null,
}));
vi.mock('@/lib/report-error', () => ({
  reportError: vi.fn(),
}));

function paidEntitlement(): EntitlementResponse {
  return {
    plan: 'paid',
    active: true,
    counts: { facebook: 10, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    usage: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    periodEndsAt: '2027-01-01T00:00:00.000Z',
    periodStartsAt: '2026-01-01T00:00:00.000Z',
    canPost: true,
    readOnly: false,
    reason: 'active',
    hasPriorPeriod: true,
  };
}

function renderShell() {
  return render(
    <UserShell
      subdomain="acme"
      useCleanPaths={false}
      user={{ name: 'Owner', email: 'owner@example.com' }}
      workspaceName="Acme Corp"
      sessionUserId="user-1"
      sessionEmail="owner@example.com"
    >
      <div>Workspace Content</div>
    </UserShell>
  );
}

describe('UserShell frame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('/billing/entitlement')) return paidEntitlement();
      if (url.includes('/workspaces')) return { workspaces: [] };
      return {};
    });
  });

  it('renders the full frame chrome with user sections only', async () => {
    const { container } = renderShell();

    // Skip link is the frame's first link and targets the region.
    const links = container.querySelectorAll('a');
    expect(links.length).toBeGreaterThan(0);
    const firstLink = links[0] as HTMLAnchorElement;
    expect(firstLink.getAttribute('href')).toBe('#tenant-content');
    expect(firstLink.textContent).toBe('Skip to content');

    // Content region carries the skip-link target id and is focusable.
    const inset = container.querySelector('#tenant-content');
    expect(inset).not.toBeNull();
    expect(inset?.getAttribute('tabindex')).toBe('-1');

    // Topbar, banner slot, children.
    expect(container.querySelector('[data-testid="workspace-topbar"]')).not.toBeNull();
    expect(container.querySelector('#tenant-banner-slot')).not.toBeNull();
    expect(screen.getByText('Workspace Content')).toBeTruthy();

    // Toaster is mounted in the frame: firing a toast renders it
    // (sonner mounts nothing until the first toast).
    const { toast } = await import('@/components/shared/ui/toast');
    toast('Frame toast probe');
    await waitFor(() => {
      expect(screen.getByText('Frame toast probe')).toBeTruthy();
    });

    // User leaves present, admin/seller leaves absent (after the
    // entitlement query resolves so the plan word settles).
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: 'Media Library' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Subscriptions approval' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sellers' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });
});
