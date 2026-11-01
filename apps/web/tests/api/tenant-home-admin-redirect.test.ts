/**
 * Tenant Home page-level admin guard (admin-landing change, shell
 * isolation: the admin section is now /admin/*).
 *
 * Middleware already redirects the tenant-host and apex Home forms
 * for admins; this page guard covers the app-host /tenant/<subdomain>
 * form, which middleware passes through. Behavioural contract, no
 * database: the session and the data load are mocked, the real
 * Next redirect() throws, and the test asserts on its digest.
 *
 * - Admin session: the page throws a NEXT_REDIRECT to the admin
 *   section (/admin/subscriptions) BEFORE loadHomeData runs.
 * - Non-admin session: no redirect; the page loads data and returns
 *   JSX (here the error kind, the cheapest renderable shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('tenant Home page admin guard', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetDisplayName.mockReset();
    mockGetDisplayName.mockResolvedValue('Acme Corp');
    mockLoadHomeData.mockReset();
    mockLoadHomeData.mockResolvedValue({ kind: 'error', message: 'boom' });
  });

  it('redirects an admin session to the admin section before any data load', async () => {
    mockGetSession.mockResolvedValue({ role: 'admin' });

    let thrown: unknown;
    try {
      await TenantIndexPage({ params: Promise.resolve({ subdomain: 'e2e' }) });
    } catch (error) {
      thrown = error;
    }

    // Next's redirect() throws a NEXT_REDIRECT error carrying the target.
    expect(thrown).toBeDefined();
    const digest = (thrown as { digest?: string }).digest ?? String(thrown);
    expect(digest).toContain('NEXT_REDIRECT');
    expect(digest).toContain('/admin/subscriptions');
    expect(mockLoadHomeData).not.toHaveBeenCalled();
  });

  it('does not redirect a non-admin session', async () => {
    mockGetSession.mockResolvedValue({ role: 'user' });

    const jsx = await TenantIndexPage({
      params: Promise.resolve({ subdomain: 'e2e' }),
    });

    expect(jsx).toBeDefined();
    expect(mockLoadHomeData).toHaveBeenCalledWith('e2e');
  });
});
