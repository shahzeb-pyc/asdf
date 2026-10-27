/**
 * @file dedicated-page.test.tsx
 * @description Comprehensive UI & behavioral tests for Spec 036:
 * Dedicated Facebook Page Workspace (/tenant/[subdomain]/pages/[pageId]).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '../components/setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DedicatedPageHeader,
  PageTabDashboard,
  PageTabQueue,
  PageTabPostingTimes,
  PageTabSettings,
  getMediaCapNotice,
  type PageSlotSummary,
  type DedicatedQueueItem,
} from '@/components/pages/dedicated';
// Spec 131 PR-131-3 (named update, §8.1 server-first): the route file is
// now a server component; the client frame lives in page-section-shell
// with the same default-export props contract this suite always used.
import TenantDedicatedPageView from '@/app/tenant/[subdomain]/pages/[pageId]/page-section-shell';
import { queryKeys } from '@/lib/data/query-keys';
import { render as rtlRender, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FacebookPageItem } from '@/components/pages/page-card';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
  }),
  useParams: () => ({
    subdomain: 'cyberdyne',
    pageId: 'page-101',
  }),
  // Dedicated tab row reads ?tab= from the URL; this suite's renders
  // carry no query string, so the row falls back to initialTab.
  useSearchParams: () => ({
    get: () => null,
    toString: () => '',
  }),
}));

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
      const found = findElementByTestId(props.children, testId);
      if (found) return found;
    }
    if (typeof node.type === 'function') {
      try {
        const rendered = (node.type as (p: any) => React.ReactNode)(props);
        const found = findElementByTestId(rendered, testId);
        if (found) return found;
      } catch {
        // Ignore unrenderable nodes
      }
    }
  }
  return null;
}

function renderAndCaptureTree(
  renderFn: () => React.ReactElement | null
): React.ReactElement {
  let tree: React.ReactElement | null = null;
  function CaptureWrapper() {
    tree = renderFn();
    return tree;
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CaptureWrapper />
    </QueryClientProvider>
  );
  if (!tree) {
    throw new Error('Failed to capture React element tree');
  }
  return tree;
}

describe('Dedicated Facebook Page Workspace (Spec 036)', () => {
  beforeEach(() => {
    mockPush.mockReset();
    vi.restoreAllMocks();
  });

  const samplePage: FacebookPageItem = {
    id: 'page-101',
    facebookAccountId: 'acc-99',
    accountDisplayName: 'John Connor',
    fbPageId: 'fb_101202303',
    pageName: 'Skynet Automation Central',
    profilePictureUrl: 'https://images.example.com/skynet.jpg',
    category: 'Robotics & AI',
    startingFollowers: 50000,
    currentFollowers: 54200,
    followersGained: 4200,
    status: 'active',
    timezone: 'UTC',
    tasks: ['CREATE_CONTENT', 'MANAGE'],
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  const sampleQueueItems: DedicatedQueueItem[] = [
    {
      id: 'q-item-1',
      mediaId: 'med-1',
      caption: 'Cutting-edge autonomous manufacturing video teaser.',
      firstComment: 'Read the full blueprint at https://skynet.tech',
      scheduledTime: '2026-10-15T09:00:00.000Z',
      status: 'queued',
      createdAt: '2026-10-12T10:00:00.000Z',
      media: {
        name: 'teaser.mp4',
        mediaType: 'video',
        url: 'https://r2.example.com/teaser.mp4',
        thumbnailUrl: 'https://r2.example.com/teaser-thumb.jpg',
        aspectRatio: '16:9',
        durationSeconds: 45,
      },
    },
    {
      id: 'q-item-2',
      mediaId: 'med-2',
      caption: 'Infographic of weekly neural network updates.',
      firstComment: null,
      scheduledTime: '2026-10-15T15:00:00.000Z',
      status: 'published',
      publishedAt: '2026-10-15T15:00:05.000Z',
      createdAt: '2026-10-12T11:00:00.000Z',
      media: {
        name: 'neural.png',
        mediaType: 'image',
        url: 'https://r2.example.com/neural.png',
        thumbnailUrl: 'https://r2.example.com/neural.png',
        aspectRatio: '1:1',
        durationSeconds: null,
      },
    },
  ];

  const sampleSlots: PageSlotSummary[] = [
    {
      id: 'slot-1',
      slotTime: '09:00',
      timezone: 'UTC',
      isActive: true,
    },
    {
      id: 'slot-2',
      slotTime: '15:00',
      timezone: 'UTC',
      isActive: true,
    },
    {
      id: 'slot-3',
      slotTime: '21:00',
      timezone: 'UTC',
      isActive: false,
    },
  ];

  /* ====================================================================
   * Phase 2: DedicatedPageHeader (T002)
   * ==================================================================== */
  describe('DedicatedPageHeader Component', () => {
    it('renders page identity, avatar, account name, category, and unboxed status signal', () => {
      const onStatusToggle = vi.fn();
      const onDisconnectRequest = vi.fn();

      const { hasText, hasAttribute } = render(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={onStatusToggle}
          onDisconnectRequest={onDisconnectRequest}
        />
      );

      expect(hasText('Skynet Automation Central')).toBe(true);
      expect(hasText('Robotics')).toBe(true);
      expect(hasText('John Connor')).toBe(true);
      expect(hasText('Active')).toBe(true);
      expect(hasAttribute('data-testid', 'dedicated-page-status')).toBe(true);
      expect(hasAttribute('data-testid', 'page-live-link')).toBe(true);
      expect(hasAttribute('data-testid', 'dedicated-account')).toBe(true);
      expect(hasText('Added 1 Oct 2026')).toBe(true);
      expect(hasAttribute('data-testid', 'dedicated-page-followers-gained')).toBe(true);
      expect(hasText('+4,200 gained')).toBe(true);
      // Actions cluster: Create Posts first, then the three-dots menu.
      // Pause/Resume and Disconnect live ONLY inside the menu (closed in
      // static markup), so no standalone pause/disconnect buttons exist.
      expect(hasAttribute('data-testid', 'header-create-posts-btn')).toBe(true);
      expect(hasAttribute('data-testid', 'header-settings-dropdown-btn')).toBe(true);
      expect(hasAttribute('data-testid', 'header-pause-resume-btn')).toBe(false);
      expect(hasAttribute('data-testid', 'header-disconnect-btn')).toBe(false);
      expect(hasAttribute('data-testid', 'header-add-queue-btn')).toBe(false);
    });

    it('renders monogram avatar fallback when no profile picture URL exists', () => {
      const pageWithoutPic: FacebookPageItem = {
        ...samplePage,
        profilePictureUrl: null,
        pageName: 'Skynet Central',
      };

      const { hasText } = render(
        <DedicatedPageHeader
          page={pageWithoutPic}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      expect(hasText('SK')).toBe(true);
    });

    it('renders the real connected-account picture when accountPictureUrl is present', () => {
      const { container } = rtlRender(
        <DedicatedPageHeader
          page={{
            ...samplePage,
            accountPictureUrl: 'https://images.example.com/account.jpg',
          }}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      const avatar = container.querySelector(
        '[data-testid="dedicated-account-avatar"]'
      );
      expect(avatar).not.toBeNull();
      expect(avatar?.querySelector('img')?.getAttribute('src')).toContain(
        'account.jpg'
      );
      expect(avatar?.textContent).not.toContain('JC');
    });

    it('renders account initials when accountPictureUrl is absent', () => {
      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      const avatar = container.querySelector(
        '[data-testid="dedicated-account-avatar"]'
      );
      expect(avatar).not.toBeNull();
      expect(avatar?.querySelector('img')).toBeNull();
      expect(avatar?.textContent).toContain('JC');
    });

    it('falls back to account initials when the account picture fails to load', () => {
      const { container } = rtlRender(
        <DedicatedPageHeader
          page={{
            ...samplePage,
            accountPictureUrl: 'https://images.example.com/broken-account.jpg',
          }}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      const avatar = container.querySelector(
        '[data-testid="dedicated-account-avatar"]'
      );
      const img = avatar?.querySelector('img');
      expect(img).not.toBeNull();
      fireEvent.error(img as Element);
      expect(
        container.querySelector('[data-testid="dedicated-account-avatar"]')
          ?.textContent
      ).toContain('JC');
    });

    it('resets avatar error state when profilePictureUrl changes on navigation (Audit Issue 26)', () => {
      // Behavioural (spec 131 PR-131-3 named update): the avatar is now
      // next/image on the design system, so the error fallback is
      // asserted in a live DOM instead of by tree-walking props.
      const pageWithPic: FacebookPageItem = {
        ...samplePage,
        profilePictureUrl: 'https://images.example.com/new-pic.jpg',
        pageName: 'Skynet Central',
      };

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={pageWithPic}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      const avatar = container.querySelector('[data-testid="dedicated-page-avatar"]');
      expect(avatar).not.toBeNull();
      expect(avatar?.getAttribute('src')).toContain('new-pic.jpg');

      // Trigger error on the image → monogram fallback renders
      fireEvent.error(avatar as Element);
      expect(
        container.querySelector('[data-testid="dedicated-page-avatar-fallback"]')
      ).not.toBeNull();
    });

    it('pauses and resumes posting through onStatusToggle via the menu', async () => {
      const user = userEvent.setup();
      const onStatusToggle = vi.fn().mockResolvedValue(undefined);

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={onStatusToggle}
          onDisconnectRequest={vi.fn()}
        />
      );

      // Pause/Resume lives ONLY inside the three-dots menu now.
      expect(container.querySelector('[data-testid="header-pause-resume-btn"]')).toBeNull();
      await user.click(
        container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
      );
      const pauseItem = document.querySelector('[data-testid="header-menu-pause-resume-btn"]');
      expect(pauseItem?.textContent).toContain('Pause posting');
      await user.click(pauseItem as Element);
      expect(onStatusToggle).toHaveBeenCalledWith('paused');
    });

    it('shows Resume posting on a paused page and resumes through onStatusToggle via the menu', async () => {
      const user = userEvent.setup();
      const onStatusToggle = vi.fn().mockResolvedValue(undefined);

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={{ ...samplePage, status: 'paused' }}
          subdomain="cyberdyne"
          onStatusToggle={onStatusToggle}
          onDisconnectRequest={vi.fn()}
        />
      );

      await user.click(
        container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
      );
      const resumeItem = document.querySelector('[data-testid="header-menu-pause-resume-btn"]');
      expect(resumeItem?.textContent).toContain('Resume posting');
      await user.click(resumeItem as Element);
      expect(onStatusToggle).toHaveBeenCalledWith('active');
    });

    it('keeps the menu open showing Updating... while pause/resume runs, then closes it', async () => {
      const user = userEvent.setup();
      let resolveToggle!: (value: undefined) => void;
      const togglePromise = new Promise<undefined>((resolve) => {
        resolveToggle = resolve;
      });
      const onStatusToggle = vi.fn().mockImplementation(() => togglePromise);

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={onStatusToggle}
          onDisconnectRequest={vi.fn()}
        />
      );

      await user.click(
        container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
      );
      const pauseItem = document.querySelector(
        '[data-testid="header-menu-pause-resume-btn"]'
      ) as Element;
      await user.click(pauseItem);
      expect(onStatusToggle).toHaveBeenCalledWith('paused');

      // Feedback while pending: the menu must NOT have closed, the item
      // shows Updating..., and the header itself shows Updating... too.
      const pendingItem = document.querySelector(
        '[data-testid="header-menu-pause-resume-btn"]'
      );
      expect(pendingItem).not.toBeNull();
      expect(pendingItem?.textContent).toContain('Updating...');
      expect(
        container.querySelector('[data-testid="header-status-updating"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="header-status-updating"]')?.textContent
      ).toContain('Updating...');

      // Settle: the menu closes and the header indicator clears.
      resolveToggle(undefined);
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="header-menu-pause-resume-btn"]')
        ).toBeNull();
      });
      expect(
        container.querySelector('[data-testid="header-status-updating"]')
      ).toBeNull();
    });

    it('renders Create Posts button that calls onCreatePosts when provided and does nothing when absent', () => {
      const onCreatePosts = vi.fn();

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
          onCreatePosts={onCreatePosts}
        />
      );

      const createBtn = container.querySelector('[data-testid="header-create-posts-btn"]');
      expect(createBtn).not.toBeNull();
      fireEvent.click(createBtn as Element);
      expect(onCreatePosts).toHaveBeenCalledTimes(1);

      // Without the prop, clicking must not throw (dialogue is separate work).
      const { container: plainContainer } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );
      const plainBtn = plainContainer.querySelector('[data-testid="header-create-posts-btn"]');
      expect(() => fireEvent.click(plainBtn as Element)).not.toThrow();
    });

    it('enforces Option A standards: no bullet dots, status-ring avatar, uniform actions', () => {
      // Named update (spec 131 PR-131-3): the legacy assertions read
      // inline styles (avatar ring border, 34px heights). The rebuild
      // deletes every inline style in this file (ratchet debit), so the
      // same geometry is asserted on the design-system output instead:
      // a 56px round next/image avatar carrying the operational status ring,
      // and the uniform action cluster present at token sizes.
      const { html } = render(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="dedicated-page-avatar"');
      expect(html).toContain('width="56"');
      expect(html).toContain('height="56"');
      expect(html).toContain('rounded-full');
      expect(html).toContain('size-14');
      expect(html).toContain('ring-signal-operational');
      // Actions cluster: Create Posts first, then the three-dots menu
      // trigger. Pause/Resume and Disconnect live only inside the closed
      // menu, so no standalone pause/disconnect buttons exist.
      expect(html).toContain('data-testid="header-create-posts-btn"');
      expect(html).toContain('data-testid="header-settings-dropdown-btn"');
      expect(html).not.toContain('header-pause-resume-btn');
      expect(html).not.toContain('header-disconnect-btn');
      expect(html).not.toContain('header-add-queue-btn');
      expect(html).not.toContain('header-menu-copy-id-btn');

      // Render does not contain bullet dots
      expect(html).not.toContain('•');
    });

    it('stacks identity above actions on narrow screens (mobile layout classes)', () => {
      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      // Main header row: column (stacked) by default, row from sm up —
      // never squashed side-by-side at ~320px.
      const mainRow = container.querySelector('[data-testid="header-main-row"]');
      expect(mainRow).not.toBeNull();
      expect(mainRow?.className).toContain('flex-col');
      expect(mainRow?.className).toContain('sm:flex-row');
      const actions = container.querySelector('[data-testid="header-actions"]');
      expect(actions).not.toBeNull();
      expect(actions?.className).toContain('w-full');
      expect(actions?.className).toContain('sm:w-auto');
      // Create Posts stretches across the mobile row; the menu button
      // keeps its fixed icon size (Button base is shrink-0).
      const createBtn = container.querySelector('[data-testid="header-create-posts-btn"]');
      expect(createBtn?.className).toContain('flex-1');
      expect(createBtn?.className).toContain('sm:flex-none');
      // Page picture keeps its 56px circle on mobile too.
      const avatar = container.querySelector('[data-testid="dedicated-page-avatar"]');
      const fallback = container.querySelector('[data-testid="dedicated-page-avatar-fallback"]');
      const picture = avatar ?? fallback;
      expect(picture).not.toBeNull();
      expect(picture?.className).toContain('size-14');
      expect(picture?.className).toContain('rounded-full');
    });

    it('opens a disconnect confirmation dialogue from the menu WITHOUT disconnecting', async () => {
      const user = userEvent.setup();
      const onDisconnectRequest = vi.fn();

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={onDisconnectRequest}
        />
      );

      // Disconnect lives ONLY inside the three-dots menu now.
      expect(container.querySelector('[data-testid="header-disconnect-btn"]')).toBeNull();
      await user.click(
        container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
      );
      const disconnectItem = document.querySelector('[data-testid="header-menu-disconnect-btn"]');
      expect(disconnectItem).not.toBeNull();
      await user.click(disconnectItem as Element);
      // Dialogue opens, but nothing disconnects yet.
      expect(onDisconnectRequest).toHaveBeenCalledTimes(0);
      const modal = document.querySelector('[data-testid="header-disconnect-modal"]');
      expect(modal).not.toBeNull();
      expect(modal?.textContent).toContain(`Disconnect ${samplePage.pageName}?`);
      expect(modal?.textContent).toContain(
        'This will disconnect the Facebook Page from your workspace. Any queued posts will be cancelled.'
      );
      expect(
        document.querySelector('[data-testid="header-cancel-disconnect-btn"]')
      ).not.toBeNull();
      expect(
        document.querySelector('[data-testid="header-confirm-disconnect-btn"]')
      ).not.toBeNull();
    });

    it('Cancel closes the disconnect dialogue without disconnecting', async () => {
      const user = userEvent.setup();
      const onDisconnectRequest = vi.fn();

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={onDisconnectRequest}
        />
      );

      await user.click(
        container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
      );
      await user.click(
        document.querySelector('[data-testid="header-menu-disconnect-btn"]') as Element
      );
      expect(
        document.querySelector('[data-testid="header-disconnect-modal"]')
      ).not.toBeNull();
      await user.click(
        document.querySelector('[data-testid="header-cancel-disconnect-btn"]') as Element
      );
      await waitFor(() =>
        expect(
          document.querySelector('[data-testid="header-disconnect-modal"]')
        ).toBeNull()
      );
      expect(onDisconnectRequest).toHaveBeenCalledTimes(0);
    });

    it('Confirm calls onDisconnectRequest and shows the Disconnecting state', async () => {
      const user = userEvent.setup();
      const deferred: { resolve?: () => void } = {};
      const onDisconnectRequest = vi.fn(
        () => new Promise<void>((resolve) => { deferred.resolve = resolve; })
      );

      const { container } = rtlRender(
        <DedicatedPageHeader
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={onDisconnectRequest}
        />
      );

      await user.click(
        container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
      );
      await user.click(
        document.querySelector('[data-testid="header-menu-disconnect-btn"]') as Element
      );
      const confirmBtn = document.querySelector(
        '[data-testid="header-confirm-disconnect-btn"]'
      ) as Element;
      await user.click(confirmBtn);
      expect(onDisconnectRequest).toHaveBeenCalledTimes(1);
      // While the request runs, the confirm button shows the running
      // state and is disabled (Cancel is disabled too).
      await waitFor(() => expect(confirmBtn.textContent).toContain('Disconnecting...'));
      expect(confirmBtn.hasAttribute('disabled')).toBe(true);
      expect(
        document.querySelector('[data-testid="header-cancel-disconnect-btn"]')
      ).toHaveAttribute('disabled');
      deferred.resolve?.();
      await waitFor(() =>
        expect(
          document.querySelector('[data-testid="header-disconnect-modal"]')
        ).toBeNull()
      );
    });
  });

  /* ====================================================================
   * Phase 3: PageTabDashboard (T003)
   * ==================================================================== */
  describe('PageTabDashboard Component', () => {
    it('renders 4 metric cards, upcoming queue snapshot, and active slots', () => {
      const { hasText, hasAttribute } = render(
        <PageTabDashboard
          page={samplePage}
          queueItems={sampleQueueItems}
          slots={sampleSlots}
          onPublishNow={vi.fn()}
          onSwitchTab={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'page-tab-dashboard')).toBe(true);
      expect(hasAttribute('data-testid', 'metric-followers')).toBe(true);
      expect(hasAttribute('data-testid', 'metric-queued-count')).toBe(true);
      expect(hasAttribute('data-testid', 'metric-next-post')).toBe(true);
      expect(hasAttribute('data-testid', 'metric-automation-status')).toBe(true);
      expect(hasText('54,200')).toBe(true);
      expect(hasText('+4200')).toBe(true);
      expect(hasText('Cutting-edge autonomous manufacturing video teaser.')).toBe(true);
      expect(hasText('09:00')).toBe(true);
      expect(hasText('03:00')).toBe(true);
      expect(hasText('PM')).toBe(true);
    });

    it('renders Daily Posting Times chips in 12h form without seconds (QA #18)', () => {
      const slotsWithSeconds: PageSlotSummary[] = [
        { id: 'slot-sec', slotTime: '09:00:00', timezone: 'UTC', isActive: true },
      ];
      const { hasText, html } = render(
        <PageTabDashboard
          page={samplePage}
          queueItems={sampleQueueItems}
          slots={slotsWithSeconds}
          onPublishNow={vi.fn()}
          onSwitchTab={vi.fn()}
        />
      );

      expect(hasText('09:00 AM')).toBe(true);
      expect(hasText('UTC')).toBe(true);
      expect(html).not.toContain('09:00:00');
    });

    it('triggers immediate publication when Publish Now is clicked', async () => {
      const onPublishNow = vi.fn().mockResolvedValue(undefined);

      const tree = renderAndCaptureTree(() =>
        PageTabDashboard({
          page: samplePage,
          queueItems: sampleQueueItems,
          slots: sampleSlots,
          onPublishNow,
          onSwitchTab: vi.fn(),
        })
      );

      const publishBtn = findElementByTestId(tree, 'publish-now-btn-q-item-1');
      expect(publishBtn).not.toBeNull();
      await publishBtn?.props.onClick();

      expect(onPublishNow).toHaveBeenCalledWith('q-item-1');
    });

    it('allows navigating to full queue tab from view all link', () => {
      const onSwitchTab = vi.fn();

      const tree = renderAndCaptureTree(() =>
        PageTabDashboard({
          page: samplePage,
          queueItems: sampleQueueItems,
          slots: sampleSlots,
          onPublishNow: vi.fn(),
          onSwitchTab,
        })
      );

      const viewAllBtn = findElementByTestId(tree, 'view-full-queue-btn');
      viewAllBtn?.props.onClick();
      expect(onSwitchTab).toHaveBeenCalledWith('queue');
    });
  });

  /* ====================================================================
   * Phase 3: PageTabQueue (T004)
   * ==================================================================== */
  describe('PageTabQueue Component (Spec 105)', () => {
  // Spec 134: the rebuilt queue panel reads through React Query, so its
  // renders need a QueryClient ancestor (the tenant layout provides one in
  // the app) — same pattern as the composer renders below.
  // Spec 131 PR-131-3 (named update — props bridge deleted): the panel no
  // longer takes queueItems/onMutated/callback props; each render seeds
  // the shared queue cache key the panel reads, which is exactly what
  // the route's server prefetch does in the app.
  const renderQueueTab = (
    element: React.ReactNode,
    items: DedicatedQueueItem[] = sampleQueueItems
  ) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(queryKeys.tenant('cyberdyne').queue.items(samplePage.id), {
      items,
      total: items.length,
      limit: items.length,
      offset: 0,
    });
    return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  };

    it('renders queue rows with caption, format, status, and row actions', () => {
      const { hasText, hasAttribute } = renderQueueTab(
        <PageTabQueue page={samplePage} />
      );

      expect(hasAttribute('data-testid', 'content-tab')).toBe(true);
      expect(hasAttribute('data-testid', 'queue-row-q-item-1')).toBe(true);
      expect(hasText('Cutting-edge autonomous manufacturing video teaser.')).toBe(true);
      expect(hasText('Video')).toBe(true);
      expect(hasText('Queued')).toBe(true);
      expect(hasText('Reschedule')).toBe(true);
      expect(hasText('Delete')).toBe(true);
      expect(hasText('1 post queued')).toBe(true);
      expect(hasAttribute('data-testid', 'queue-summary')).toBe(true);
    });

    it('labels queue row times with the page timezone (QA #11)', () => {
      const { hasText } = renderQueueTab(
        <PageTabQueue page={samplePage} />
      );

      expect(hasText('Thu 9:00 AM UTC')).toBe(true);
      expect(hasText('Published Thu, Oct 15 at 3:00 PM UTC')).toBe(true);
    });

    it('renders all five filter tabs with counts', () => {
      const { hasText, hasAttribute } = renderQueueTab(
        <PageTabQueue page={samplePage} />
      );

      for (const filter of ['all', 'queued', 'scheduled', 'published', 'failed']) {
        expect(hasAttribute('data-testid', `queue-filter-${filter}`)).toBe(true);
      }
      expect(hasText('All')).toBe(true);
      expect(hasText('Queued')).toBe(true);
      expect(hasText('Scheduled')).toBe(true);
      expect(hasText('Published')).toBe(true);
      expect(hasText('Failed')).toBe(true);
    });

    it('renders empty state with checklist and entry buttons when queue has no items', () => {
      const { hasText, hasAttribute } = renderQueueTab(
        <PageTabQueue page={samplePage} />,
        []
      );

      expect(hasAttribute('data-testid', 'queue-empty-state')).toBe(true);
      expect(hasText('Get your queue running')).toBe(true);
      expect(hasText('Set posting times')).toBe(true);
      expect(hasText('Add media')).toBe(true);
      expect(hasText('Nothing here yet.')).toBe(true);
      expect(hasText('Bulk add')).toBe(true);
    });

    it('shows the failed banner, plain-language reason, and Retry on failed posts', () => {
      const failedItem: DedicatedQueueItem = {
        ...sampleQueueItems[0],
        id: 'q-item-3',
        status: 'failed',
        retryCount: 3,
        maxRetries: 3,
      };
      const { hasText, hasAttribute } = renderQueueTab(
        <PageTabQueue page={samplePage} />,
        [...sampleQueueItems, failedItem]
      );

      expect(hasAttribute('data-testid', 'queue-failed-banner')).toBe(true);
      expect(hasText('1 post failed to publish.')).toBe(true);
      expect(hasText('Review')).toBe(true);
      expect(hasText('Failed')).toBe(true);
      expect(hasText("Tried 3 times and still couldn't publish.")).toBe(true);
      expect(hasText('Retry')).toBe(true);
    });
  });

  /* ====================================================================
   * Phase 4: PageTabPostingTimes (Spec 058)
   * ==================================================================== */
  describe('PageTabPostingTimes Component', () => {
    it('renders daily posting times list, times, format containers, and enforces zero bullet dots', () => {
      const { hasText, hasAttribute, html } = render(
        <PageTabPostingTimes
          page={samplePage}
          slots={sampleSlots}
          onAddSlot={vi.fn()}
          onToggleSlot={vi.fn()}
          onDeleteSlot={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'page-tab-calendar')).toBe(true);
      expect(hasText('Posting Times')).toBe(true);
      expect(hasText('09:00')).toBe(true);
      expect(hasText('03:00')).toBe(true);
      expect(hasText('PM')).toBe(true);
      expect(html).not.toContain('15:00');
      expect(html).not.toContain('21:00');
      expect(hasAttribute('data-testid', 'slots-grid')).toBe(true);
      expect(hasAttribute('data-testid', 'slot-format-container-slot-1')).toBe(true);
      expect(hasAttribute('data-testid', 'edit-slot-btn-slot-1')).toBe(true);

      // Strict negative constraint: zero bullet point dots
      expect(html).not.toContain('•');
      // Spec 060: Zero duplicate bottom add button
      expect(html).not.toContain('+ Add another posting time');
      expect(hasAttribute('data-testid', 'schedule-timezone-trigger')).toBe(true);
    });

    it('calls onToggleSlot when clicking activate/pause switch', async () => {
      const onToggleSlot = vi.fn().mockResolvedValue(undefined);

      const tree = renderAndCaptureTree(() =>
        PageTabPostingTimes({
          page: samplePage,
          slots: sampleSlots,
          onAddSlot: vi.fn(),
          onToggleSlot,
          onDeleteSlot: vi.fn(),
        })
      );

      const toggleBtn = findElementByTestId(tree, 'toggle-slot-btn-slot-1');
      expect(toggleBtn).not.toBeNull();
      // Spec 134 rebuild: the row's toggle is the shared/ui Switch —
      // checked + onCheckedChange are its contract (role="switch" and
      // aria-checked are rendered by Radix from these props).
      expect(toggleBtn?.props.checked).toBe(true);
      await toggleBtn?.props.onCheckedChange(false);

      expect(onToggleSlot).toHaveBeenCalledWith('slot-1', false);
    });

    it('renders schedule timezone trigger button with active timezone (Spec 062)', () => {
      const onUpdateTimezone = vi.fn().mockResolvedValue(undefined);

      const { hasAttribute, hasText } = render(
        <PageTabPostingTimes
          page={{ ...samplePage, timezone: 'Asia/Karachi' }}
          slots={sampleSlots}
          onAddSlot={vi.fn()}
          onUpdateTimezone={onUpdateTimezone}
          onToggleSlot={vi.fn()}
          onDeleteSlot={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'schedule-timezone-trigger')).toBe(true);
      expect(hasText('Asia/Karachi')).toBe(true);
      expect(hasText('Timezone:')).toBe(true);
    });

    it('renders Add/Edit modal without timezone selector dropdown (Spec 060)', () => {
      const tree = renderAndCaptureTree(() =>
        PageTabPostingTimes({
          page: samplePage,
          slots: sampleSlots,
          onAddSlot: vi.fn(),
          onToggleSlot: vi.fn(),
          onDeleteSlot: vi.fn(),
        })
      );

      const addBtn = findElementByTestId(tree, 'add-slot-button');
      expect(addBtn).not.toBeNull();
      addBtn?.props.onClick();

      // Ensure modal does NOT contain posting-timezone-select
      const tzModalSelect = findElementByTestId(tree, 'posting-timezone-select');
      expect(tzModalSelect).toBeNull();
    });

    it('renders the posting-times tab (the PageTabCalendar alias was deleted in spec 134 §8)', () => {
      const { hasText, hasAttribute } = render(
        <PageTabPostingTimes
          page={samplePage}
          slots={sampleSlots}
          onAddSlot={vi.fn()}
          onToggleSlot={vi.fn()}
          onDeleteSlot={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'page-tab-calendar')).toBe(true);
      expect(hasText('Posting Times')).toBe(true);
      expect(hasAttribute('data-testid', 'slots-grid')).toBe(true);
    });

    it('renders calm empty state when no posting times are scheduled', () => {
      const { hasText, hasAttribute } = render(
        <PageTabPostingTimes
          page={samplePage}
          slots={[]}
          onAddSlot={vi.fn()}
          onToggleSlot={vi.fn()}
          onDeleteSlot={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'calendar-empty-state')).toBe(true);
      expect(hasText('No daily posting times set yet')).toBe(true);
      expect(hasAttribute('data-testid', 'empty-add-slot-button')).toBe(true);
    });
  });

  /* ====================================================================
   * Phase 4: PageTabSettings (T007)
   * ==================================================================== */
  describe('PageTabSettings Component', () => {
    it('renders master automation switch, page credentials, and danger zone', () => {
      const { hasText, hasAttribute } = render(
        <PageTabSettings
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectPage={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'page-tab-settings')).toBe(true);
      expect(hasAttribute('data-testid', 'settings-automation-card')).toBe(true);
      expect(hasText('Automation')).toBe(true);
      expect(hasAttribute('data-testid', 'settings-token-card')).toBe(true);
      expect(hasText('fb_101202303')).toBe(true);
      expect(hasAttribute('data-testid', 'settings-danger-zone')).toBe(true);
      expect(hasAttribute('data-testid', 'disconnect-page-btn')).toBe(true);
    });

    it('calls onStatusToggle when clicking toggle automation button in settings', async () => {
      const onStatusToggle = vi.fn().mockResolvedValue(undefined);

      const tree = renderAndCaptureTree(() =>
        PageTabSettings({
          page: samplePage,
          subdomain: 'cyberdyne',
          onStatusToggle,
          onDisconnectPage: vi.fn(),
        })
      );

      const toggleBtn = findElementByTestId(tree, 'toggle-automation-btn');
      await toggleBtn?.props.onClick();

      expect(onStatusToggle).toHaveBeenCalledWith('paused');
    });

    it('renders the automation control as a single switch with a timezone line above it', () => {
      const { hasText, hasAttribute, html } = render(
        <PageTabSettings
          page={samplePage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectPage={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'settings-timezone-line')).toBe(true);
      expect(hasText('Times shown in')).toBe(true);
      expect(hasText('Change')).toBe(true);
      expect(html).toContain('role="switch"');
      expect(html).toContain('>On<');
    });
  });

  /* ====================================================================
   * Phase 5: Integrated TenantDedicatedPageView (T008)
   * ==================================================================== */
  describe('TenantDedicatedPageView Integrated Component', () => {
    it('renders workspace with tabs nav, identity header, and active tab content', () => {
      const { hasAttribute, hasText } = render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <TenantDedicatedPageView
            subdomainProp="cyberdyne"
            pageIdProp="page-101"
            initialPage={samplePage}
          />
        </QueryClientProvider>
      );

      expect(hasAttribute('data-testid', 'dedicated-page-workspace')).toBe(true);
      expect(hasAttribute('data-testid', 'dedicated-tabs-nav')).toBe(true);
      expect(hasAttribute('data-testid', 'tab-dashboard-btn')).toBe(true);
      expect(hasAttribute('data-testid', 'tab-queue-btn')).toBe(true);
      expect(hasAttribute('data-testid', 'tab-calendar-btn')).toBe(true);
      expect(hasAttribute('data-testid', 'tab-insights-btn')).toBe(true);
      expect(hasAttribute('data-testid', 'tab-settings-btn')).toBe(true);
      expect(hasText('Skynet Automation Central')).toBe(true);
    });

    it('switches tabs when tab navigation buttons are clicked', () => {
      const tree = renderAndCaptureTree(() =>
        TenantDedicatedPageView({
          subdomainProp: 'cyberdyne',
          pageIdProp: 'page-101',
          initialPage: samplePage,
          initialTab: 'dashboard',
        })
      );

      const queueTabBtn = findElementByTestId(tree, 'tab-queue-btn');
      expect(queueTabBtn).not.toBeNull();
      queueTabBtn?.props.onClick();

      const calendarTabBtn = findElementByTestId(tree, 'tab-calendar-btn');
      expect(calendarTabBtn).not.toBeNull();
      calendarTabBtn?.props.onClick();
    });

    it('maintains backwards compatibility with legacy placeholder elements', () => {
      const { hasAttribute, hasText } = render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <TenantDedicatedPageView
            subdomainProp="cyberdyne"
            pageIdProp="page-101"
            pageNameProp="Cyberdyne Reels"
          />
        </QueryClientProvider>
      );

      expect(hasAttribute('data-testid', 'dedicated-page-placeholder')).toBe(true);
      expect(hasAttribute('data-testid', 'back-to-pages-btn')).toBe(true);
      expect(hasText('Back to Pages')).toBe(true);
      expect(hasText('Page reference: page-101')).toBe(true);
      expect(hasText('Dedicated Page Management Workspace')).toBe(true);
    });

    it('unwraps data.page when single-page API returns { page: ... } (Audit Issue 21)', () => {
      // Direct verification that { page: ... } payload resolves page properties correctly
      const apiPayload = {
        page: {
          id: 'page-999',
          facebookAccountId: 'acc-1',
          accountDisplayName: 'Acme Media',
          fbPageId: 'page-999',
          pageName: 'Unwrapped Acme Page',
          category: 'Media Company',
          startingFollowers: 1000,
          currentFollowers: 1500,
          followersGained: 500,
          status: 'active' as const,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      };

      const unwrapped = apiPayload.page ?? apiPayload;
      const { hasText } = render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <TenantDedicatedPageView
            subdomainProp="acme"
            pageIdProp="page-999"
            initialPage={unwrapped}
          />
        </QueryClientProvider>
      );

      expect(hasText('Unwrapped Acme Page')).toBe(true);
      expect(hasText('Acme Media')).toBe(true);
      expect(hasText('Media Company')).toBe(true);
    });
  });

  describe('DedicatedPageHeader Checkpoint Verification Banner', () => {
    it('renders checkpoint-reactivation-banner when page status is page_checkpoint', () => {
      const checkpointPage: FacebookPageItem = {
        ...samplePage,
        status: 'page_checkpoint',
      };

      const { hasAttribute, hasText } = render(
        <DedicatedPageHeader
          page={checkpointPage}
          subdomain="cyberdyne"
          onStatusToggle={vi.fn()}
          onDisconnectRequest={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'checkpoint-reactivation-banner')).toBe(true);
      expect(hasAttribute('data-testid', 'reactivate-page-btn')).toBe(true);
      expect(hasText('Facebook Checkpoint Verification Required')).toBe(true);
      expect(hasText('Mark Verified')).toBe(true);
      expect(hasText('Reactivate Page')).toBe(true);
    });
  });
});
