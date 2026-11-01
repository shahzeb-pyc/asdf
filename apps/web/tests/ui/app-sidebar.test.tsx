/**
 * @file app-sidebar.test.tsx
 * @description Separation-matrix + behaviour tests for the unified
 * AppSidebar (shell isolation, spec §9.1). The three section
 * configs must render EXACTLY their role's leaves and ZERO leaves
 * of any other role — absence assertions are the point of the
 * rule — and their href sets must be pairwise disjoint.
 *
 * Behaviour carried over from the old workspace sidebar (spec 110
 * single-click model): a leaf click paints the active state WITHOUT
 * calling router.push (the leaf is a Next.js <Link> that navigates
 * itself), while a collapsible parent toggle in icon-collapsed mode
 * navigates via router.push.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarProvider } from '@/components/shared/ui/sidebar';
import { AppSidebar } from '@/components/shell/app-sidebar';
import {
  getUserSections,
  SELLER_SECTIONS,
  ADMIN_SECTIONS,
  type SidebarSections,
  type SidebarItem,
} from '@/components/shell/sidebar-sections';

let mockPathname = '/tenant/acme';
let mockSearch = new URLSearchParams();
const mockPush = vi.fn();
const mockPrefetch = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: mockPrefetch,
  }),
  useSearchParams: () => mockSearch,
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

function allHrefs(sections: SidebarSections): string[] {
  const hrefs: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      if (item.kind === 'leaf') {
        hrefs.push(item.href);
      } else {
        hrefs.push(...item.leaves.map((leaf) => leaf.href));
      }
    }
  }
  return hrefs;
}

function allLabels(sections: SidebarSections): string[] {
  const labels: string[] = [];
  const walk = (items: SidebarItem[]) => {
    for (const item of items) {
      if (item.kind === 'leaf') labels.push(item.label);
      else labels.push(...item.leaves.map((leaf) => leaf.label));
    }
  };
  for (const section of sections) walk(section.items);
  return labels;
}

function renderSidebar(
  sections: SidebarSections,
  opts: { defaultOpen?: boolean; collapsible?: 'offcanvas' | 'icon' | 'none' } = {}
) {
  return render(
    <SidebarProvider defaultOpen={opts.defaultOpen ?? true}>
      <AppSidebar
        sections={sections}
        headerWord="Studio"
        brandingHref="/seller"
        collapsible={opts.collapsible ?? 'offcanvas'}
        footer={<div>footer</div>}
      />
    </SidebarProvider>
  );
}

const USER_FORBIDDEN = ['Subscriptions approval', 'Sellers', 'Dashboard'];
const ADMIN_FORBIDDEN = [
  'Home',
  'Media Library',
  'Fdola Studio',
  'Prompt Library',
  'Creator Finder',
  'Facebook',
  'Billing',
  'Dashboard',
];
const SELLER_FORBIDDEN = [
  'Home',
  'Media Library',
  'Fdola Studio',
  'Prompt Library',
  'Creator Finder',
  'Facebook',
  'Billing',
  'Subscriptions approval',
  'Sellers',
];

describe('sidebar section configs (structural)', () => {
  it('user sections are exactly the user list, in order', () => {
    const sections = getUserSections('acme', false);
    const labels = allLabels(sections);
    expect(labels).toEqual([
      'Home',
      'Media Library',
      'Fdola Studio',
      'Prompt Library',
      'Creator Finder',
      'Accounts',
      'Pages',
      'Publish Now',
      'Auto Repost',
      'Auto Download/Upload',
      'Accounts',
      'Schedule',
      'Publish Now',
      'Auto Repost',
      'Auto Download/Upload',
      'Accounts',
      'In-app Schedule',
      'Publish Now',
      'Auto Repost',
      'Auto Download/Upload',
      'My Plan',
      'Purchase',
      'Payments',
    ]);
    // Testing platforms render only the note, no leaves.
    const platformSection = sections.find((s) => s.key === 'platform');
    expect(platformSection).toBeDefined();
    for (const item of platformSection?.items ?? []) {
      if (item.kind === 'group' && ['x', 'tiktok', 'youtube'].includes(item.key)) {
        expect(item.leaves).toEqual([]);
        expect(item.testingNote).toBeTruthy();
      }
    }
    // Billing leaves are ?view= leaves behind one route.
    const billingSection = sections.find((s) => s.key === 'billing');
    const billingGroup = billingSection?.items.find((i) => i.kind === 'group');
    expect(billingGroup?.kind === 'group' ? billingGroup.leaves.map((l) => l.view) : []).toEqual([
      'my-plan',
      'purchase',
      'payments',
    ]);
  });

  it('seller sections are exactly one Dashboard leaf', () => {
    expect(allLabels(SELLER_SECTIONS)).toEqual(['Dashboard']);
    expect(allHrefs(SELLER_SECTIONS)).toEqual(['/seller']);
  });

  it('admin sections are exactly the two admin leaves', () => {
    expect(allLabels(ADMIN_SECTIONS)).toEqual(['Subscriptions approval', 'Sellers']);
    expect(allHrefs(ADMIN_SECTIONS)).toEqual(['/admin/subscriptions', '/admin/sellers']);
  });

  it('the three configs href sets are pairwise disjoint', () => {
    const user = new Set(allHrefs(getUserSections('acme', false)));
    const seller = new Set(allHrefs(SELLER_SECTIONS));
    const admin = new Set(allHrefs(ADMIN_SECTIONS));
    for (const href of seller) expect(user.has(href)).toBe(false);
    for (const href of admin) expect(user.has(href)).toBe(false);
    for (const href of admin) expect(seller.has(href)).toBe(false);
  });

  it('no config contains another role href', () => {
    const userHrefs = allHrefs(getUserSections('acme', false));
    expect(userHrefs.some((h) => h.startsWith('/admin/') || h === '/seller')).toBe(false);
    expect(allHrefs(ADMIN_SECTIONS).some((h) => h.startsWith('/tenant/') || h === '/seller')).toBe(
      false
    );
    expect(allHrefs(SELLER_SECTIONS).some((h) => h.startsWith('/admin/'))).toBe(false);
  });
});

describe('AppSidebar rendering (separation matrix)', () => {
  beforeEach(() => {
    mockPathname = '/tenant/acme';
    mockSearch = new URLSearchParams();
    mockPush.mockClear();
    mockPrefetch.mockClear();
  });

  it('user sidebar renders user leaves and ZERO admin/seller leaves', () => {
    renderSidebar(getUserSections('acme', false));
    for (const label of ['Home', 'Media Library', 'Fdola Studio', 'Prompt Library', 'Creator Finder', 'My Plan', 'Purchase', 'Payments']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${label}$`) }).getAttribute('href')).toBeTruthy();
    }
    // Platform and Billing are collapsible groups (buttons), not leaves.
    expect(screen.getByRole('button', { name: /Facebook/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Billing/ })).toBeTruthy();
    for (const label of USER_FORBIDDEN) {
      expect(screen.queryByRole('link', { name: label })).toBeNull();
    }
  });

  it('admin sidebar renders admin leaves and ZERO user/seller leaves', () => {
    renderSidebar(ADMIN_SECTIONS);
    expect(screen.getByRole('link', { name: 'Subscriptions approval' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sellers' })).toBeTruthy();
    for (const label of ADMIN_FORBIDDEN) {
      expect(screen.queryByRole('link', { name: label })).toBeNull();
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('seller sidebar renders Dashboard and ZERO user/admin leaves', () => {
    renderSidebar(SELLER_SECTIONS);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    for (const label of SELLER_FORBIDDEN) {
      expect(screen.queryByRole('link', { name: label })).toBeNull();
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('platform groups open only when active', () => {
    const { unmount } = renderSidebar(getUserSections('acme', false));
    // Home: Instagram leaves are hidden (group closed).
    expect(screen.queryByRole('link', { name: 'Schedule' })).toBeNull();
    unmount();
    mockPathname = '/tenant/acme/instagram/accounts';
    renderSidebar(getUserSections('acme', false));
    expect(screen.getByRole('link', { name: 'Schedule' })).toBeTruthy();
  });

  it('billing view leaves highlight by ?view=', () => {
    mockPathname = '/tenant/acme/billing';
    mockSearch = new URLSearchParams('view=purchase');
    renderSidebar(getUserSections('acme', false));
    const purchase = screen.getByRole('link', { name: 'Purchase' });
    expect(purchase.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'My Plan' }).getAttribute('data-active')).not.toBe(
      'true'
    );
  });
});

describe('AppSidebar single-click behaviour', () => {
  beforeEach(() => {
    mockPathname = '/tenant/acme';
    mockSearch = new URLSearchParams();
    mockPush.mockClear();
    mockPrefetch.mockClear();
  });

  it('a leaf click paints active state WITHOUT router.push (Link navigates)', () => {
    renderSidebar(getUserSections('acme', false));
    const media = screen.getByRole('link', { name: 'Media Library' });
    fireEvent.click(media);
    expect(mockPush).not.toHaveBeenCalled();
    expect(media.getAttribute('data-active')).toBe('true');
  });

  it('a collapsible parent in icon-collapsed mode navigates via router.push', () => {
    mockPathname = '/tenant/acme/pages';
    renderSidebar(getUserSections('acme', false), { defaultOpen: false, collapsible: 'icon' });
    const facebook = screen.getByRole('button', { name: /Facebook/ });
    fireEvent.click(facebook);
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/accounts');
  });
});
