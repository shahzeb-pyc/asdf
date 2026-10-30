/**
 * @file pages-header-shell-audit.test.tsx
 * @description Area 4 (header/navigation/shell) audit fixes:
 * R19 branched page-error states with Retry, R20 fallback list walk
 * beyond page 1, R27 active-tab scroll-into-view, K11 slots/queue
 * gating for a not-found page, the Pause/Disconnect mutual guard,
 * and the honest disconnect-dialogue copy.
 *
 * Seams: global fetch is stubbed per test (the shell talks to the
 * API through the typed client, which uses global fetch), and
 * next/navigation is mocked with a mutable ?tab= query string.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantDedicatedPageView from '@/app/tenant/[subdomain]/pages/[pageId]/page-section-shell';
import { DedicatedPageHeader } from '@/components/pages/dedicated';
import type { FacebookPageItem } from '@/components/pages/page-card';
import {
  registerSessionExpiredHandler,
  resetSessionExpiredGuard,
} from '@/lib/api/session-expired';

const mockPush = vi.fn();
let mockQuery = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useParams: () => ({ subdomain: 'cyberdyne', pageId: TARGET_ID }),
  useSearchParams: () => ({
    get: (key: string) => new URLSearchParams(mockQuery).get(key),
    toString: () => mockQuery,
  }),
}));

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

function makeView(id: string, name: string) {
  return {
    id,
    facebookAccountId: ACCOUNT_ID,
    accountDisplayName: 'John Connor',
    accountPictureUrl: null,
    fbPageId: `fb_${id.slice(0, 4)}`,
    pageName: name,
    profilePictureUrl: null,
    category: null,
    timezone: 'UTC',
    startingFollowers: 0,
    currentFollowers: 10,
    followersGained: 10,
    followersCount: 10,
    status: 'active',
    tasks: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const targetView = makeView(TARGET_ID, 'Target Page');
const otherView = makeView(OTHER_ID, 'Other Page');

// Mutable fetch behaviour, reset per test.
let detailStatus: number | 'success' = 'success';
let detailAttempts = 0;
let listMode: 'without' | 'beyond' = 'without';
const fetchUrls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    fetchUrls.push(url);
    if (url.includes(`/pages/${TARGET_ID}/slots`)) {
      return jsonResponse({ slots: [], total: 0 });
    }
    if (url.includes('/publishing/queue')) {
      return jsonResponse({ items: [], total: 0, limit: 100, offset: 0 });
    }
    if (url.includes(`/pages/${TARGET_ID}`)) {
      detailAttempts += 1;
      // Retry test: first attempt fails, later attempts succeed.
      if (detailStatus === 'success' || detailAttempts > 1) {
        return jsonResponse({
          page: targetView,
          queueCounts: { queued: 0, publishing: 0, published: 0, failed: 0 },
        });
      }
      return jsonResponse({ error: 'failed' }, detailStatus);
    }
    if (url.includes('/pages')) {
      const parsed = new URL(url, 'https://app.example.com');
      const pageParam = Number.parseInt(parsed.searchParams.get('page') ?? '1', 10);
      if (listMode === 'beyond' && pageParam >= 2) {
        return jsonResponse({
          pages: [targetView],
          total: 51,
          page: pageParam,
          limit: 50,
          totalPages: 2,
        });
      }
      if (listMode === 'beyond') {
        // A real non-last page is full (50 items): a short page is
        // the last page, so the walk would stop on a 1-item page.
        const fullPage = Array.from({ length: 50 }, (_, i) =>
          makeView(`22222222-2222-4222-8222-${String(i).padStart(12, '0')}`, `Other ${i}`)
        );
        return jsonResponse({
          pages: fullPage,
          total: 51,
          page: pageParam,
          limit: 50,
          totalPages: 2,
        });
      }
      return jsonResponse({
        pages: [otherView],
        total: 1,
        page: pageParam,
        limit: 50,
        totalPages: 1,
      });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderShell() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <TenantDedicatedPageView subdomainProp="cyberdyne" pageIdProp={TARGET_ID} />
    </QueryClientProvider>
  );
  return { ...utils, client };
}

const samplePage: FacebookPageItem = {
  id: TARGET_ID,
  facebookAccountId: ACCOUNT_ID,
  accountDisplayName: 'John Connor',
  fbPageId: 'fb_1111',
  pageName: 'Target Page',
  profilePictureUrl: 'https://images.example.com/target.jpg',
  category: 'Robotics & AI',
  startingFollowers: 0,
  currentFollowers: 10,
  followersGained: 10,
  status: 'active',
  timezone: 'UTC',
  tasks: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => {
  mockPush.mockReset();
  mockQuery = '';
  detailStatus = 'success';
  detailAttempts = 0;
  listMode = 'without';
  fetchUrls.length = 0;
  resetSessionExpiredGuard();
  // A 401 must not navigate the test browser away: register the
  // no-op handler so the shell's error state itself is exercised.
  registerSessionExpiredHandler(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('R19 branched page-error states', () => {
  it('shows Not Found with Return only (no Retry) for a proven absence', async () => {
    detailStatus = 404;
    listMode = 'without';
    installFetch();
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('page-error-state')).not.toBeNull();
    });
    expect(screen.getByTestId('page-error-state').textContent).toContain('Page Not Found');
    expect(screen.getByTestId('page-error-state').textContent).toContain(
      "Couldn't locate the requested Facebook Page."
    );
    expect(screen.queryByTestId('page-error-retry-btn')).toBeNull();
    expect(screen.getByTestId('page-error-return-btn')).not.toBeNull();
  });

  it('shows a server-error message with Retry for a 500, and Retry recovers', async () => {
    detailStatus = 500;
    listMode = 'without';
    installFetch();
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('page-error-state')).not.toBeNull();
    });
    expect(screen.getByTestId('page-error-state').textContent).toContain('Something Went Wrong');
    expect(screen.getByTestId('page-error-state').textContent).not.toContain('Page Not Found');
    const retry = screen.getByTestId('page-error-retry-btn');
    expect(retry).not.toBeNull();
    // Second detail attempt succeeds (detailAttempts > 1 in the stub).
    await userEvent.click(retry);
    await waitFor(() => {
      expect(screen.queryByTestId('page-error-state')).toBeNull();
    });
    expect(screen.getByTestId('dedicated-page-heading').textContent).toContain('Target Page');
  });

  it('shows an access message with Retry for a 403, not Page Not Found', async () => {
    detailStatus = 403;
    listMode = 'without';
    installFetch();
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('page-error-state')).not.toBeNull();
    });
    expect(screen.getByTestId('page-error-state').textContent).toContain('Access Denied');
    expect(screen.getByTestId('page-error-retry-btn')).not.toBeNull();
  });

  it('shows a session-expired message with Retry for a 401, not Page Not Found', async () => {
    detailStatus = 401;
    listMode = 'without';
    installFetch();
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('page-error-state')).not.toBeNull();
    });
    expect(screen.getByTestId('page-error-state').textContent).toContain('Session Expired');
    expect(screen.getByTestId('page-error-retry-btn')).not.toBeNull();
  });
});

describe('R20 fallback list walk', () => {
  it('finds a real page beyond page 1 instead of 404ing it', async () => {
    detailStatus = 404;
    listMode = 'beyond';
    installFetch();
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('dedicated-page-heading')).not.toBeNull();
    });
    expect(screen.getByTestId('dedicated-page-heading').textContent).toContain('Target Page');
    expect(screen.queryByTestId('page-error-state')).toBeNull();
    // The walk actually requested page 2 of the list.
    expect(fetchUrls.some((url) => url.includes('page=2'))).toBe(true);
  });
});

describe('K11 slots/queue gating for a not-found page', () => {
  it('does not fire slots or queue fetches for a proven not-found page', async () => {
    detailStatus = 404;
    listMode = 'without';
    installFetch();
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('page-error-state')).not.toBeNull();
    });
    expect(fetchUrls.some((url) => url.includes('/slots'))).toBe(false);
    expect(fetchUrls.some((url) => url.includes('/publishing/queue'))).toBe(false);
  });
});

describe('R27 active tab scrolled into view', () => {
  it('scrolls the deep-linked active trigger into view inline-nearest on mount', async () => {
    mockQuery = 'tab=calendar';
    const scrollMock = vi.fn();
    // jsdom does not implement scrollIntoView; read it through an
    // unknown-typed slot so the restore below typechecks.
    const proto = Element.prototype as unknown as {
      scrollIntoView?: unknown;
    };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollMock;
    try {
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <TenantDedicatedPageView
            subdomainProp="cyberdyne"
            pageIdProp={TARGET_ID}
            initialPage={samplePage}
          />
        </QueryClientProvider>
      );
      await waitFor(() => {
        expect(scrollMock).toHaveBeenCalled();
      });
      expect(scrollMock.mock.calls[0][0]).toEqual({
        block: 'nearest',
        inline: 'nearest',
      });
    } finally {
      if (original === undefined) {
        delete proto.scrollIntoView;
      } else {
        proto.scrollIntoView = original;
      }
    }
  });
});

describe('K11 header mutual guard + disconnect copy', () => {
  it('disables Disconnect while a status update runs (menu stays open)', async () => {
    const user = userEvent.setup();
    let resolveToggle!: (value: undefined) => void;
    const togglePromise = new Promise<undefined>((resolve) => {
      resolveToggle = resolve;
    });
    const { container } = render(
      <DedicatedPageHeader
        page={samplePage}
        subdomain="cyberdyne"
        onStatusToggle={vi.fn().mockImplementation(() => togglePromise)}
        onDisconnectRequest={vi.fn()}
      />
    );
    await user.click(
      container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
    );
    await user.click(
      document.querySelector('[data-testid="header-menu-pause-resume-btn"]') as Element
    );
    const disconnectItem = document.querySelector(
      '[data-testid="header-menu-disconnect-btn"]'
    );
    expect(disconnectItem).not.toBeNull();
    expect(disconnectItem?.getAttribute('data-disabled')).not.toBeNull();
    resolveToggle(undefined);
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="header-menu-pause-resume-btn"]')
      ).toBeNull();
    });
  });

  it('disconnect dialogue is honest about publishing posts, token, and account scope', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DedicatedPageHeader
        page={samplePage}
        subdomain="cyberdyne"
        onStatusToggle={vi.fn()}
        onDisconnectRequest={vi.fn()}
      />
    );
    await user.click(
      container.querySelector('[data-testid="header-settings-dropdown-btn"]') as Element
    );
    await user.click(
      document.querySelector('[data-testid="header-menu-disconnect-btn"]') as Element
    );
    const dialog = document.querySelector('[data-testid="header-disconnect-modal"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('not the Facebook account');
    expect(dialog?.textContent).toContain('posts already publishing are untouched');
    expect(dialog?.textContent).toContain('access token for this page is cleared');
    expect(dialog?.textContent).toContain('Queued posts are cancelled');
  });
});
