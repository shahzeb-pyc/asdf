/**
 * @file dedicated-tabs.test.tsx
 * @description Dedicated page tab row: URL-synced tabs (?tab=), sticky
 * row, mobile scroll fade, and the gold active state (dedicated row
 * only — the shared `line` variant keeps its ink active state).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantDedicatedPageView from '@/app/tenant/[subdomain]/pages/[pageId]/page-section-shell';
import { tabsTriggerVariants } from '@/components/shared/ui/tabs';
import type { FacebookPageItem } from '@/components/pages/page-card';

const mockPush = vi.fn();
let mockQuery = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
  }),
  useParams: () => ({
    subdomain: 'cyberdyne',
    pageId: 'page-101',
  }),
  useSearchParams: () => ({
    get: (key: string) => new URLSearchParams(mockQuery).get(key),
    toString: () => mockQuery,
  }),
}));

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
  createdAt: '2026-10-01T00:00:00.000Z',
};

function renderShell(props: Record<string, unknown> = {}) {
  return rtlRender(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TenantDedicatedPageView
        subdomainProp="cyberdyne"
        pageIdProp="page-101"
        initialPage={samplePage}
        {...props}
      />
    </QueryClientProvider>
  );
}

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
  }
  return null;
}

function findElementByProp(
  node: React.ReactNode,
  propName: string
): React.ReactElement<Record<string, any>> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByProp(child, propName);
      if (found) return found;
    }
    return null;
  }
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, any>;
    if (props[propName] !== undefined) {
      return node as React.ReactElement<Record<string, any>>;
    }
    if (props.children) {
      const found = findElementByProp(props.children, propName);
      if (found) return found;
    }
  }
  return null;
}

describe('Dedicated tab row — URL tabs', () => {
  beforeEach(() => {
    mockQuery = '';
    mockPush.mockReset();
  });

  it('selects the tab from ?tab= on load', () => {
    mockQuery = 'tab=queue';
    renderShell();
    expect(screen.getByTestId('tab-queue-btn').getAttribute('data-state')).toBe('active');
    expect(screen.getByTestId('tab-dashboard-btn').getAttribute('data-state')).toBe('inactive');
  });

  it('maps the Posting Times tab id (calendar) from ?tab=', () => {
    mockQuery = 'tab=calendar';
    renderShell();
    expect(screen.getByTestId('tab-calendar-btn').getAttribute('data-state')).toBe('active');
  });

  it('falls back to Dashboard for an unknown ?tab= value', () => {
    mockQuery = 'tab=bogus';
    renderShell();
    expect(screen.getByTestId('tab-dashboard-btn').getAttribute('data-state')).toBe('active');
  });

  it('falls back to the initialTab prop when ?tab= is missing', () => {
    renderShell({ initialTab: 'insights' });
    expect(screen.getByTestId('tab-insights-btn').getAttribute('data-state')).toBe('active');
  });

  it('clicking a tab pushes (not replaces) a history entry with ?tab=', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByTestId('tab-queue-btn'));
    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = String(mockPush.mock.calls[0]?.[0] ?? '');
    expect(pushed).toContain('/tenant/cyberdyne/pages/page-101');
    expect(pushed).toContain('tab=queue');
    expect(mockPush.mock.calls[0]?.[1]).toEqual({ scroll: false });
  });

  it('internal dashboard switches update the URL the same way as tab clicks', () => {
    let tree: React.ReactElement | null = null;
    function CaptureWrapper() {
      tree = TenantDedicatedPageView({
        subdomainProp: 'cyberdyne',
        pageIdProp: 'page-101',
        initialPage: samplePage,
      }) as React.ReactElement;
      return tree;
    }
    rtlRender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CaptureWrapper />
      </QueryClientProvider>
    );
    const dashboard = findElementByProp(tree, 'onSwitchTab');
    expect(dashboard).not.toBeNull();
    (dashboard?.props as Record<string, any>).onSwitchTab('queue');
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(String(mockPush.mock.calls[0]?.[0] ?? '')).toContain('tab=queue');
  });

  it('adopting a new ?tab= (back/forward navigation) switches the tab', () => {
    mockQuery = 'tab=queue';
    const { rerender } = renderShell();
    expect(screen.getByTestId('tab-queue-btn').getAttribute('data-state')).toBe('active');
    // Simulate popstate: the URL changed without a click.
    mockQuery = 'tab=insights';
    rerender(
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
    expect(screen.getByTestId('tab-insights-btn').getAttribute('data-state')).toBe('active');
    // Adopting a URL change must not push a new entry of its own.
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('Dedicated tab row — sticky row, scroll fade, gold active state', () => {
  beforeEach(() => {
    mockQuery = '';
    mockPush.mockReset();
  });

  it('pins the tab row sticky at the viewport top with a solid background', () => {
    const { container } = renderShell();
    const nav = container.querySelector('[data-testid="dedicated-tabs-nav"]');
    expect(nav).not.toBeNull();
    const sticky = nav?.parentElement?.parentElement;
    expect(sticky?.className).toContain('sticky');
    expect(sticky?.className).toContain('top-0');
    expect(sticky?.className).toContain('z-sticky');
    expect(sticky?.className).toContain('bg-canvas');
  });

  it('shows scroll fades only at scrollable edges, never blocking taps', () => {
    const { container } = renderShell();
    const nav = container.querySelector('[data-testid="dedicated-tabs-nav"]');
    expect(nav).not.toBeNull();
    // At rest (no overflow in jsdom) there is no fade.
    expect(container.querySelector('[data-testid="dedicated-tabs-fade-right"]')).toBeNull();
    // Simulate a wide row: scrollable to the right, then scrolled.
    Object.defineProperty(nav, 'scrollWidth', { value: 800, configurable: true });
    Object.defineProperty(nav, 'clientWidth', { value: 360, configurable: true });
    Object.defineProperty(nav, 'scrollLeft', { value: 0, configurable: true });
    fireEvent.scroll(nav!);
    const rightFade = container.querySelector('[data-testid="dedicated-tabs-fade-right"]');
    expect(rightFade).not.toBeNull();
    expect(rightFade?.className).toContain('pointer-events-none');
    expect(container.querySelector('[data-testid="dedicated-tabs-fade-left"]')).toBeNull();
    Object.defineProperty(nav, 'scrollLeft', { value: 100, configurable: true });
    fireEvent.scroll(nav!);
    const leftFade = container.querySelector('[data-testid="dedicated-tabs-fade-left"]');
    expect(leftFade).not.toBeNull();
    expect(leftFade?.className).toContain('pointer-events-none');
    // Fades stop above the active tab's underline (bottom-1).
    expect(leftFade?.className).toContain('bottom-1');
    expect(rightFade?.className).toContain('bottom-1');
  });

  it('dedicated triggers use the gold variant; the shared line variant stays ink', () => {
    const { container } = renderShell();
    for (const id of ['dashboard', 'queue', 'calendar', 'insights', 'settings']) {
      const btn = container.querySelector(`[data-testid="tab-${id}-btn"]`);
      expect(btn?.getAttribute('data-variant')).toBe('line-gold');
    }
    const gold = tabsTriggerVariants({ variant: 'line-gold' });
    expect(gold).toContain('data-[state=active]:text-brand-gold');
    expect(gold).toContain('data-[state=active]:border-brand-gold');
    const line = tabsTriggerVariants({ variant: 'line' });
    // The base trigger class already carries a gold focus outline in
    // every variant — the line variant must not carry the gold
    // ACTIVE classes (those belong to line-gold only).
    expect(line).not.toContain('data-[state=active]:text-brand-gold');
    expect(line).not.toContain('data-[state=active]:border-brand-gold');
    expect(line).toContain('data-[state=active]:text-ink');
  });
});
