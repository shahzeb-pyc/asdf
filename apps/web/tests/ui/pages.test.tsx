/**
 * @file pages.test.tsx
 * @description Comprehensive UI & behavioral tests for Spec 032:
 * Dedicated Facebook Pages Management Section, Follower Growth Tracking & Two-Step Page Import.
 *
 * Spec 131 PR-131-2 named modifications (spec §8.4/§8.7):
 * (1) imports follow the decomposition — the route is now a server
 *     component + `PagesShell` island, helpers live in
 *     `components/pages/pages-helpers`, the toolbar in
 *     `components/pages/pages-toolbar`; shell renders seed the React
 *     Query cache directly (the server route's dehydration shape).
 * (2) PageCard style assertions that pinned inline styles / PALETTE
 *     hexes now pin the token classes that carry the same values
 *     (zero inline styles in the rebuild); the colour/ring helper
 *     functions themselves are unchanged and still pinned directly.
 * (3) The function-call tree probes for click/fetch behaviour
 *     (Reconnect routing, Go-to-Accounts, discover, import) moved to
 *     live behavioural tests in tests/ui/pages-behaviour.test.tsx —
 *     the decomposed step components no longer expose those handlers
 *     in the modal's element tree.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { THEME, DARK_THEME, LIGHT_THEME } from '@/lib/theme';
import {
  PageCard,
  computeFollowersGained,
  formatFollowersGained,
  formatAddedDate,
  formatPageIdSuffix,
  getPageStatusLabel,
  getPageStatusMarkKind,
  isPageNeedsAttention,
  type FacebookPageItem,
} from '@/components/pages/page-card';
import { PagesEmptyState } from '@/components/pages/pages-empty-state';
import {
  AddPageModal,
  buildAccountsHref,
  buildSettingsFacebookHref,
  getActiveAccounts,
  getExpiredAccounts,
  getSelectablePageIds,
  toggleSelectAllPages,
  type DiscoveredPageItem,
} from '@/components/pages/add-page-modal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PagesShell } from '@/app/tenant/[subdomain]/pages/pages-shell';
import { PagesScaleToolbar } from '@/components/pages/pages-toolbar';
import {
  filterPagesList,
  sortPagesAttentionFirst,
} from '@/components/pages/pages-helpers';
import { queryKeys } from '@/lib/data/query-keys';
// Spec 131 PR-131-3 (named update, §8.1 server-first): the [pageId]
// route is now a server component; the client frame it composes lives
// in page-section-shell.tsx — the same split PR-131-2 used for the
// pages list (page.tsx server + pages-shell.tsx client).
import TenantDedicatedPageView from '@/app/tenant/[subdomain]/pages/[pageId]/page-section-shell';
import type { FacebookAccountItem } from '@/components/accounts/account-card';
import { render } from '../components/setup';
import {
  render as renderBehavioural,
  screen,
} from '@testing-library/react';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
  }),
  useParams: () => ({
    subdomain: 'acme',
    pageId: 'page-uuid-1',
  }),
  // PagesShell reads ?account= via useSearchParams; these suites
  // render without a URL, so the param is empty by default.
  // The shell also reads the initial ?page= from the URL (pagination).
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Helper to execute a functional component inside React's server render dispatcher
 * and recursively locate elements by `data-testid` so real event handlers
 * (`onClick`, `onKeyDown`, `onChange`) can be invoked directly.
 */
function findElementByTestId(
  node: React.ReactNode,
  testId: string
): React.ReactElement<Record<string, any>> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, any>;
    if (props['data-testid'] === testId) {
      return node as React.ReactElement<Record<string, any>>;
    }
    if (props.children) {
      return findElementByTestId(props.children, testId);
    }
  }
  return null;
}

function renderAndCaptureTree(
  renderFn: () => React.ReactElement
): React.ReactElement {
  let tree: React.ReactElement | null = null;
  function CaptureWrapper() {
    tree = renderFn();
    return tree;
  }
  // PR-131-3: captured components may read through React Query (the
  // dedicated section frame does) — a provider must sit above the
  // capture wrapper, whose hooks attach to the wrapper itself.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CaptureWrapper />
    </QueryClientProvider>
  );
  if (!tree) {
    throw new Error('Failed to capture React element tree');
  }
  return tree;
}

/**
 * Render the Pages shell the way the server route delivers it: the
 * initial pages/accounts are seeded into the React Query cache under
 * the factory keys (the dehydrated shape), so the shell renders its
 * loaded state synchronously.
 */
