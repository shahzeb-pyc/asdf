/**
 * Tenant Home — clean-path quick links per brand (spec 205, finding 3).
 *
 * The page computed its root from NEXT_PUBLIC_ROOT_DOMAIN, so on a
 * white-label host `shouldUseCleanTenantPaths` returned false and
 * Home's quick links rendered prefixed `/tenant/<sub>/...` paths
 * while the sidebar (layout, brand-aware) used clean paths. The page
 * now mirrors the layout's brand-aware root computation.
 *
 * Rendered through the same harness as tests/api/dashboard.test.ts:
 * the page is called directly with mocked session, display name and
 * home data, and the request host comes from a mocked next/headers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const hostState = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(new Headers(hostState.current ? { host: hostState.current } : {})),
}));

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

import TenantIndexPage from '../../src/app/tenant/[subdomain]/page';

const GB = 1073741824;

const PAID_HOME = {
  kind: 'paid',
  periodStartsAt: new Date('2026-11-02T00:00:00.000Z'),
  periodEndsAt: new Date('2026-12-02T00:00:00.000Z'),
  units: 21,
  platformCounts: {
    facebook: 12,
    instagram: 4,
    threads: 3,
    x: 0,
    tiktok: 1,
    youtube: 1,
  },
  storageUsedBytes: 0,
  storageQuotaBytes: 105 * GB,
};

const SESSION = {
  userId: 'user-1',
  email: 'owner@example.com',
  role: 'owner',
  subdomain: 'sajidali',
};

describe('Tenant Home quick links — clean paths per brand (spec 205)', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(SESSION);
    mockGetDisplayName.mockReset();
    mockGetDisplayName.mockResolvedValue('Sajid Ali');
    mockLoadHomeData.mockReset();
    mockLoadHomeData.mockResolvedValue(PAID_HOME);
    hostState.current = null;
  });

  async function renderHomeHtml() {
    const pageJsx = await TenantIndexPage({
      params: Promise.resolve({ subdomain: 'sajidali' }),
    });
    return renderToStaticMarkup(pageJsx).replaceAll('<!-- -->', '');
  }

  it('uses clean paths on the white-label tenant host', async () => {
    hostState.current = 'sajidali.sajidaliai.online';

    const html = await renderHomeHtml();

    expect(html).toContain('href="/inapp-schedule"');
    expect(html).toContain('href="/accounts"');
    expect(html).not.toContain('href="/tenant/sajidali/inapp-schedule"');
    expect(html).not.toContain('href="/tenant/sajidali/accounts"');
  });

  it('uses clean paths on the fbuploadpro tenant host (unchanged)', async () => {
    hostState.current = 'sajidali.fbuploadpro.com';

    const html = await renderHomeHtml();

    expect(html).toContain('href="/inapp-schedule"');
    expect(html).not.toContain('href="/tenant/sajidali/inapp-schedule"');
  });

  it('keeps prefixed paths on the app host (no own tenant host)', async () => {
    hostState.current = 'app.fbuploadpro.com';

    const html = await renderHomeHtml();

    expect(html).toContain('href="/tenant/sajidali/inapp-schedule"');
    expect(html).not.toContain('href="/inapp-schedule"');
  });
});
