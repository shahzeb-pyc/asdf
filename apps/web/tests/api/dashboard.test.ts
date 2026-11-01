/**
 * Tenant shell contract tests (spec 130 PR-130-1, replacing the former
 * JSX-existence assertions per spec 137 §4.1 duty 8).
 *
 * - Null server session: the layout must resolve via redirect to login
 *   and must NEVER render a shell with fabricated identity data
 *   (spec 137 §4.4 — the fabricated-email fallback is deleted).
 * - Real session: the frame tree carries the session's real identity,
 *   the skip link, the content region, the header, the Banner slot and
 *   the Toaster mount.
 *
 * PR-130-3 extends the home-page coverage to rendered content
 * (spec 130 §5.5 / T34): the display-name → subdomain-slug fallback,
 * the Card-primitive/token construction with zero inline styles, and
 * the shared loading fallback staying neutral (it must never mirror
 * the home card, so no route shows another page's skeleton). The
 * 2026-11-01 home dashboard rebuild replaces the §4.2 welcome-card-only
 * contract with the paid/free/expired/admin sections (and the
 * no-queues-or-posts-data rule) asserted below. No assertion below
 * replaces or weakens the PR-130-1 suite above it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockGetSession = vi.fn();
vi.mock('@/lib/auth', () => ({
  getServerSessionContext: () => mockGetSession(),
}));

const mockGetDisplayName = vi.fn();
vi.mock('../../src/app/tenant/[subdomain]/workspace-display-name', () => ({
  getWorkspaceDisplayName: (...args: unknown[]) => mockGetDisplayName(...args),
}));

const mockLoadHomeData = vi.fn();
vi.mock('@/components/home/home-data', () => ({
  loadHomeData: (...args: unknown[]) => mockLoadHomeData(...args),
}));

const PAID_HOME = {
  kind: 'paid',
  periodEndsAt: new Date('2099-01-01T00:00:00.000Z'),
  units: 5,
  totalDestinations: 3,
  activeDestinations: 2,
  facebookAccounts: 1,
  accountsCount: 1,
  hasActiveSlot: true,
  firstFacebookPageId: 'page-1',
  attention: [
    {
      id: 'page-2',
      name: 'Paused Page',
      platform: 'facebook',
      status: 'paused',
      reason: 'Paused',
    },
  ],
  attentionTotal: 1,
  followersGained: 120,
  storageUsedBytes: 1073741824,
  storageQuotaBytes: 26843545600,
};

import TenantLayout, { generateMetadata } from '../../src/app/tenant/[subdomain]/layout';
import TenantIndexPage, { metadata as homeMetadata } from '../../src/app/tenant/[subdomain]/page';
import TenantLoading from '../../src/app/tenant/[subdomain]/loading';
import { HomeHero } from '@/components/home/home-sections';
import { WorkspaceSidebar } from '@/components/workspace/workspace-sidebar';
import { Toaster } from '@/components/shared/ui/toast';
import { Card } from '@/components/shared/ui/card';
import { Skeleton } from '@/components/shared/ui/skeleton';

const SESSION = {
  userId: 'user-1',
  email: 'owner@example.com',
  role: 'owner',
  subdomain: 'acme',
};

type AnyElement = React.ReactElement<Record<string, unknown>>;

function collectElements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (React.isValidElement(node)) {
    const el = node as AnyElement;
    out.push(el);
    collectElements(el.props.children, out);
  }
  return out;
}

async function renderLayout() {
  return TenantLayout({
    params: Promise.resolve({ subdomain: 'acme' }),
    children: React.createElement('div', { id: 'test-child' }, 'Workspace Content'),
  });
}

describe('Tenant Workspace Shell', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetDisplayName.mockReset();
    mockGetDisplayName.mockResolvedValue('Acme Corp');
    mockLoadHomeData.mockReset();
    mockLoadHomeData.mockResolvedValue(PAID_HOME);
  });

  it('redirects to login on a null session — never renders a fabricated user', async () => {
    mockGetSession.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await renderLayout();
    } catch (error) {
      thrown = error;
    }

    // Next's redirect() throws a NEXT_REDIRECT error carrying the target.
    expect(thrown).toBeDefined();
    const digest = (thrown as { digest?: string }).digest ?? String(thrown);
    expect(digest).toContain('NEXT_REDIRECT');
    expect(digest).toContain('/login?returnUrl=');
    expect(digest).toContain(encodeURIComponent('/tenant/acme'));
  });

  it('renders the frame with the real session identity and shell chrome', async () => {
    mockGetSession.mockResolvedValue(SESSION);

    const layoutJsx = await renderLayout();
    const elements = collectElements(layoutJsx);

    // The sidebar receives the REAL session identity — no invented address.
    const sidebar = elements.find((el) => el.type === WorkspaceSidebar);
    expect(sidebar).toBeDefined();
    const user = sidebar?.props.user as { name: string; email: string };
    expect(user.email).toBe('owner@example.com');
    expect(user.email).not.toContain('@fbuploadpro.com');
    expect(sidebar?.props.workspaceName).toBe('Acme Corp');

    // Skip link targets the content region and is the first link in the tree.
    const firstAnchor = elements.find((el) => el.type === 'a');
    expect(firstAnchor?.props.href).toBe('#tenant-content');
    expect(firstAnchor?.props.children).toBe('Skip to content');

    // Content region carries the skip-link target id and is focusable.
    const inset = elements.find((el) => el.props.id === 'tenant-content');
    expect(inset).toBeDefined();
    expect(inset?.props.tabIndex).toBe(-1);

    // Header with the workspace topbar contract is present.
    const header = elements.find((el) => el.props['data-testid'] === 'workspace-topbar');
    expect(header).toBeDefined();

    // Banner slot region sits in the frame.
    const bannerSlot = elements.find((el) => el.props.id === 'tenant-banner-slot');
    expect(bannerSlot).toBeDefined();

    // The one Toaster system is mounted in the frame.
    const toaster = elements.find((el) => el.type === Toaster);
    expect(toaster).toBeDefined();

    // Children render inside the frame.
    const child = elements.find((el) => el.props.id === 'test-child');
    expect(child).toBeDefined();
  });

  it('composes metadata through the workspace-name template', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ subdomain: 'acme' }),
    });
    expect(metadata.title).toEqual({
      template: '%s · Acme Corp',
      default: 'Acme Corp',
    });
  });

  it('renders tenant index page with workspace hero', async () => {
    const pageJsx = await TenantIndexPage({
      params: Promise.resolve({ subdomain: 'acme' }),
    });

    expect(pageJsx).toBeDefined();
    expect(React.isValidElement(pageJsx)).toBe(true);
    const html = renderToStaticMarkup(pageJsx).replaceAll('<!-- -->', '');
    expect(html).toContain('Welcome, Acme Corp');
  });
});

describe('Tenant workspace home — overview dashboard rebuild (2026-11-01)', () => {
  beforeEach(() => {
    mockGetDisplayName.mockReset();
    mockGetDisplayName.mockResolvedValue('Acme Corp');
    mockLoadHomeData.mockReset();
    mockLoadHomeData.mockResolvedValue(PAID_HOME);
  });

  async function renderHome() {
    return TenantIndexPage({
      params: Promise.resolve({ subdomain: 'acme' }),
    });
  }

  it('renders the paid dashboard — hero, plan banner, summary, attention, quick links, no queue or calendar links', async () => {
    const pageJsx = await renderHome();
    const html = renderToStaticMarkup(pageJsx).replaceAll('<!-- -->', '');

    // Exactly one h1 on the home (logical heading order, §8.5).
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toContain('Welcome, Acme Corp');

    // Paid sections render.
    expect(html).toContain('data-testid="plan-banner"');
    expect(html).toContain('data-testid="summary-cards"');
    expect(html).toContain('data-testid="needs-attention"');
    expect(html).toContain('data-testid="quick-links"');

    // Checklist hidden once complete (account + page + slot all done).
    expect(html).not.toContain('data-testid="setup-checklist"');

    // HARD CONSTRAINT: no queues or posts data anywhere on Home —
    // no Queue/Calendar links and no queue wording at all.
    expect(html).not.toContain('>Queue<');
    expect(html).not.toContain('>Calendar View<');
    expect(html).not.toContain('/queue');
  });

  it('shows the setup checklist while steps are incomplete, and the empty state at zero pages', async () => {
    mockLoadHomeData.mockResolvedValue({
      ...PAID_HOME,
      totalDestinations: 0,
      activeDestinations: 0,
      accountsCount: 0,
      hasActiveSlot: false,
      firstFacebookPageId: null,
      attention: [],
      attentionTotal: 0,
    });

    const html = renderToStaticMarkup(await renderHome()).replaceAll('<!-- -->', '');
    expect(html).toContain('data-testid="setup-checklist"');
    expect(html).toContain('data-testid="pages-empty-state"');
    expect(html).not.toContain('data-testid="summary-cards"');
    expect(html).not.toContain('data-testid="needs-attention"');
  });

  it('falls back to the subdomain slug when the display-name lookup returns null', async () => {
    mockGetDisplayName.mockResolvedValue(null);

    const html = renderToStaticMarkup(await renderHome()).replaceAll('<!-- -->', '');
    // §4.1: the slug is the workspace's real identifier — the deliberate
    // name-lookup fallback, not fabricated identity data.
    expect(html).toContain('Welcome, acme');
  });

  it('builds the home on the shared/ui Card primitive with tokens and zero inline styles', async () => {
    const pageJsx = await renderHome();

    // The rendered cards carry the primitive's token classes, and the
    // markup contains no style attribute at all (§8.1 ratchet duty).
    const html = renderToStaticMarkup(pageJsx);
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('bg-panel');
    expect(html).toContain('border-line');
    expect(html).not.toContain('style=');
  });

  it('exports the plain Home section title for the layout template', () => {
    expect(homeMetadata.title).toBe('Home');
  });

  it('shared tenant loading is neutral — never the home card, so no route shows another page\'s skeleton', async () => {
    const pageJsx = await renderHome();
    const pageElements = collectElements(pageJsx);
    const loadingJsx = TenantLoading();
    const loadingElements = collectElements(loadingJsx);
    const loadingOuter = loadingJsx as AnyElement;

    // The home page itself still ships its welcome hero.
    expect(pageElements.some((el) => el.type === HomeHero)).toBe(true);

    // The shared fallback must NOT render that Card (or any page's cards):
    // it previously mirrored the home card, so every route without its own
    // loading.tsx showed the home card on reload.
    expect(loadingElements.some((el) => el.type === Card)).toBe(false);
    expect(String(loadingOuter.props.className)).not.toContain('max-w-3xl');
    expect(loadingOuter.props['aria-busy']).toBe('true');

    // Still a skeleton composition (the boundaries contract).
    const skeletons = loadingElements.filter((el) => el.type === Skeleton);
    expect(skeletons.length).toBeGreaterThan(2);
  });
});
