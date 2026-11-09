/**
 * ADU PATCH transition guards (spec §3.3, Builder B — B1).
 *
 * The route reads the CURRENT status before a status change: `paused`
 * from anywhere; `active` only from the listed statuses, with the
 * fresh-token check on the Facebook route and the TikWM check for
 * TikTok-sourced creator_suspended configs; 400 + a plain message
 * otherwise. A source change reactivates a `completed` config.
 * The fake Supabase below applies updates/deletes to an in-memory
 * store, so every assertion is on the stored row — the real outcome —
 * not on a mocked return value.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  decryptToken,
  encryptToken,
  TikwmApiError,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handlePatchAduConfig } from '../../src/app/api/tenant/[subdomain]/auto-download-upload/[id]/route';
import { handlePatchIgAduConfig } from '../../src/app/api/tenant/[subdomain]/instagram/auto-download-upload/[id]/route';
import { handlePatchThreadsAduConfig } from '../../src/app/api/tenant/[subdomain]/threads/auto-download-upload/[id]/route';

vi.mock('@/lib/server/adu', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/adu')>();
  return { ...actual, aduContext: vi.fn(), loadAduConfigView: vi.fn() };
});
vi.mock('@/lib/server/threads-adu', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/threads-adu')>();
  return {
    ...actual,
    threadsAduContext: vi.fn(),
    loadThreadsAduConfigView: vi.fn(),
  };
});

import { aduContext, loadAduConfigView } from '@/lib/server/adu';
import {
  threadsAduContext,
  loadThreadsAduConfigView,
} from '@/lib/server/threads-adu';

const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WORKSPACE_ID = 'ws-1';

type Row = Record<string, unknown>;

type Filter =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'in'; col: string; val: unknown[] };

class FakeBuilder {
  filters: Filter[] = [];
  private mode: 'select' | 'update' | 'delete' = 'select';
  private updateValues: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly store: Record<string, Row[]>
  ) {}

  select() {
    this.mode = 'select';
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.filters.push({ op: 'in', col, val });
    return this;
  }

  update(values: Row) {
    this.mode = 'update';
    this.updateValues = values;
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  private matched(): Row[] {
    return (this.store[this.table] ?? []).filter((row) =>
      this.filters.every((f) =>
        f.op === 'eq'
          ? row[f.col] === f.val
          : (f.val as unknown[]).includes(row[f.col])
      )
    );
  }

  async maybeSingle() {
    const rows = this.matched();
    return { data: rows[0] ?? null, error: null };
  }

  // Thenable so `await builder` executes an update/delete.
  then(resolve: (value: { error: null }) => void) {
    if (this.mode === 'update') {
      for (const row of this.matched()) Object.assign(row, this.updateValues);
    } else if (this.mode === 'delete') {
      const rows = this.matched();
      const table = this.store[this.table] ?? [];
      for (const row of rows) {
        const idx = table.indexOf(row);
        if (idx >= 0) table.splice(idx, 1);
      }
    }
    resolve({ error: null });
  }
}

function fakeSupabase(store: Record<string, Row[]>): SupabaseClient {
  return {
    from: (table: string) => new FakeBuilder(table, store),
  } as unknown as SupabaseClient;
}

interface StoreSeed {
  status: string;
  sourcePlatform?: string;
  sourceUsername?: string;
  destinationPlatform?: string;
}

async function buildStore(seed: StoreSeed): Promise<Record<string, Row[]>> {
  const encryptedAccountToken = await encryptToken(
    'user-token-123',
    TEST_ENCRYPTION_KEY
  );
  return {
    adu_configs: [
      {
        id: 'cfg-1',
        workspace_id: WORKSPACE_ID,
        destination_id: 'dest-1',
        source_platform: seed.sourcePlatform ?? 'tiktok',
        source_username: seed.sourceUsername ?? 'creator1',
        status: seed.status,
        sync_status: 'synced',
        posts_per_day: 2,
        schedule_type: 'dailyrandom',
        posting_times: ['09:00', '15:00'],
      },
    ],
    adu_reels: [
      {
        id: 'reel-1',
        config_id: 'cfg-1',
        status: 'download_failed',
        download_retries: 3,
        download_claimed_at: '2026-11-07T10:00:00.000Z',
        download_failed_at: '2026-11-07T10:00:00.000Z',
      },
      {
        id: 'reel-2',
        config_id: 'cfg-1',
        status: 'download_failed',
        download_retries: 1,
        download_claimed_at: '2026-11-07T10:00:00.000Z',
        download_failed_at: '2026-11-07T10:00:00.000Z',
      },
      { id: 'reel-3', config_id: 'cfg-1', status: 'pending', download_retries: 0 },
    ],
    destinations: [
      {
        id: 'dest-1',
        workspace_id: WORKSPACE_ID,
        platform: seed.destinationPlatform ?? 'facebook',
        external_destination_id: 'fb-page-1',
        account_id: 'acc-1',
        encrypted_destination_token: 'old-enc-token',
      },
    ],
    social_accounts: [
      {
        id: 'acc-1',
        workspace_id: WORKSPACE_ID,
        encrypted_access_token: encryptedAccountToken,
      },
    ],
  };
}

function configStatus(store: Record<string, Row[]>): string {
  return String(store.adu_configs[0]?.status ?? '');
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/adu/cfg-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockViewFromStore(store: Record<string, Row[]>) {
  const view = async (
    _supabase: unknown,
    _workspaceId: string,
    id: string
  ) => ({
    id,
    status: configStatus(store),
  });
  vi.mocked(loadAduConfigView).mockImplementation(view as never);
  vi.mocked(loadThreadsAduConfigView).mockImplementation(view as never);
}

function mockContext(store: Record<string, Row[]>) {
  const context = {
    context: {
      workspaceId: WORKSPACE_ID,
      supabase: fakeSupabase(store),
      userId: 'user-1',
      role: 'user',
    },
  };
  vi.mocked(aduContext).mockResolvedValue(context as never);
  vi.mocked(threadsAduContext).mockResolvedValue(context as never);
}

describe('ADU PATCH guards — Facebook route', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    vi.restoreAllMocks();
  });

  it.each([
    'invalid_token',
    'fb_rate_limited',
    'completed',
    'fb_verification_required',
    'account_suspended',
    'check_developer_app',
    'missing_page_access',
    'creator_suspended',
  ])('pauses from %s', async (from) => {
    const store = await buildStore({ status: from });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'paused' }),
      'acme',
      'cfg-1',
      { fetchCreatorPosts: vi.fn() }
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('paused');
  });

  it.each([
    'paused',
    'fb_verification_required',
    'account_suspended',
    'check_developer_app',
  ])('activates directly from %s', async (from) => {
    const store = await buildStore({ status: from });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      { fetchCreatorPosts: vi.fn() }
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
  });

  it('rejects active from invalid_token with the reconnect message', async () => {
    const store = await buildStore({ status: 'invalid_token' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Reconnect your Facebook account to restore access.');
    expect(configStatus(store)).toBe('invalid_token');
  });

  it('rejects active from fb_rate_limited with the cooldown message', async () => {
    const store = await buildStore({ status: 'fb_rate_limited' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      'Posting resumes automatically in about 3 days. You don\'t need to do anything.'
    );
    expect(configStatus(store)).toBe('fb_rate_limited');
  });

  it('rejects active from completed with the source message', async () => {
    const store = await buildStore({ status: 'completed' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Update the source to continue posting.');
    expect(configStatus(store)).toBe('completed');
  });

  it('rejects a system-set target status', async () => {
    const store = await buildStore({ status: 'paused' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'invalid_token' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      'This status can\'t be changed here.'
    );
    expect(configStatus(store)).toBe('paused');
  });

  it('activates from missing_page_access when a fresh token arrives and writes it', async () => {
    const store = await buildStore({ status: 'missing_page_access' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      {
        fetchPageTokenMap: async () =>
          new Map([['fb-page-1', 'fresh-page-token']]),
      }
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    const stored = String(
      store.destinations[0]?.encrypted_destination_token ?? ''
    );
    expect(stored).not.toBe('old-enc-token');
    expect(await decryptToken(stored, TEST_ENCRYPTION_KEY)).toBe(
      'fresh-page-token'
    );
  });

  it('stays paused from missing_page_access when no fresh token arrives', async () => {
    const store = await buildStore({ status: 'missing_page_access' });
    mockContext(store);
    mockViewFromStore(store);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      { fetchPageTokenMap: async () => new Map() }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Posting stays paused');
    expect(configStatus(store)).toBe('missing_page_access');
    expect(store.destinations[0]?.encrypted_destination_token).toBe(
      'old-enc-token'
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('stays paused from page_not_accessible when the page list fetch fails', async () => {
    const store = await buildStore({ status: 'page_not_accessible' });
    mockContext(store);
    mockViewFromStore(store);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      {
        fetchPageTokenMap: async () => {
          throw new Error('Graph API is down');
        },
      }
    );
    expect(res.status).toBe(400);
    expect(configStatus(store)).toBe('page_not_accessible');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('activates from creator_suspended (TikTok, available) and fully resets failed reels to pending', async () => {
    const store = await buildStore({ status: 'creator_suspended' });
    mockContext(store);
    mockViewFromStore(store);
    const fetchCreatorPosts = vi.fn().mockResolvedValue([]);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      { fetchCreatorPosts }
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    expect(fetchCreatorPosts).toHaveBeenCalledWith('creator1');
    const failed = store.adu_reels.filter(
      (r) => r.status === 'download_failed'
    );
    expect(failed).toHaveLength(0);
    // Full reset: status pending AND download_retries 0 AND the claim /
    // failure stamps cleared. A status-only reset would strand these
    // reels in Pending forever — the claim RPCs only claim pending
    // reels with download_retries < 3, and every download_failed reel
    // sits at 3 retries.
    const reset = store.adu_reels.filter((r) => r.status === 'pending');
    expect(reset).toHaveLength(3);
    for (const id of ['reel-1', 'reel-2']) {
      const row = reset.find((r) => r.id === id);
      expect(row?.download_retries).toBe(0);
      expect(row?.download_claimed_at).toBeNull();
      expect(row?.download_failed_at).toBeNull();
      // Claimable again.
      expect(Number(row?.download_retries)).toBeLessThan(3);
    }
    // A reel that was already pending is untouched by the reset.
    const untouched = reset.find((r) => r.id === 'reel-3');
    expect(untouched?.download_retries).toBe(0);
    expect(untouched?.download_claimed_at).toBeUndefined();
    expect(untouched?.download_failed_at).toBeUndefined();
  });

  it('stays creator_suspended when TikWM says the feed is unavailable', async () => {
    const store = await buildStore({ status: 'creator_suspended' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      {
        fetchCreatorPosts: async () => {
          throw new TikwmApiError(
            'FEED_UNAVAILABLE',
            "Could not fetch that TikTok account's feed."
          );
        },
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('The creator still looks unavailable.');
    expect(configStatus(store)).toBe('creator_suspended');
    expect(
      store.adu_reels.filter((r) => r.status === 'download_failed')
    ).toHaveLength(2);
  });

  it('stays creator_suspended on an inconclusive check (rate limit) and logs loudly', async () => {
    const store = await buildStore({ status: 'creator_suspended' });
    mockContext(store);
    mockViewFromStore(store);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      {
        fetchCreatorPosts: async () => {
          throw new TikwmApiError('RATE_LIMITED', 'Rate limited.');
        },
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      'Could not verify the creator right now. Try again shortly.'
    );
    expect(configStatus(store)).toBe('creator_suspended');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('activates from creator_suspended directly for a non-TikTok source, no TikWM call', async () => {
    const store = await buildStore({
      status: 'creator_suspended',
      sourcePlatform: 'instagram',
      sourceUsername: 'creator_ig',
    });
    mockContext(store);
    mockViewFromStore(store);
    const fetchCreatorPosts = vi.fn();
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      { fetchCreatorPosts }
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    expect(fetchCreatorPosts).not.toHaveBeenCalled();
    expect(
      store.adu_reels.filter((r) => r.status === 'download_failed')
    ).toHaveLength(0);
    // The reset applies here too: retries 0, stamps cleared, claimable.
    for (const id of ['reel-1', 'reel-2']) {
      const row = store.adu_reels.find((r) => r.id === id);
      expect(row?.status).toBe('pending');
      expect(row?.download_retries).toBe(0);
      expect(row?.download_claimed_at).toBeNull();
      expect(row?.download_failed_at).toBeNull();
    }
  });

  it('reactivates a completed config on source change', async () => {
    const store = await buildStore({ status: 'completed' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ sourcePlatform: 'tiktok', sourceUsername: 'newcreator' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    expect(store.adu_configs[0]?.sync_status).toBe('pending');
    expect(store.adu_configs[0]?.source_username).toBe('newcreator');
  });

  it('keeps an active config active on source change', async () => {
    const store = await buildStore({ status: 'active' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ sourcePlatform: 'tiktok', sourceUsername: 'newcreator' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
  });

  it('404s for an unknown config id on a status change', async () => {
    const store = await buildStore({ status: 'paused' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-missing'
    );
    expect(res.status).toBe(404);
  });
});

describe('ADU PATCH guards — Instagram route', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    vi.restoreAllMocks();
  });

  it('rejects active from invalid_token with the Instagram reconnect message', async () => {
    const store = await buildStore({
      status: 'invalid_token',
      destinationPlatform: 'instagram',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchIgAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      'Reconnect your Instagram account to restore access.'
    );
    expect(configStatus(store)).toBe('invalid_token');
  });

  it('activates directly from missing_permission (no Facebook page token exists for an Instagram destination)', async () => {
    const store = await buildStore({
      status: 'missing_permission',
      destinationPlatform: 'instagram',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchIgAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
  });

  it('stays creator_suspended when the TikTok creator is unavailable', async () => {
    const store = await buildStore({
      status: 'creator_suspended',
      destinationPlatform: 'instagram',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchIgAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      {
        fetchCreatorPosts: async () => {
          throw new TikwmApiError('FEED_UNAVAILABLE', 'Feed gone.');
        },
      }
    );
    expect(res.status).toBe(400);
    expect(configStatus(store)).toBe('creator_suspended');
  });

  it('activates from creator_suspended for a non-TikTok source and fully resets failed reels', async () => {
    const store = await buildStore({
      status: 'creator_suspended',
      sourcePlatform: 'youtube',
      sourceUsername: 'creator_yt',
      destinationPlatform: 'instagram',
    });
    mockContext(store);
    mockViewFromStore(store);
    const fetchCreatorPosts = vi.fn();
    const res = await handlePatchIgAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      { fetchCreatorPosts }
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    expect(fetchCreatorPosts).not.toHaveBeenCalled();
    expect(
      store.adu_reels.filter((r) => r.status === 'download_failed')
    ).toHaveLength(0);
    // Full reset, same as the Facebook route: retries 0, stamps cleared,
    // claimable again (claim RPCs only claim download_retries < 3).
    for (const id of ['reel-1', 'reel-2']) {
      const row = store.adu_reels.find((r) => r.id === id);
      expect(row?.status).toBe('pending');
      expect(row?.download_retries).toBe(0);
      expect(row?.download_claimed_at).toBeNull();
      expect(row?.download_failed_at).toBeNull();
      expect(Number(row?.download_retries)).toBeLessThan(3);
    }
  });

  it('reactivates a completed config on source change', async () => {
    const store = await buildStore({
      status: 'completed',
      destinationPlatform: 'instagram',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchIgAduConfig(
      patchRequest({ sourcePlatform: 'tiktok', sourceUsername: 'newcreator' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
  });

  it('404s for a non-Instagram config', async () => {
    const store = await buildStore({
      status: 'paused',
      destinationPlatform: 'facebook',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchIgAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(404);
  });
});

describe('ADU PATCH guards — Threads route', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    vi.restoreAllMocks();
  });

  it('rejects active from invalid_token with the Threads reconnect message', async () => {
    const store = await buildStore({
      status: 'invalid_token',
      destinationPlatform: 'threads',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchThreadsAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      'Reconnect your Threads account to restore access.'
    );
    expect(configStatus(store)).toBe('invalid_token');
  });

  it('rejects active from fb_rate_limited', async () => {
    const store = await buildStore({
      status: 'fb_rate_limited',
      destinationPlatform: 'threads',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchThreadsAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    expect(configStatus(store)).toBe('fb_rate_limited');
  });

  it('activates from creator_suspended for a non-TikTok source and resets failed reels', async () => {
    const store = await buildStore({
      status: 'creator_suspended',
      sourcePlatform: 'youtube',
      sourceUsername: 'creator_yt',
      destinationPlatform: 'threads',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchThreadsAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1',
      { fetchCreatorPosts: vi.fn() }
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    expect(
      store.adu_reels.filter((r) => r.status === 'download_failed')
    ).toHaveLength(0);
    // Full reset, same as the Facebook route: retries 0, stamps cleared,
    // claimable again (claim RPCs only claim download_retries < 3).
    for (const id of ['reel-1', 'reel-2']) {
      const row = store.adu_reels.find((r) => r.id === id);
      expect(row?.status).toBe('pending');
      expect(row?.download_retries).toBe(0);
      expect(row?.download_claimed_at).toBeNull();
      expect(row?.download_failed_at).toBeNull();
      expect(Number(row?.download_retries)).toBeLessThan(3);
    }
  });

  it('reactivates a completed config on source change', async () => {
    const store = await buildStore({
      status: 'completed',
      destinationPlatform: 'threads',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchThreadsAduConfig(
      patchRequest({ sourcePlatform: 'tiktok', sourceUsername: 'newcreator' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
  });

  it('404s for a non-Threads config', async () => {
    const store = await buildStore({
      status: 'paused',
      destinationPlatform: 'facebook',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchThreadsAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(404);
  });
});
