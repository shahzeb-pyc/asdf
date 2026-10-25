/**
 * @file workspace-breadcrumb.test.tsx
 * @description Behavioural tests for WorkspaceBreadcrumb +
 * computeBreadcrumbs (Spec 052; migrated to rendered-behaviour
 * assertions by spec 130 PR-130-2a per spec 137 §4.1 duty 8 — the
 * computeBreadcrumbs mapping itself is the parity net and does not
 * change).
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  WorkspaceBreadcrumb,
  computeBreadcrumbs,
} from '@/components/workspace/workspace-breadcrumb';

let mockPathname = '/tenant/acme';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

describe('WorkspaceBreadcrumb (Spec 052)', () => {
  it('computes correct breadcrumb trails across workspace routes', () => {
    expect(computeBreadcrumbs('/tenant/acme', 'acme')).toEqual([{ label: 'Home' }]);
    expect(computeBreadcrumbs('/tenant/acme/', 'acme')).toEqual([{ label: 'Home' }]);
    expect(computeBreadcrumbs('/tenant/acme/media', 'acme')).toEqual([{ label: 'Media Library' }]);
    // Spec 149: /downloader is no longer a curated route — the
    // Downloader entry was deleted from the breadcrumb map with the
    // sidebar leaf (the generic fallback still title-cases unknown
    // segments, which is out of scope for this surface).
    expect(computeBreadcrumbs('/tenant/acme/fdola-studio', 'acme')).toEqual([
      { label: 'Fdola Studio' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/settings', 'acme')).toEqual([{ label: 'Settings' }]);
    expect(computeBreadcrumbs('/tenant/acme/accounts', 'acme')).toEqual([
      { label: 'Facebook' },
      { label: 'Accounts' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/pages', 'acme')).toEqual([
      { label: 'Facebook' },
      { label: 'Pages' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/pages/page-456', 'acme')).toEqual([
      { label: 'Facebook' },
      { label: 'Pages', href: '/tenant/acme/pages' },
      { label: 'Details' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/instagram/accounts', 'acme')).toEqual([
      { label: 'Instagram' },
      { label: 'Accounts' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/threads/accounts', 'acme')).toEqual([
      { label: 'Threads' },
      { label: 'Accounts' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/twitter/accounts', 'acme')).toEqual([
      { label: 'X (Twitter)' },
      { label: 'Accounts' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/tiktok/accounts', 'acme')).toEqual([
      { label: 'TikTok' },
      { label: 'Accounts' },
    ]);
    expect(computeBreadcrumbs('/tenant/acme/youtube/accounts', 'acme')).toEqual([
      { label: 'YouTube' },
      { label: 'Accounts' },
    ]);
    expect(computeBreadcrumbs('', 'acme')).toEqual([{ label: 'Home' }]);
  });

  it('renders the trail with the Pages crumb as a link and the last crumb as the current page', () => {
    mockPathname = '/tenant/acme/pages/page-456';
    render(<WorkspaceBreadcrumb subdomain="acme" />);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(nav).toHaveAttribute('data-testid', 'workspace-breadcrumb');
    expect(screen.getByText('Facebook')).toBeInTheDocument();
    const pagesLink = screen.getByRole('link', { name: 'Pages' });
    expect(pagesLink).toHaveAttribute('href', '/tenant/acme/pages');
    const details = screen.getByText('Details');
    expect(details).toHaveAttribute('aria-current', 'page');
  });

  it('renders a single Home crumb at the tenant root', () => {
    mockPathname = '/tenant/acme';
    render(<WorkspaceBreadcrumb subdomain="acme" />);
    const home = screen.getByText('Home');
    expect(home).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
