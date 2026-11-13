/**
 * Facebook ADU options GET (F21 loader collapse).
 *
 * The route calls the shared paged loader with platform 'facebook'
 * and maps its `destinations` to the response's `pages` key — the
 * Facebook dialog reads `pages`, and the shared loader returns
 * `destinations` for all three platforms. The loader applies the
 * section='adu' filter, so the route no longer needs the old
 * loadAduOptionsLists copy in lib/server/adu (deleted by F21).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  aduContext: vi.fn(),
  loadLists: vi.fn(),
}));

vi.mock('@/lib/server/adu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/adu')>()),
  aduContext: mocks.aduContext,
}));
vi.mock('@/lib/adu-hub-helpers', () => ({
  loadAduOptionsListsForPlatform: mocks.loadLists,
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

import { GET } from './route';

function getRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function getParams() {
  return { params: Promise.resolve({ subdomain: 'ws1' }) };
}

const LISTS = {
  accounts: [
    { id: 'acc-1', display_name: 'One' },
    { id: 'acc-2', display_name: 'Two' },
  ],
  destinations: [
    { id: 'dest-adu', account_id: 'acc-1', section: 'adu', name: 'One' },
    { id: 'dest-2', account_id: 'acc-2', section: 'adu', name: 'Two' },
  ],
  configured: [{ destination_id: 'dest-adu', source_platform: 'tiktok', source_username: 'a' }],
  migrationMissing: false,
};

describe('FB ADU options GET (F21 loader collapse)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: {} },
    });
    mocks.loadLists.mockResolvedValue(LISTS);
  });

  it('calls the shared loader with facebook and maps destinations to pages', async () => {
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload/options'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mocks.loadLists).toHaveBeenCalledWith({}, 'ws-1', 'facebook');
    expect(body).toEqual({
      accounts: LISTS.accounts,
      pages: LISTS.destinations,
      configured: LISTS.configured,
      migrationMissing: false,
    });
  });

  it('returns the migrationMissing branch when the loader flags it', async () => {
    mocks.loadLists.mockResolvedValue({ ...LISTS, configured: [], migrationMissing: true });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload/options'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.migrationMissing).toBe(true);
    expect(body.pages).toHaveLength(2);
  });

  it('a loader failure is a loud 500 carrying the loader message', async () => {
    mocks.loadLists.mockRejectedValue(new Error('Could not load Facebook pages.'));
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload/options'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe('Could not load Facebook pages.');
  });
});
