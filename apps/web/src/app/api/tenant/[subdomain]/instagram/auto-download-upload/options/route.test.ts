/**
 * Instagram ADU options GET (Stream D, F23).
 *
 * The route calls the shared paged loader with platform 'instagram'
 * and shapes its result: one picker entry per account (the adu copy
 * wins the dedupe), configuredAccountIds mapped through the loaded
 * destinations, and the migrationMissing branch.
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
    { id: 'dest-sched', account_id: 'acc-1', section: 'schedule', name: 'One' },
    { id: 'dest-2', account_id: 'acc-2', section: null, name: 'Two' },
  ],
  configured: [{ destination_id: 'dest-adu', source_platform: 'instagram', source_username: 'a' }],
  migrationMissing: false,
};

describe('IG ADU options GET (stream D F23)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: {} },
    });
    mocks.loadLists.mockResolvedValue(LISTS);
  });

  it('calls the shared loader with instagram and dedupes by account', async () => {
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload/options'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mocks.loadLists).toHaveBeenCalledWith({}, 'ws-1', 'instagram');
    // One entry per account; the adu copy wins over the schedule row.
    expect(body.destinations).toHaveLength(2);
    expect(body.destinations.map((d: { id: string }) => d.id)).toEqual(['dest-adu', 'dest-2']);
    expect(body.pages).toEqual(body.destinations);
    expect(body.configuredAccountIds).toEqual(['acc-1']);
    expect(body.configured).toHaveLength(1);
  });

  it('returns the migrationMissing branch when the loader flags it', async () => {
    mocks.loadLists.mockResolvedValue({ ...LISTS, configured: [], migrationMissing: true });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload/options'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.migrationMissing).toBe(true);
    expect(body.configuredAccountIds).toEqual([]);
  });

  it('a loader failure is a loud 500, never an empty picker', async () => {
    mocks.loadLists.mockRejectedValue(new Error('boom'));
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload/options'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe('Could not load Instagram accounts.');
  });
});
