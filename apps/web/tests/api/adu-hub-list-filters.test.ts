/**
 * IG + Threads ADU hub list GET (status filter mapping, Builder B — B4).
 *
 * The filter labels the hub pages show must reach the database as the
 * new status values: `Paused` → `paused`, `Missing Page Access` →
 * `missing_page_access`, `Missing Permission` → `missing_permission`.
 * The retired `Inactive` label must map to no filter. Both IG and
 * Threads pass `p_status` (and their `p_platform` literal) to the
 * unified hub RPCs (F21), like Facebook.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getIgHubList } from '../../src/app/api/tenant/[subdomain]/instagram/auto-download-upload/route';
import { GET as getThreadsHubList } from '../../src/app/api/tenant/[subdomain]/threads/auto-download-upload/route';

vi.mock('@/lib/server/adu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/adu')>();
  return { ...actual, aduContext: vi.fn() };
});
vi.mock('@/lib/server/threads-adu', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/threads-adu')>();
  return { ...actual, threadsAduContext: vi.fn() };
});

import { aduContext } from '@/lib/server/adu';
import { threadsAduContext } from '@/lib/server/threads-adu';

const mockedAduContext = aduContext as unknown as ReturnType<typeof vi.fn>;
const mockedThreadsAduContext = threadsAduContext as unknown as ReturnType<typeof vi.fn>;

function params() {
  return { params: Promise.resolve({ subdomain: 'acme' }) };
}

describe('IG ADU hub list GET (status filter mapping)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getWithStatus(filter: string) {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    mockedAduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: { rpc } },
    });
    const res = await getIgHubList(
      new NextRequest(
        `http://localhost:3000/api/tenant/acme/instagram/auto-download-upload?status=${encodeURIComponent(filter)}`
      ),
      params()
    );
    expect(res.status).toBe(200);
    return rpc;
  }

  it.each([
    ['Paused', 'paused'],
    ['Missing Page Access', 'missing_page_access'],
    ['Missing Permission', 'missing_permission'],
    ['Active', 'active'],
  ])('maps ?status=%s to p_status=%s on both RPCs', async (filter, value) => {
    const rpc = await getWithStatus(filter);
    expect(rpc).toHaveBeenCalledWith(
      'adu_hub_list',
      expect.objectContaining({ p_status: value, p_platform: 'instagram' })
    );
    expect(rpc).toHaveBeenCalledWith(
      'adu_hub_stats',
      expect.objectContaining({ p_status: value, p_platform: 'instagram' })
    );
  });

  it('no longer maps the retired Inactive label — it behaves as no filter', async () => {
    const rpc = await getWithStatus('Inactive');
    expect(rpc).toHaveBeenCalledWith(
      'adu_hub_list',
      expect.objectContaining({ p_status: null, p_platform: 'instagram' })
    );
  });
});

describe('Threads ADU hub list GET (status filter mapping)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getWithStatus(filter: string) {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    mockedThreadsAduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: { rpc } },
    });
    const res = await getThreadsHubList(
      new NextRequest(
        `http://localhost:3000/api/tenant/acme/threads/auto-download-upload?status=${encodeURIComponent(filter)}`
      ),
      params()
    );
    expect(res.status).toBe(200);
    return rpc;
  }

  it.each([
    ['Paused', 'paused'],
    ['Missing Page Access', 'missing_page_access'],
    ['Missing Permission', 'missing_permission'],
    ['Active', 'active'],
  ])('maps ?status=%s to p_status=%s on both RPCs', async (filter, value) => {
    const rpc = await getWithStatus(filter);
    expect(rpc).toHaveBeenCalledWith(
      'adu_hub_list',
      expect.objectContaining({ p_status: value, p_platform: 'threads' })
    );
    expect(rpc).toHaveBeenCalledWith(
      'adu_hub_stats',
      expect.objectContaining({ p_status: value, p_platform: 'threads' })
    );
  });

  it('no longer maps the retired Inactive label — it behaves as no filter', async () => {
    const rpc = await getWithStatus('Inactive');
    expect(rpc).toHaveBeenCalledWith(
      'adu_hub_list',
      expect.objectContaining({ p_status: null, p_platform: 'threads' })
    );
  });
});
