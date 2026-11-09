/**
 * ADU hub list route: a missing RPC must surface as migrationMissing,
 * not as a bare 500.
 *
 * The aduRpcMissing helper alone does not prove the route wires it:
 * the old route checked only 42P01/42883, so a missing adu_hub_list
 * RPC (which PostgREST reports as PGRST202) fell through to
 * "Failed to load pages." with no migration banner. These tests call
 * GET with a mocked aduContext and assert the route-level response.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/tenant/[subdomain]/auto-download-upload/route';
import { aduContext } from '@/lib/server/adu';

vi.mock('@/lib/server/adu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/adu')>();
  return { ...actual, aduContext: vi.fn() };
});

const mockedAduContext = aduContext as unknown as ReturnType<typeof vi.fn>;

function request() {
  return new NextRequest('http://localhost:3000/api/tenant/acme/auto-download-upload');
}

function params() {
  return { params: Promise.resolve({ subdomain: 'acme' }) };
}

describe('ADU hub list GET (PGRST202 wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns migrationMissing when adu_hub_list is missing (PGRST202)', async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.adu_hub_list' },
      })),
    };
    mockedAduContext.mockResolvedValue({ context: { workspaceId: 'ws-1', supabase } });
    const res = await GET(request(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configs: [], total: 0, page: 1, migrationMissing: true });
  });

  it('still 500s on a non-missing RPC error', async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: '500', message: 'boom' },
      })),
    };
    mockedAduContext.mockResolvedValue({ context: { workspaceId: 'ws-1', supabase } });
    const res = await GET(request(), params());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load pages.' });
  });
});

describe('ADU hub list GET (status filter mapping)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getWithStatus(filter: string) {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    mockedAduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: { rpc } },
    });
    const res = await GET(
      new NextRequest(
        `http://localhost:3000/api/tenant/acme/auto-download-upload?status=${encodeURIComponent(filter)}`
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
    ['Completed', 'completed'],
  ])('maps ?status=%s to p_status=%s on both RPCs', async (filter, value) => {
    const rpc = await getWithStatus(filter);
    expect(rpc).toHaveBeenCalledWith('adu_hub_list', expect.objectContaining({ p_status: value }));
    expect(rpc).toHaveBeenCalledWith('adu_hub_stats', expect.objectContaining({ p_status: value }));
  });

  it('no longer maps the retired Inactive label — it behaves as no filter', async () => {
    const rpc = await getWithStatus('Inactive');
    expect(rpc).toHaveBeenCalledWith('adu_hub_list', expect.objectContaining({ p_status: null }));
    expect(rpc).toHaveBeenCalledWith('adu_hub_stats', expect.objectContaining({ p_status: null }));
  });
});