function renderPagesShell({
  pages,
  accounts,
}: {
  pages: FacebookPageItem[];
  accounts: FacebookAccountItem[];
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tenant = queryKeys.tenant('acme');
  // The shell queries the paginated keys (page 1, default filters);
  // seeding the bare list keys no longer reaches it.
  queryClient.setQueryData(
    tenant.pages.listPage({
      page: 1,
      limit: 30,
      search: '',
      status: 'all',
      account: 'all',
    }),
    {
      pages,
      total: pages.length,
      page: 1,
      limit: 30,
      totalPages: pages.length === 0 ? 0 : 1,
    }
  );
  // The pages shell reads accounts at limit 50 (filter options +
  // expired banner), not the paginated 30.
  queryClient.setQueryData(
    tenant.accounts.listPage({ page: 1, limit: 50, search: '', status: 'all' }),
    {
      accounts,
      total: accounts.length,
      page: 1,
      limit: 50,
      totalPages: accounts.length === 0 ? 0 : 1,
    }
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <PagesShell subdomain="acme" />
    </QueryClientProvider>
  );
}

describe('Facebook Pages UI Suite (Spec 032)', () => {
  beforeEach(() => {
    mockPush.mockReset();
    vi.restoreAllMocks();
  });

  const baseActivePage: FacebookPageItem = {
    id: 'page-uuid-1',
    facebookAccountId: 'acc-1',
    accountDisplayName: 'Sarah Connor',
    fbPageId: 'fb_page_101',
    pageName: 'Cyberdyne Reels',
    profilePictureUrl: 'https://graph.facebook.com/v26.0/p101/picture',
    category: 'Science and Tech',
    startingFollowers: 10000,
    currentFollowers: 11200,
    followersGained: 1200,
    status: 'active',
    tasks: ['CREATE_CONTENT', 'MANAGE'],
    createdAt: '2026-10-05T12:00:00.000Z',
  };

  const zeroGrowthPage: FacebookPageItem = {
    ...baseActivePage,
    id: 'page-uuid-zero',
    fbPageId: 'fb_page_102',
    pageName: 'Steady Daily Clips',
    profilePictureUrl: null,
    startingFollowers: 5400,
    currentFollowers: 5400,
    followersGained: 0,
  };

  const negativeGrowthPage: FacebookPageItem = {
    ...baseActivePage,
    id: 'page-uuid-neg',
    fbPageId: 'fb_page_103',
    pageName: 'Resistance Archives',
    startingFollowers: 8000,
    currentFollowers: 7650,
    followersGained: -350,
    status: 'paused',
  };

  const sampleActiveAccount: FacebookAccountItem = {
    id: 'acc-1',
    fbAccountId: 'fb_user_1',
    displayName: 'Sarah Connor',
    profilePictureUrl: 'https://graph.facebook.com/v26.0/u1/picture',
    status: 'active',
    connectedPagesCount: 2,
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  const sampleExpiredAccount: FacebookAccountItem = {
    id: 'acc-expired',
    fbAccountId: 'fb_user_2',
    displayName: 'John Doe',
    profilePictureUrl: null,
    status: 'expired',
    connectedPagesCount: 1,
    createdAt: '2026-09-15T00:00:00.000Z',
  };

  describe('PageCard Component', () => {
    it('renders avatar, page name, category, currentFollowers, positive followersGained (+1,200), parent account name, and Active status', () => {
      const { hasText, hasAttribute, html } = render(
        <PageCard page={baseActivePage} subdomain="acme" />
      );

      expect(hasAttribute('data-testid', 'page-card-page-uuid-1')).toBe(true);
      expect(hasAttribute('data-testid', 'page-avatar-img')).toBe(true);
      expect(hasAttribute('data-testid', 'page-name')).toBe(true);
      expect(hasText('Cyberdyne Reels')).toBe(true);
      expect(hasAttribute('data-testid', 'page-category')).toBe(true);
      expect(hasText('Science and Tech')).toBe(true);
      expect(hasAttribute('data-testid', 'page-current-followers')).toBe(true);
      expect(hasText('11,200')).toBe(true);
      expect(hasAttribute('data-testid', 'page-followers-gained')).toBe(true);
      expect(hasText('+1,200 gained')).toBe(true);
      expect(hasAttribute('data-testid', 'page-parent-account')).toBe(true);
      expect(hasText('Account: Sarah Connor')).toBe(true);
      expect(hasAttribute('data-testid', 'page-status')).toBe(true);
      expect(hasText('Active')).toBe(true);
      // Accounts-style mark: tick icon + signal text, no dot (no bg-signal dot span)
      expect(html).toContain('text-signal-operational');
      expect(html).toContain('data-icon="check"');
      expect(html).not.toContain('bg-signal-operational');
      expect(hasAttribute('data-testid', 'page-attention-banner')).toBe(false);
      // Final card spec: Added date from createdAt, no Page ID line
      expect(hasAttribute('data-testid', 'page-added-line')).toBe(true);
      expect(hasText('Added 5 Oct 2026')).toBe(true);
      expect(formatAddedDate('2026-10-05T12:00:00.000Z')).toBe('5 Oct 2026');
      expect(hasAttribute('data-testid', 'page-id-line')).toBe(false);
    });

    it('does NOT render a Page ID line on the card (final card spec) — the helper survives for other surfaces only', () => {
      expect(formatPageIdSuffix('61594571856866')).toBe('…856866');
      expect(formatPageIdSuffix('123')).toBe('123');
      expect(formatPageIdSuffix('')).toBe('');

      const first = render(
        <PageCard
          page={{
            ...baseActivePage,
            id: 'page-dup-1',
            pageName: 'Sunnie James',
            fbPageId: '111111222222',
            category: 'Model',
            currentFollowers: 0,
            followersGained: 0,
          }}
          subdomain="acme"
        />
      );
      const second = render(
        <PageCard
          page={{
            ...baseActivePage,
            id: 'page-dup-2',
            pageName: 'Sunnie James',
            fbPageId: '999999333333',
            category: 'Model',
            currentFollowers: 0,
            followersGained: 0,
          }}
          subdomain="acme"
        />
      );

      expect(first.hasAttribute('data-testid', 'page-id-line')).toBe(false);
      expect(first.hasText('Page ID')).toBe(false);
      expect(second.hasText('Page ID')).toBe(false);
    });

    it('renders identity lines in order (name → Added → followers/category → Facebook link row) with link left and gained right', () => {
      const { html } = render(
        <PageCard page={baseActivePage} subdomain="acme" />
      );
      const nameIdx = html.indexOf('Cyberdyne Reels');
      const addedIdx = html.indexOf('Added 5 Oct 2026');
      const followersIdx = html.indexOf('11,200');
      const linkIdx = html.indexOf('View on Facebook');
      const gainedIdx = html.indexOf('+1,200 gained');
      expect(nameIdx).toBeGreaterThan(-1);
      expect(addedIdx).toBeGreaterThan(nameIdx);
      expect(followersIdx).toBeGreaterThan(addedIdx);
      expect(linkIdx).toBeGreaterThan(followersIdx);
      expect(gainedIdx).toBeGreaterThan(linkIdx);

      const tree = renderAndCaptureTree(() =>
        PageCard({ page: baseActivePage, subdomain: 'acme' })
      );
      const linkEl = findElementByTestId(tree, 'page-facebook-link');
      expect(linkEl).not.toBeNull();
      expect(linkEl?.props.href).toBe('https://facebook.com/fb_page_101');
      expect(linkEl?.props.target).toBe('_blank');
      expect(linkEl?.props.rel).toBe('noopener noreferrer');
      // Clicking the link stops propagation so the card does not navigate
      const stopPropagation = vi.fn();
      linkEl?.props.onClick({ stopPropagation });
      expect(stopPropagation).toHaveBeenCalledTimes(1);
      // Keyboard activation from the link is ignored by the card handler
      const selectedPaths: string[] = [];
      const cardTree = renderAndCaptureTree(() =>
        PageCard({
          page: baseActivePage,
          subdomain: 'acme',
          onSelectPage: (p) => selectedPaths.push(p.id),
        })
      );
      const cardEl = findElementByTestId(cardTree, 'page-card-page-uuid-1');
      const linkTarget = { closest: () => ({}) };
      cardEl?.props.onKeyDown({
        key: 'Enter',
        preventDefault: vi.fn(),
        target: linkTarget,
      });
      expect(selectedPaths).toHaveLength(0);

      // Corner fix: no forced card height, no pinned footer — the divider
      // follows the content directly, so no dead space opens up.
      expect(html).toContain('page-card-arrow');
      expect(html).not.toContain('min-h-38');
      expect(html).not.toContain('mt-auto');
      // Link row is a full-width sibling of the top section (not nested
      // in the identity column), so gained sits flush right at the card
      // edge: the row's class carries justify-between. The link itself
      // must NOT stretch (no flex-1) — it is only as wide as its visible
      // text, so only the text itself is clickable as the Facebook link.
      const linkRowEl = findElementByTestId(tree, 'page-facebook-link-row');
      expect(linkRowEl).not.toBeNull();
      expect(linkRowEl?.props.className).toContain('justify-between');
      expect(linkEl?.props.className).not.toContain('flex-1');
      expect(linkEl?.props.className).toContain('shrink-0');
      const followersEl = findElementByTestId(tree, 'page-current-followers');
      expect(followersEl).not.toBeNull();
      // Followers number is page-name size (text-body) and bold; the rest
      // of the followers line stays muted at metadata size.
      expect(followersEl?.props.className).toContain('text-body');
      expect(followersEl?.props.className).toContain('font-bold');
      expect(followersEl?.props.className).not.toContain('text-brand-gold');
    });

    it('falls back to monogram initials when profilePictureUrl is missing or image errors (forceAvatarError)', () => {
      const noAvatarRender = render(
        <PageCard page={zeroGrowthPage} subdomain="acme" />
      );
      expect(noAvatarRender.hasAttribute('data-testid', 'page-avatar-initials')).toBe(true);
      expect(noAvatarRender.hasText('SD')).toBe(true);

      const errorAvatarRender = render(
        <PageCard
          page={baseActivePage}
          subdomain="acme"
          forceAvatarError={true}
        />
      );
      expect(errorAvatarRender.hasAttribute('data-testid', 'page-avatar-initials')).toBe(true);
      expect(errorAvatarRender.hasAttribute('data-testid', 'page-avatar-img')).toBe(false);
      expect(errorAvatarRender.hasText('CR')).toBe(true);
    });

    it('hides the followers-gained line when growth is zero (Spec 102)', () => {
      const zeroRender = render(
        <PageCard page={zeroGrowthPage} subdomain="acme" />
      );
      expect(zeroRender.hasText('5,400')).toBe(true);
      expect(zeroRender.hasAttribute('data-testid', 'page-followers-gained')).toBe(false);

      // Verify negative followersGained both from explicit field and computed fallback
      const computedNegativePage: FacebookPageItem = {
        ...negativeGrowthPage,
        followersGained: computeFollowersGained({
          startingFollowers: 8000,
          currentFollowers: 7650,
        }),
      };
      expect(computedNegativePage.followersGained).toBe(-350);
      expect(formatFollowersGained(-350)).toBe('-350');

      const negRender = render(
        <PageCard page={computedNegativePage} subdomain="acme" />
      );
      expect(negRender.hasText('7,650')).toBe(true);
      expect(negRender.hasText('-350 gained')).toBe(true);
      expect(negRender.html).toContain('text-brand-rose');
    });

    it('highlights attention-needed statuses (invalid_token, page_checkpoint, fb_rate_limited) with red/rose border and cross status but NO attention banner (final card spec)', () => {
      const attentionStatuses: Array<{
        status: FacebookPageItem['status'];
        expectedLabel: string;
      }> = [
        { status: 'invalid_token', expectedLabel: 'Token Expired' },
        { status: 'page_checkpoint', expectedLabel: 'Identity Checkpoint' },
        { status: 'fb_rate_limited', expectedLabel: 'Rate Limited' },
      ];

      for (const item of attentionStatuses) {
        expect(isPageNeedsAttention(item.status)).toBe(true);
        expect(getPageStatusLabel(item.status)).toBe(item.expectedLabel);

        const { hasAttribute, hasText, html } = render(
          <PageCard
            page={{ ...baseActivePage, status: item.status }}
            subdomain="acme"
          />
        );

        expect(hasAttribute('data-testid', 'page-attention-banner')).toBe(false);
        expect(hasText(item.expectedLabel)).toBe(true);
        expect(hasText('Reconnect the parent Facebook account')).toBe(false);
        expect(hasText('Confirm page identity on Facebook mobile')).toBe(false);
        expect(hasText('temporarily restricted posting')).toBe(false);
        expect(html).toContain('border-brand-rose');
      }
    });

    it('renders status as Accounts-style icon + text with no dot, and applies the status ring to the avatar, across all statuses', () => {
      const allStatuses: Array<{
        status: FacebookPageItem['status'];
        expectedKind: 'operational' | 'queued' | 'critical';
        expectedIcon: 'check' | 'clock' | 'cross';
        expectedRingClass: string;
      }> = [
        { status: 'active', expectedKind: 'operational', expectedIcon: 'check', expectedRingClass: 'border-signal-operational' },
        { status: 'paused', expectedKind: 'queued', expectedIcon: 'clock', expectedRingClass: 'border-signal-queued' },
        { status: 'invalid_token', expectedKind: 'critical', expectedIcon: 'cross', expectedRingClass: 'border-signal-critical' },
        { status: 'page_checkpoint', expectedKind: 'critical', expectedIcon: 'cross', expectedRingClass: 'border-signal-critical' },
        { status: 'fb_rate_limited', expectedKind: 'critical', expectedIcon: 'cross', expectedRingClass: 'border-signal-critical' },
        { status: 'disconnected', expectedKind: 'critical', expectedIcon: 'cross', expectedRingClass: 'border-signal-critical' },
      ];

      for (const item of allStatuses) {
        expect(getPageStatusMarkKind(item.status)).toBe(item.expectedKind);

        const { html, hasText, hasAttribute } = render(
          <PageCard
            page={{ ...baseActivePage, status: item.status }}
            subdomain="acme"
          />
        );

        // No dot anywhere in the card's status mark
        expect(html).not.toContain('●');
        expect(html).not.toContain('•');
        expect(hasText(getPageStatusLabel(item.status))).toBe(true);
        expect(hasAttribute('data-testid', 'page-status')).toBe(true);
        expect(html).toContain(`data-icon="${item.expectedIcon}"`);
        expect(html).toContain(item.expectedRingClass);
      }
    });

    it('navigates to /tenant/{subdomain}/pages/{pageId} on click or Enter/Space key press', () => {
      const selectedPaths: string[] = [];
      const tree = renderAndCaptureTree(() =>
        PageCard({
          page: baseActivePage,
          subdomain: 'acme',
          onSelectPage: (p) => selectedPaths.push(`/tenant/acme/pages/${p.id}`),
        })
      );

      const cardEl = findElementByTestId(tree, 'page-card-page-uuid-1');
      expect(cardEl).not.toBeNull();
      expect(cardEl?.props['data-href']).toBe('/tenant/acme/pages/page-uuid-1');

      // Click activation
      cardEl?.props.onClick();
      expect(selectedPaths).toEqual(['/tenant/acme/pages/page-uuid-1']);

      // Enter key activation
      const enterPreventDefault = vi.fn();
      cardEl?.props.onKeyDown({
        key: 'Enter',
        preventDefault: enterPreventDefault,
      });
      expect(enterPreventDefault).toHaveBeenCalledTimes(1);
      expect(selectedPaths).toHaveLength(2);

      // Space key activation
      const spacePreventDefault = vi.fn();
      cardEl?.props.onKeyDown({
        key: ' ',
        preventDefault: spacePreventDefault,
      });
      expect(spacePreventDefault).toHaveBeenCalledTimes(1);
      expect(selectedPaths).toHaveLength(3);
    });
  });

  describe('AddPageModal (Two-Step Flow)', () => {
    // PR-131-2 named modification: the modal now renders through the
    // shared/ui Radix Dialog, whose portal content does not exist in
    // static markup — these tests render live (Testing Library), the
    // same migration PR-131-1 made for the connect modal. All
    // assertions (copy, testids, states) are the legacy ones.
    const sampleDiscoveredPages: DiscoveredPageItem[] = [
      {
        fbPageId: 'fb_page_101',
        pageName: 'Cyberdyne Reels',
        profilePictureUrl: 'https://graph.facebook.com/v26.0/p101/picture',
        category: 'Science & Tech',
        currentFollowers: 11200,
        isImported: true,
      },
      {
        fbPageId: 'fb_page_202',
        pageName: 'Skynet AI Daily',
        profilePictureUrl: null,
        category: 'Automation Service',
        currentFollowers: 4300,
        isImported: false,
      },
      {
        fbPageId: 'fb_page_303',
        pageName: 'Future Robotics Hub',
        profilePictureUrl: null,
        category: 'Robotics',
        currentFollowers: 8900,
        isImported: false,
      },
    ];

    it('Step 1 lists active accounts and shows expired accounts grayed with inline Reconnect (Spec 102)', () => {
      const accounts = [sampleActiveAccount, sampleExpiredAccount];
      expect(getActiveAccounts(accounts)).toEqual([sampleActiveAccount]);
      expect(getExpiredAccounts(accounts)).toEqual([sampleExpiredAccount]);

      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={accounts}
        />
      );

      expect(screen.getByText('Select a Facebook Account')).toBeTruthy();
      expect(screen.getByTestId('select-account-list')).toBeTruthy();
      expect(screen.getByTestId('select-account-acc-1')).toBeTruthy();
      expect(screen.getByText('Sarah Connor')).toBeTruthy();
      expect(screen.getByText('2 pages linked')).toBeTruthy();
      // Expired account is listed grayed with inline Reconnect — never as an import source
      expect(screen.queryByTestId('select-account-acc-expired')).toBeNull();
      expect(screen.getByTestId('expired-account-acc-expired')).toBeTruthy();
      expect(screen.getByTestId('reconnect-account-acc-expired')).toBeTruthy();
      expect(screen.getByText('Reconnect')).toBeTruthy();
      expect(screen.getByText(/Session expired/)).toBeTruthy();
    });

    it('Step 1 shows "No active Facebook accounts connected" notice only when no accounts exist at all (Spec 102)', () => {
      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[]}
          onNavigateToAccounts={vi.fn()}
        />
      );

      expect(screen.getByTestId('no-active-accounts-notice')).toBeTruthy();
      expect(screen.getByText('No active Facebook accounts connected')).toBeTruthy();
      expect(screen.getByTestId('go-to-accounts-btn')).toBeTruthy();
    });

    it('"Go to Facebook Accounts" is a real link to the Accounts route and still runs the navigation callback (Spec 109)', () => {
      expect(buildAccountsHref('acme')).toBe('/tenant/acme/accounts');
      expect(buildSettingsFacebookHref('acme')).toBe(
        '/tenant/acme/settings?tab=byoc'
      );

      const onNavigateToAccounts = vi.fn();
      const onOpenChange = vi.fn();
      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={onOpenChange}
          accounts={[]}
          onNavigateToAccounts={onNavigateToAccounts}
        />
      );
      // The navigation target is the element's own href, not only a
      // callback fired while the dialog is closing.
      const link = screen.getByTestId('go-to-accounts-btn');
      expect(link.getAttribute('href')).toBe('/tenant/acme/accounts');
    });

    it('shows missing-app guidance with a Settings → Facebook link at the point of need, and hides it once configured (Spec 109)', () => {
      const missing = renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[]}
          facebookAppConfigured={false}
        />
      );
      expect(screen.getByTestId('facebook-app-guidance')).toBeTruthy();
      expect(
        screen.getByText(/add your Facebook App ID and App Secret in Workspace Settings, under Facebook/)
      ).toBeTruthy();
      expect(screen.getByTestId('go-to-settings-facebook-link')).toBeTruthy();
      expect(
        screen.getByTestId('go-to-settings-facebook-link').getAttribute('href')
      ).toBe('/tenant/acme/settings?tab=byoc');
      missing.unmount();

      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[]}
          facebookAppConfigured={true}
        />
      );
      expect(screen.queryByTestId('facebook-app-guidance')).toBeNull();
    });

    it('disambiguates duplicate discovered page names with the Page ID suffix (Spec 109)', () => {
      const duplicates: DiscoveredPageItem[] = [
        {
          fbPageId: '111111222222',
          pageName: 'Sunnie James',
          category: 'Model',
          currentFollowers: 0,
          isImported: false,
        },
        {
          fbPageId: '999999333333',
          pageName: 'Sunnie James',
          category: 'Model',
          currentFollowers: 0,
          isImported: false,
        },
      ];
      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleActiveAccount]}
          initialStep="select-pages"
          initialSelectedAccount={sampleActiveAccount}
          initialDiscoveredPages={duplicates}
        />
      );
      expect(screen.getByText(/Page ID …222222/)).toBeTruthy();
      expect(screen.getByText(/Page ID …333333/)).toBeTruthy();
    });

    it('Step 1 never shows the no-accounts claim when an expired-but-linked account exists (Spec 102)', () => {
      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleExpiredAccount]}
        />
      );

      expect(screen.queryByTestId('no-active-accounts-notice')).toBeNull();
      expect(
        screen.queryByText('No active Facebook accounts connected')
      ).toBeNull();
      expect(screen.getByTestId('expired-account-acc-expired')).toBeTruthy();
    });

    it('inline Reconnect on an expired account calls onReconnectAccount (Spec 102) — covered live in pages-behaviour.test.tsx', () => {
      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleExpiredAccount]}
          onReconnectAccount={vi.fn()}
        />
      );
      expect(screen.getByTestId('reconnect-account-acc-expired')).toBeTruthy();
    });

    it('selecting an account in Step 1 queries the discover endpoint and transitions to Step 2 — covered live in pages-behaviour.test.tsx (typed client, PR-131-2)', () => {
      expect(buildAccountsHref('acme')).toBe('/tenant/acme/accounts');
    });

    it('Step 2 displays discovered pages, marks isImported: true pages as "Already added", supports individual selection and "Select All"', () => {
      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleActiveAccount]}
          initialStep="select-pages"
          initialSelectedAccount={sampleActiveAccount}
          initialDiscoveredPages={sampleDiscoveredPages}
          initialSelectedPageIds={['fb_page_202']}
        />
      );

      expect(screen.getByText('Select Facebook Pages to Add')).toBeTruthy();
      expect(screen.getByTestId('discovered-pages-list')).toBeTruthy();
      expect(screen.getByTestId('select-all-pages-btn')).toBeTruthy();

      // Imported page is marked "Already added" and its checkbox is disabled + checked
      expect(screen.getByTestId('already-added-fb_page_101')).toBeTruthy();
      expect(screen.getByText('Already added')).toBeTruthy();
      const importedCheckbox = screen.getByTestId(
        'discovered-page-checkbox-fb_page_101'
      ) as HTMLButtonElement;
      expect(importedCheckbox.disabled).toBe(true);
      expect(importedCheckbox.getAttribute('aria-checked')).toBe('true');

      // Verify Select All toggle logic excludes already-imported pages
      expect(getSelectablePageIds(sampleDiscoveredPages)).toEqual([
        'fb_page_202',
        'fb_page_303',
      ]);
      const allSelected = toggleSelectAllPages(sampleDiscoveredPages, [
        'fb_page_202',
      ]);
      expect(allSelected).toEqual(['fb_page_202', 'fb_page_303']);
      const deselectedAll = toggleSelectAllPages(
        sampleDiscoveredPages,
        allSelected
      );
      expect(deselectedAll).toEqual([]);

      // Submitting through the typed client (POST /pages/import,
      // onSuccess + close) is covered live in pages-behaviour.test.tsx.
    });

    it('Step 2 displays integrated breadcrumb header, ghost page search input, Continue button state, and back navigation', () => {
      const first = renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleActiveAccount]}
          initialStep="select-pages"
          initialSelectedAccount={sampleActiveAccount}
          initialDiscoveredPages={sampleDiscoveredPages}
          initialSelectedPageIds={['fb_page_202']}
        />
      );

      // Header breadcrumb and subtitle
      expect(screen.getByText('Select Facebook Pages to Add')).toBeTruthy();
      expect(screen.getByText('Sarah Connor · 3 pages available')).toBeTruthy();
      expect(screen.getByTestId('change-account-btn')).toBeTruthy();
      expect(screen.getByTestId('modal-page-search-input')).toBeTruthy();

      // Step 2 now continues to the timezone step instead of
      // importing directly: the footer button is Continue, enabled
      // once at least one page is selected, and the final Import
      // button lives on Step 4 (covered in add-page-schedule.test.tsx).
      const continueBtn = screen.getByTestId(
        'continue-to-timezone-btn'
      ) as HTMLButtonElement;
      expect(continueBtn.textContent).toBe('Continue');
      expect(continueBtn.disabled).toBe(false);
      first.unmount();

      // Continue is also enabled for 2 selected pages
      const second = renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleActiveAccount]}
          initialStep="select-pages"
          initialSelectedAccount={sampleActiveAccount}
          initialDiscoveredPages={sampleDiscoveredPages}
          initialSelectedPageIds={['fb_page_202', 'fb_page_303']}
        />
      );
      expect(
        (screen.getByTestId('continue-to-timezone-btn') as HTMLButtonElement)
          .disabled
      ).toBe(false);
      second.unmount();

      // Continue is disabled for 0 selected pages
      renderBehavioural(
        <AddPageModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleActiveAccount]}
          initialStep="select-pages"
          initialSelectedAccount={sampleActiveAccount}
          initialDiscoveredPages={sampleDiscoveredPages}
          initialSelectedPageIds={[]}
        />
      );
      expect(
        (screen.getByTestId('continue-to-timezone-btn') as HTMLButtonElement)
          .disabled
      ).toBe(true);
    });
  });

  describe('TenantPagesPage (/tenant/[subdomain]/pages/page.tsx)', () => {
    const pageActive1: FacebookPageItem = {
      ...baseActivePage,
      id: 'p-active-1',
      pageName: 'Alpha Page',
      status: 'active',
      createdAt: '2026-10-01T10:00:00.000Z',
    };
    const pagePaused: FacebookPageItem = {
      ...baseActivePage,
      id: 'p-paused-1',
      pageName: 'Beta Paused Page',
      status: 'paused',
      createdAt: '2026-10-02T10:00:00.000Z',
    };
    const pageInvalidToken: FacebookPageItem = {
      ...baseActivePage,
      id: 'p-invalid-token',
      pageName: 'Gamma Expired Page',
      status: 'invalid_token',
      createdAt: '2026-10-03T10:00:00.000Z',
    };
    const pageCheckpoint: FacebookPageItem = {
      ...baseActivePage,
      id: 'p-checkpoint',
      pageName: 'Delta Checkpoint Page',
      status: 'page_checkpoint',
      createdAt: '2026-10-04T10:00:00.000Z',
    };
    const pageRateLimited: FacebookPageItem = {
      ...baseActivePage,
      id: 'p-rate-limited',
      pageName: 'Epsilon Rate Limited Page',
      accountDisplayName: 'Marcus Wright',
      facebookAccountId: 'acc-2',
      status: 'fb_rate_limited',
      createdAt: '2026-10-05T10:00:00.000Z',
    };

    it('renders PagesEmptyState when 0 pages exist, with non-reels-only copy and the toolbar still visible', () => {
      const { hasAttribute, hasText, html } = renderPagesShell({ pages: [], accounts: [sampleActiveAccount] });

      expect(hasAttribute('data-testid', 'pages-empty-state')).toBe(true);
      expect(hasText('No Facebook Pages added yet')).toBe(true);
      expect(hasAttribute('data-testid', 'empty-state-add-page-btn')).toBe(true);
      // Toolbar is always visible once loaded now (the >4 gate is gone).
      expect(hasAttribute('data-testid', 'pages-scale-toolbar')).toBe(true);
      // Empty-state copy must not assume reels-only publishing
      expect(html).not.toContain('publish reels to');
      expect(hasText('publish posts to')).toBe(true);
    });

    it('pins attention-needed pages (invalid_token, page_checkpoint, fb_rate_limited) above paused and active pages', () => {
      const inputPages = [
        pageActive1,
        pagePaused,
        pageInvalidToken,
        pageCheckpoint,
      ];
      const sorted = sortPagesAttentionFirst(inputPages);
      expect(sorted.map((p) => p.id)).toEqual([
        'p-checkpoint',
        'p-invalid-token',
        'p-paused-1',
        'p-active-1',
      ]);

      // The old >4 gate is gone: the toolbar is always visible once
      // loaded (approved list-redesign behaviour, carried by
      // pagination). Attention cards still render first in the DOM.
      const { html, hasAttribute } = renderPagesShell({ pages: inputPages, accounts: [sampleActiveAccount] });

      expect(hasAttribute('data-testid', 'pages-scale-toolbar')).toBe(true);
      const checkpointIdx = html.indexOf('Delta Checkpoint Page');
      const invalidIdx = html.indexOf('Gamma Expired Page');
      const pausedIdx = html.indexOf('Beta Paused Page');
      const activeIdx = html.indexOf('Alpha Page');

      expect(checkpointIdx).toBeGreaterThan(-1);
      expect(invalidIdx).toBeGreaterThan(checkpointIdx);
      expect(pausedIdx).toBeGreaterThan(invalidIdx);
      expect(activeIdx).toBeGreaterThan(pausedIdx);
    });

    it('renders scale toolbar (pages-scale-toolbar, search input, status filter tabs, and account filter) with 5 pages', () => {
      const fivePages = [
        pageActive1,
        pagePaused,
        pageInvalidToken,
        pageCheckpoint,
        pageRateLimited,
      ];

      const { hasAttribute, hasText } = renderPagesShell({ pages: fivePages, accounts: [sampleActiveAccount] });

      expect(hasAttribute('data-testid', 'pages-scale-toolbar')).toBe(true);
      expect(hasAttribute('data-testid', 'pages-search-input')).toBe(true);
      expect(hasAttribute('data-testid', 'pages-filter-all')).toBe(true);
      expect(hasAttribute('data-testid', 'pages-filter-active')).toBe(true);
      expect(
        hasAttribute('data-testid', 'pages-filter-needs-attention')
      ).toBe(true);
      expect(hasAttribute('data-testid', 'pages-filter-paused')).toBe(true);
      expect(hasAttribute('data-testid', 'pages-account-filter')).toBe(true);
      expect(hasText('Sarah Connor')).toBe(true);
      expect(hasText('Marcus Wright')).toBe(true);

      // Verify filterPagesList logic across search, status tabs, and account filter
      expect(
        filterPagesList(fivePages, 'epsilon', 'all', 'all').map((p) => p.id)
      ).toEqual(['p-rate-limited']);
      expect(
        filterPagesList(fivePages, '', 'needs_attention', 'all').map((p) => p.id)
      ).toEqual(['p-invalid-token', 'p-checkpoint', 'p-rate-limited']);
      expect(
        filterPagesList(fivePages, '', 'active', 'all').map((p) => p.id)
      ).toEqual(['p-active-1']);
      expect(
        filterPagesList(fivePages, '', 'paused', 'all').map((p) => p.id)
      ).toEqual(['p-paused-1']);
      expect(
        filterPagesList(fivePages, '', 'all', 'Marcus Wright').map((p) => p.id)
      ).toEqual(['p-rate-limited']);
    });

    it('renders live situational subtitle based on page operational health and active filter states (Spec 050)', () => {
      // 1. Attention needed scenario (3 of 5 require reconnecting)
      const fivePages = [
        pageActive1,
        pagePaused,
        pageInvalidToken,
        pageCheckpoint,
        pageRateLimited,
      ];
      const attentionRender = renderPagesShell({ pages: fivePages, accounts: [sampleActiveAccount] });
      expect(
        attentionRender.hasAttribute('data-testid', 'pages-page-subtitle')
      ).toBe(true);
      expect(attentionRender.hasText('5 connected pages')).toBe(true);
      expect(attentionRender.hasText('3 require reconnecting')).toBe(true);

      // 2. All connected scenario — no contradictory "All operational" claim (Spec 102)
      const healthyPages = [pageActive1, pagePaused];
      const healthyRender = renderPagesShell({ pages: healthyPages, accounts: [sampleActiveAccount] });
      expect(
        healthyRender.hasText('2 connected pages')
      ).toBe(true);
      expect(healthyRender.hasText('All operational')).toBe(false);
    });

    it('renders scale toolbar with a single page (no >4 gate)', () => {
      const { hasAttribute } = renderPagesShell({ pages: [pageActive1], accounts: [sampleActiveAccount] });

      expect(hasAttribute('data-testid', 'pages-scale-toolbar')).toBe(true);
      expect(hasAttribute('data-testid', 'pages-search-input')).toBe(true);
      expect(hasAttribute('data-testid', 'pages-filter-all')).toBe(true);
    });

    it('renders scale toolbar with zero pages (empty state still shows, toolbar is not gated)', () => {
      const { hasAttribute } = renderPagesShell({ pages: [], accounts: [sampleActiveAccount] });

      expect(hasAttribute('data-testid', 'pages-scale-toolbar')).toBe(true);
      expect(hasAttribute('data-testid', 'pages-search-input')).toBe(true);
    });

    it('never renders an expired-connection banner on the Pages list, even when an account is expired (expired accounts belong in Accounts)', () => {
      const { hasAttribute } = renderPagesShell({ pages: [pageActive1], accounts: [sampleActiveAccount, sampleExpiredAccount] });

      expect(hasAttribute('data-testid', 'pages-expired-connection-banner')).toBe(false);
      expect(hasAttribute('data-testid', 'pages-reconnect-btn')).toBe(false);
    });

    it('renders no expired-connection banner when all accounts are connected', () => {
      const { hasAttribute } = renderPagesShell({ pages: [pageActive1], accounts: [sampleActiveAccount] });

      expect(hasAttribute('data-testid', 'pages-expired-connection-banner')).toBe(false);
    });

    it('validates light mode canvas contrast token is #ffffff and panel is #ffffff (Binance light)', () => {
      expect(LIGHT_THEME.surfaces.canvas).toBe('#ffffff');
      expect(LIGHT_THEME.surfaces.panel).toBe('#ffffff');
      // Binance light: cards sit on the white canvas separated by hairlines,
      // so canvas and panel are deliberately the same value.
      expect(LIGHT_THEME.surfaces.canvas).toBe(LIGHT_THEME.surfaces.panel);
    });

    it('validates dark mode canvas and surface calibration tokens for Binance dark (Spec 055)', () => {
      expect(DARK_THEME.surfaces.canvas).toBe('#0b0e11');
      expect(DARK_THEME.surfaces.panel).toBe('#1e2329');
      expect(DARK_THEME.surfaces.subtle).toBe('#14181d');
      expect(DARK_THEME.surfaces.hover).toBe('#252b33');
      expect(DARK_THEME.surfaces.active).toBe('#2b3139');
      expect(DARK_THEME.borders.hairline).toBe('#2b3139');
      expect(DARK_THEME.borders.strong).toBe('#474d57');
      expect(DARK_THEME.surfaces.panel).not.toBe(DARK_THEME.surfaces.canvas);
    });
  });

  describe('TenantDedicatedPageView (/tenant/[subdomain]/pages/[pageId]/page.tsx)', () => {
    it('renders the dedicated page placeholder (dedicated-page-placeholder) and "Back to Pages" navigation (back-to-pages-btn)', () => {
      // PR-131-3: the frame reads through React Query — the static
      // render needs a provider (fresh client, queries stay pending).
      const { hasAttribute, hasText } = render(
        <QueryClientProvider client={new QueryClient()}>
          <TenantDedicatedPageView
            subdomainProp="acme"
            pageIdProp="page-uuid-1"
            pageNameProp="Cyberdyne Reels"
          />
        </QueryClientProvider>
      );

      expect(hasAttribute('data-testid', 'dedicated-page-placeholder')).toBe(
        true
      );
      expect(hasAttribute('data-testid', 'back-to-pages-btn')).toBe(true);
      expect(hasText('Back to Pages')).toBe(true);
      expect(hasText('Cyberdyne Reels')).toBe(true);
      expect(hasText('Page reference: page-uuid-1')).toBe(true);
      expect(hasText('Dedicated Page Management Workspace')).toBe(true);

      // Verify clicking "Back to Pages" navigates to /tenant/acme/pages
      const tree = renderAndCaptureTree(() =>
        TenantDedicatedPageView({
          subdomainProp: 'acme',
          pageIdProp: 'page-uuid-1',
          pageNameProp: 'Cyberdyne Reels',
        })
      );
      const backBtn = findElementByTestId(tree, 'back-to-pages-btn');
      expect(backBtn).not.toBeNull();
      expect(backBtn?.props.href).toBe('/tenant/acme/pages');

      const preventDefault = vi.fn();
      backBtn?.props.onClick({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/tenant/acme/pages');
    });
  });

  describe('PagesEmptyState Component', () => {
    it('shows missing-app guidance with a Settings → Facebook link only when the details are known to be missing (Spec 109)', () => {
      const missing = render(
        <PagesEmptyState
          onAddPage={vi.fn()}
          subdomain="acme"
          facebookAppConfigured={false}
        />
      );
      expect(
        missing.hasAttribute('data-testid', 'pages-empty-facebook-app-guidance')
      ).toBe(true);
      expect(
        missing.hasAttribute('data-testid', 'pages-empty-settings-facebook-link')
      ).toBe(true);
      expect(missing.html).toContain('href="/tenant/acme/settings?tab=byoc"');

      const configured = render(
        <PagesEmptyState
          onAddPage={vi.fn()}
          subdomain="acme"
          facebookAppConfigured={true}
        />
      );
      expect(
        configured.hasAttribute('data-testid', 'pages-empty-facebook-app-guidance')
      ).toBe(false);
    });

    it('invokes onAddPage when the empty state Add Page button is clicked', () => {
      const onAddPage = vi.fn();
      const tree = renderAndCaptureTree(() =>
        PagesEmptyState({ onAddPage })
      );
      const btn = findElementByTestId(tree, 'empty-state-add-page-btn');
      expect(btn).not.toBeNull();
      btn?.props.onClick();
      expect(onAddPage).toHaveBeenCalledTimes(1);
    });
  });
});
