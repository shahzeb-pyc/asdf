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
 * (spec 130 §5.5 / T34): the §4.2 welcome copy verbatim, the
 * display-name → subdomain-slug fallback, the Card-primitive/token
 * construction with zero inline styles, and the shared loading fallback
 * staying neutral (it must never mirror the home card, so no route
 * shows another page's skeleton). No assertion below replaces or weakens
 * the PR-130-1 suite above it.
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

import TenantLayout, { generateMetadata } from '../../src/app/tenant/[subdomain]/layout';
import TenantIndexPage, { metadata as homeMetadata } from '../../src/app/tenant/[subdomain]/page';
import TenantLoading from '../../src/app/tenant/[subdomain]/loading';
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

  it('renders tenant index page with workspace title and welcome message', async () => {
    const pageJsx = await TenantIndexPage({
      params: Promise.resolve({ subdomain: 'acme' }),
    });

    expect(pageJsx).toBeDefined();
    expect(React.isValidElement(pageJsx)).toBe(true);
    const elements = collectElements(pageJsx);
    const heading = elements.find((el) => el.type === 'h1');
    expect(heading?.props.children).toEqual(['Workspace: ', 'Acme Corp']);
  });
});

describe('Tenant workspace home — preservation rebuild (spec 130 §5.5, PR-130-3)', () => {
  beforeEach(() => {
    mockGetDisplayName.mockReset();
    mockGetDisplayName.mockResolvedValue('Acme Corp');
  });

  async function renderHome() {
    return TenantIndexPage({
      params: Promise.resolve({ subdomain: 'acme' }),
    });
  }

  it('renders the §4.2 welcome copy verbatim — heading and body, nothing added', async () => {
    const pageJsx = await renderHome();
    const elements = collectElements(pageJsx);

    // Exactly one heading on the home (logical heading order, §8.5).
    const headings = elements.filter((el) => el.type === 'h1');
    expect(headings).toHaveLength(1);

    // Body copy verbatim (§4.2): the welcome sentence, as its own paragraph.
    const body = elements.find((el) => el.type === 'p');
    expect(body?.props.children).toBe('Welcome to your FBUploadPro workspace.');

    // OD130-1 = A (preservation): no actions or extra sections ship —
    // the card contains no links or buttons at all.
    expect(elements.some((el) => el.type === 'a' || el.type === 'button')).toBe(false);

    // Rendered markup carries both verbatim strings.
    const html = renderToStaticMarkup(pageJsx).replaceAll('<!-- -->', '');
    expect(html).toContain('Workspace: Acme Corp');
    expect(html).toContain('Welcome to your FBUploadPro workspace.');
  });

  it('falls back to the subdomain slug when the display-name lookup returns null', async () => {
    mockGetDisplayName.mockResolvedValue(null);

    const pageJsx = await renderHome();
    const elements = collectElements(pageJsx);
    const heading = elements.find((el) => el.type === 'h1');
    // §4.1: the slug is the workspace's real identifier — the deliberate
    // name-lookup fallback, not fabricated identity data.
    expect(heading?.props.children).toEqual(['Workspace: ', 'acme']);
  });

  it('builds the welcome card on the shared/ui Card primitive with tokens and zero inline styles', async () => {
    const pageJsx = await renderHome();
    const elements = collectElements(pageJsx);

    const card = elements.find((el) => el.type === Card);
    expect(card).toBeDefined();
    expect(card?.props.className).toContain('gap-1');
    expect(card?.props.className).toContain('px-6');

    // Zero inline styles anywhere in the home tree (§8.1 ratchet duty).
    expect(elements.every((el) => el.props.style === undefined)).toBe(true);

    // The rendered card carries the primitive's token classes, and the
    // markup contains no style attribute at all.
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

    // The home page itself still ships its welcome Card unchanged.
    expect(pageElements.some((el) => el.type === Card)).toBe(true);

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
