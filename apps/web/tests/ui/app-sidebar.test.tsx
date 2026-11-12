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

// Perf round 1: record every next/link's prefetch prop so tests can
// prove which links viewport-prefetch and which do not.
const recordedLinkProps = vi.hoisted(
  () => [] as Array<{ href: string; prefetch?: boolean | null | undefined }>
);

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
// routing) rather than hand-rolled raw <a> elements. The prefetch
// prop is recorded (not spread onto the anchor) so tests can prove
// which links prefetch.
vi.mock('next/link', async () => {
  const ReactModule = await import('react');
  type MockLinkProps = {
    href: string;
    children?: React.ReactNode;
    prefetch?: boolean | null;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>;
  return {
    default: ({ href, children, prefetch, ...props }: MockLinkProps) => {
      recordedLinkProps.push({ href, prefetch });
      return ReactModule.createElement(
        'a',
        { href, 'data-next-link': 'true', ...props },
        children
      );
    },
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
      'Muse Assistant',
      'Media Library',
      'Fdola Studio',
      'Prompt Library',
      'Creator Finder',
      'Accounts',
      'In-App Schedule',
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
      'Refund',
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
    // Billing is four separate top-level leaves, not a Billing
    // group and not ?view= leaves (PR #120 send-back fix B1):
    // the old /billing?view= routes are deleted, so a group
    // pointing at them would 404.
    const billingSection = sections.find((s) => s.key === 'billing');
    expect(billingSection?.items.every((i) => i.kind === 'leaf')).toBe(true);
    expect(
      (billingSection?.items ?? []).map((i) => (i.kind === 'leaf' ? i.href : ''))
    ).toEqual([
      '/tenant/acme/my-plan',
      '/tenant/acme/purchase',
      '/tenant/acme/payments',
      '/tenant/acme/refund',
    ]);
    expect(
      (billingSection?.items ?? []).every((i) => i.kind === 'leaf' && i.match === 'prefix')
    ).toBe(true);
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
    recordedLinkProps.length = 0;
  });

  it('user sidebar renders user leaves and ZERO admin/seller leaves', () => {
    renderSidebar(getUserSections('acme', false));
    for (const label of ['Home', 'Media Library', 'Fdola Studio', 'Prompt Library', 'Creator Finder', 'My Plan', 'Purchase', 'Payments', 'Refund']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${label}$`) }).getAttribute('href')).toBeTruthy();
    }
    // Facebook is a collapsible group (button); Billing is NOT a
    // group any more — its four sections are top-level leaves.
    expect(screen.getByRole('button', { name: /Facebook/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Billing/ })).toBeNull();
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
    // Home: Instagram leaves are hidden (group closed). The Instagram
    // Schedule link is disambiguated by href: Facebook also has a
    // leaf now labelled In-App Schedule, and it is open by default.
    expect(
      document.querySelector('a[href="/tenant/acme/instagram/schedule"]'),
    ).toBeNull();
    unmount();
    mockPathname = '/tenant/acme/instagram/accounts';
    renderSidebar(getUserSections('acme', false));
    expect(
      document.querySelector('a[href="/tenant/acme/instagram/schedule"]'),
    ).toBeTruthy();
  });

  it('billing leaves highlight by prefix on their own routes', () => {
    mockPathname = '/tenant/acme/purchase/checkout';
    mockSearch = new URLSearchParams();
    renderSidebar(getUserSections('acme', false));
    const purchase = screen.getByRole('link', { name: 'Purchase' });
    expect(purchase.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'My Plan' }).getAttribute('data-active')).not.toBe(
      'true'
    );
    expect(screen.getByRole('link', { name: 'Refund' }).getAttribute('data-active')).not.toBe(
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
    recordedLinkProps.length = 0;
  });

  it('a leaf click paints active state WITHOUT router.push (Link navigates)', () => {
    renderSidebar(getUserSections('acme', false));
    const media = screen.getByRole('link', { name: 'Media Library' });
    fireEvent.click(media);
    expect(mockPush).not.toHaveBeenCalled();
    expect(media.getAttribute('data-active')).toBe('true');
  });

  it('a collapsible parent in icon-collapsed mode navigates via router.push', () => {
    mockPathname = '/tenant/acme/inapp-schedule';
    renderSidebar(getUserSections('acme', false), { defaultOpen: false, collapsible: 'icon' });
    const facebook = screen.getByRole('button', { name: /Facebook/ });
    fireEvent.click(facebook);
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/accounts');
  });
});

describe('AppSidebar prefetch (perf round 1)', () => {
  beforeEach(() => {
    mockPathname = '/tenant/acme';
    mockSearch = new URLSearchParams();
    mockPush.mockClear();
    mockPrefetch.mockClear();
    recordedLinkProps.length = 0;
  });

  // Facebook is the only collapsible group open on the home route,
  // so its five leaves are the rendered collapsible-section links.
  const FACEBOOK_LEAF_HREFS = [
    '/tenant/acme/accounts',
    '/tenant/acme/inapp-schedule',
    '/tenant/acme/publish-now',
    '/tenant/acme/tiktok-mirrors',
    '/tenant/acme/auto-download-upload',
  ];

  const TOP_LEVEL_LEAF_HREFS = [
    '/tenant/acme/',
    '/tenant/acme/muse',
    '/tenant/acme/media',
    '/tenant/acme/fdola-studio',
    '/tenant/acme/prompts',
    '/tenant/acme/creator-finder',
    '/tenant/acme/my-plan',
    '/tenant/acme/purchase',
    '/tenant/acme/payments',
    '/tenant/acme/refund',
  ];

  it('collapsible-section leaves render with prefetch off', () => {
    renderSidebar(getUserSections('acme', false));
    for (const href of FACEBOOK_LEAF_HREFS) {
      const recorded = recordedLinkProps.filter((link) => link.href === href);
      expect(recorded.length).toBeGreaterThan(0);
      for (const link of recorded) {
        expect(link.prefetch).toBe(false);
      }
    }
  });

  // Spec 170 F2: the 10 top-level leaves no longer viewport-prefetch
  // (same move PR #181 made for collapsible leaves). The branding link
  // points at the same Home route as the Home leaf, so it gets the same
  // treatment — in this render it is '/seller' (renderSidebar's
  // brandingHref), pinned below alongside the leaves.
  it('top-level leaves render with prefetch off (spec 170 F2)', () => {
    renderSidebar(getUserSections('acme', false));
    for (const href of TOP_LEVEL_LEAF_HREFS) {
      const recorded = recordedLinkProps.filter((link) => link.href === href);
      expect(recorded.length).toBeGreaterThan(0);
      for (const link of recorded) {
        expect(link.prefetch).toBe(false);
      }
    }
    const branding = recordedLinkProps.filter((link) => link.href === '/seller');
    expect(branding.length).toBeGreaterThan(0);
    for (const link of branding) {
      expect(link.prefetch).toBe(false);
    }
  });

  it('hovering a collapsible parent still prefetches its parent route', () => {
    renderSidebar(getUserSections('acme', false));
    const facebook = screen.getByRole('button', { name: /Facebook/ });
    fireEvent.mouseEnter(facebook);
    expect(mockPrefetch).toHaveBeenCalledWith('/tenant/acme/accounts');
  });
});
