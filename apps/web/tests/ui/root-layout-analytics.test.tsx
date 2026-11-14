/**
 * @file root-layout-analytics.test.tsx
 * @description UI & integration tests for RootLayout Vercel Analytics integration (Spec 067).
 *
 * Spec 191: RootLayout is an async server component (it awaits the
 * request brand from headers()), so the legacy sync render helper
 * (renderToStaticMarkup) cannot render it — these tests stream it
 * with renderToReadableStream instead, and call generateMetadata()
 * directly. The metadata assertions now cover both brands.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToReadableStream } from 'react-dom/server';
import RootLayout, { generateMetadata } from '@/app/layout';

// Mock @vercel/analytics/next to verify component invocation in RootLayout
vi.mock('@vercel/analytics/next', () => ({
  Analytics: (props: Record<string, unknown>) => (
    <div data-testid="vercel-analytics" data-props={JSON.stringify(props)} />
  ),
}));

// Mock next/navigation: the PostHog provider tracks pageviews via
// usePathname/useSearchParams, which throw outside a mounted App
// Router. The provider renders null in static markup either way.
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/font/google: it is a Next.js build-time loader, not runnable in jsdom,
// so importing the root layout would otherwise crash with "Manrope is not a function".
// The real Manrope loading is still asserted by tests/fonts.test.ts (source check on layout).
vi.mock('next/font/google', () => ({
  Manrope: () => ({ variable: '--font-manrope', className: 'mock-manrope' }),
}));

// Mock next/headers: the layout resolves the brand from the request
// host. The host is controllable per test via requestHost.current.
const requestHost = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers(requestHost.current ? { host: requestHost.current } : {}),
}));

async function renderLayout(children: React.ReactNode): Promise<string> {
  const stream = await renderToReadableStream(<RootLayout>{children}</RootLayout>);
  const reader = stream.getReader();
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += new TextDecoder().decode(value);
  }
  return html;
}

describe('RootLayout Vercel Analytics Integration (Spec 067)', () => {
  beforeEach(() => {
    requestHost.current = null;
  });

  it('exposes publishing automation platform metadata', async () => {
    const metadata = await generateMetadata();
    expect(metadata.title).toBe('FBUploadPro');
    expect(metadata.description).toBe('publishing automation platform');
  });

  it('exposes the NextRise metadata on the white-label host (spec 191)', async () => {
    requestHost.current = 'app.nextrisehq.com';
    const metadata = await generateMetadata();
    expect(metadata.title).toBe('NextRise Digital');
    expect(metadata.description).toBe('publishing automation platform');
  });

  it('renders children within the document main container', async () => {
    const html = await renderLayout(
      <div data-testid="test-content">Dashboard Content</div>
    );

    expect(html).toContain('<main');
    expect(html).toContain('Dashboard Content');
  });

  it('mounts the Vercel Analytics component within the body tree', async () => {
    const html = await renderLayout(<div>Test Page</div>);

    expect(html).toContain('data-testid="vercel-analytics"');
  });
});
