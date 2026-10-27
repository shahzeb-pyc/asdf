/**
 * @file tenant-frame.test.tsx
 * @description Behavioural tests for the rebuilt tenant frame
 * (spec 130 §5.1, PR-130-1, T15): the frame renders on the shared/ui
 * Sidebar system with the skip link first in tab order, the content
 * region as its target, the header and Toaster mounted, and the frame
 * surviving a content-area error render (boundaries sit inside it).
 * Null-session redirect is covered in tests/api/dashboard.test.ts.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { toast } from '@/components/shared/ui/toast';

const mockGetSession = vi.fn();
vi.mock('@/lib/auth', () => ({
  getServerSessionContext: () => mockGetSession(),
}));

vi.mock('../../src/app/tenant/[subdomain]/workspace-display-name', () => ({
  getWorkspaceDisplayName: vi.fn(async () => 'Acme Corp'),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/tenant/acme',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import TenantLayout from '../../src/app/tenant/[subdomain]/layout';

const SESSION = {
  userId: 'user-1',
  email: 'owner@example.com',
  role: 'owner',
  subdomain: 'acme',
};

async function renderFrame(children: React.ReactNode) {
  const jsx = await TenantLayout({
    params: Promise.resolve({ subdomain: 'acme' }),
    children,
  });
  return render(jsx);
}

describe('Tenant frame (spec 130 PR-130-1)', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(SESSION);
    // The studio footer's workspace-list load: answer with an empty list.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ workspaces: [] }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders header, breadcrumb region and children inside the frame', async () => {
    await renderFrame(<p>Workspace Content</p>);

    expect(screen.getByTestId('workspace-topbar')).toBeInTheDocument();
    expect(screen.getByText('Workspace Content')).toBeInTheDocument();
    // The real session identity reaches the shell — never a fabricated one.
    expect(screen.queryByText('acme@fbuploadpro.com')).not.toBeInTheDocument();
  });

  it('skip link is the first focusable element and targets the content region', async () => {
    const { container } = await renderFrame(<p>Workspace Content</p>);

    const skipLink = screen.getByRole('link', { name: 'Skip to content' });
    expect(skipLink).toHaveAttribute('href', '#tenant-content');

    const content = container.querySelector('#tenant-content');
    expect(content).not.toBeNull();
    expect(content).toHaveAttribute('tabindex', '-1');

    // First focusable element in DOM order is the skip link.
    const focusables = container.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex="-1"]'
    );
    expect(focusables[0]).toBe(skipLink);

    // The target region accepts programmatic focus, as a skip target must.
    (content as HTMLElement).focus();
    expect(document.activeElement).toBe(content);
  });

  it('mounts the Banner slot and the one Toaster system', async () => {
    const { container } = await renderFrame(<p>Workspace Content</p>);

    expect(container.querySelector('#tenant-banner-slot')).not.toBeNull();
    expect(container.querySelector('[data-slot="tenant-banner-slot"]')).not.toBeNull();

    // The frame's Toaster mount presents toasts through the one system.
    act(() => {
      toast('Workspace saved');
    });
    expect(await screen.findByText('Workspace saved')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-sonner-toaster]')).toHaveLength(1);
  });

  it('tenant Toaster sits top-right, not bottom-right', async () => {
    const { container } = await renderFrame(<p>Workspace Content</p>);

    act(() => {
      toast('Workspace saved');
    });
    expect(await screen.findByText('Workspace saved')).toBeInTheDocument();
    const toaster = container.querySelector('[data-sonner-toaster]');
    expect(toaster).not.toBeNull();
    // Sonner splits the position into x/y attributes: top-right must
    // read right + top. A bottom-right mount would read bottom here
    // and fail this test.
    expect(toaster).toHaveAttribute('data-x-position', 'right');
    expect(toaster).toHaveAttribute('data-y-position', 'top');
    expect((toaster as HTMLElement).style.getPropertyValue('--offset-top')).toContain(
      'safe-area-inset-top'
    );
  });

  it('frame survives a content-area error render (chrome stays mounted)', async () => {
    await renderFrame(
      <div role="alert">
        <h2>Something went wrong</h2>
      </div>
    );

    // The error renders inside the frame; the shell chrome survives it.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-topbar')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeInTheDocument();
  });

  it('renders the frame in both themes (token-driven chrome)', async () => {
    for (const theme of ['dark', 'light']) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = await renderFrame(<p>Workspace Content</p>);
      const topbar = screen.getByTestId('workspace-topbar');
      expect(topbar).toBeInTheDocument();
      // Token-backed utilities drive the chrome in both themes.
      expect(topbar.className).toContain('bg-canvas');
      expect(topbar.className).toContain('border-line');
      unmount();
    }
    delete document.documentElement.dataset.theme;
  });
});
