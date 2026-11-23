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

vi.mock('@/lib/server/adu', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/adu')>();
  return { ...actual, aduContext: vi.fn(), loadAduConfigView: vi.fn() };
});

import { aduContext, loadAduConfigView } from '@/lib/server/adu';

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
  /** Stored destination state (spec 236): the toggle flips the
   * destination together with the config. Defaults: active, no markers. */
  destinationStatus?: string;
  destinationMetadata?: Record<string, unknown>;
  /** Linked account state: 'expired' is stamped by a failed publish
   * and flipped back to 'active' by an ON (the worker gates require
   * an active account); 'revoked'/'error' still block the toggle. */
  accountStatus?: string;
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
        status: seed.destinationStatus ?? 'active',
        metadata: seed.destinationMetadata ?? {},
        encrypted_destination_token: 'old-enc-token',
      },
    ],
    social_accounts: [
      {
        id: 'acc-1',
        workspace_id: WORKSPACE_ID,
        status: seed.accountStatus ?? 'active',
        encrypted_access_token: encryptedAccountToken,
      },
    ],
  };
}

function configStatus(store: Record<string, Row[]>): string {
  return String(store.adu_configs[0]?.status ?? '');
}

function destinationStatus(store: Record<string, Row[]>): string {
  return String(store.destinations[0]?.status ?? '');
}

function destinationMetadata(store: Record<string, Row[]>): Record<string, unknown> {
  return (store.destinations[0]?.metadata ?? {}) as Record<string, unknown>;
}

function accountStatus(store: Record<string, Row[]>): string {
  return String(store.social_accounts[0]?.status ?? '');
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
}

describe('ADU PATCH toggle reactivates from any status — Facebook route (spec 236)', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    vi.restoreAllMocks();
  });

  /** Config status + the destination/account state a failed publish leaves behind. */
  const ON_CASES: Array<{
    from: string;
    destinationStatus: string;
    destinationMetadata: Record<string, unknown>;
    accountStatus: string;
    sourcePlatform?: string;
  }> = [
    {
      from: 'invalid_token',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'invalid_token' },
      accountStatus: 'expired',
    },
    {
      from: 'fb_rate_limited',
      destinationStatus: 'rate_limited',
      destinationMetadata: { rate_limited_at: '2026-11-20T00:00:00.000Z' },
      accountStatus: 'active',
    },
    {
      from: 'fb_verification_required',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'checkpoint' },
      accountStatus: 'active',
    },
    {
      from: 'account_suspended',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'account_suspended' },
      accountStatus: 'active',
    },
    {
      from: 'check_developer_app',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'check_developer_app' },
      accountStatus: 'active',
    },
    {
      from: 'page_not_accessible',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'page_not_accessible' },
      accountStatus: 'active',
    },
    {
      from: 'missing_page_access',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'missing_page_access' },
      accountStatus: 'active',
    },
    {
      from: 'missing_permission',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'missing_permission' },
      accountStatus: 'active',
    },
    {
      from: 'creator_suspended',
      destinationStatus: 'active',
      destinationMetadata: {},
      accountStatus: 'active',
    },
    {
      from: 'completed',
      destinationStatus: 'active',
      destinationMetadata: {},
      accountStatus: 'active',
    },
    {
      from: 'invalid_username',
      destinationStatus: 'active',
      destinationMetadata: {},
      accountStatus: 'active',
    },
    {
      from: '2fa_required_on_BM',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: '2fa_required_on_BM' },
      accountStatus: 'active',
    },
  ];

  it.each(ON_CASES)(
    'activates from $from and flips config AND destination together',
    async ({ from, destinationStatus: destStatus, destinationMetadata: destMetadata, accountStatus: accStatus }) => {
      const store = await buildStore({
        status: from,
        destinationStatus: destStatus,
        destinationMetadata: { ...destMetadata },
        accountStatus: accStatus,
      });
      mockContext(store);
      mockViewFromStore(store);
      const res = await handlePatchAduConfig(
        patchRequest({ status: 'active' }),
        'acme',
        'cfg-1'
      );
      expect(res.status).toBe(200);
      expect(configStatus(store)).toBe('active');
      // Immo bay gap: the destination flips with the config, so the
      // worker's destination gate admits the page again.
      expect(destinationStatus(store)).toBe('active');
      expect(destinationMetadata(store).fb_status).toBeUndefined();
      expect(destinationMetadata(store).rate_limited_at).toBeUndefined();
      expect(accountStatus(store)).toBe('active');
    }
  );

  it('activates from invalid_token without refreshing the page token (no probe on toggle)', async () => {
    const store = await buildStore({
      status: 'invalid_token',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'invalid_token' },
      accountStatus: 'expired',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    // The stored page token is left exactly as it was: the toggle
    // means "try again", and the next publish attempt proves the
    // token — a failed attempt re-stamps invalid_token.
    expect(store.destinations[0]?.encrypted_destination_token).toBe('old-enc-token');
    expect(accountStatus(store)).toBe('active');
  });

  it('activates from creator_suspended and fully resets failed reels, with no creator check', async () => {
    const store = await buildStore({ status: 'creator_suspended' });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('active');
    expect(
      store.adu_reels.filter((r) => r.status === 'download_failed')
    ).toHaveLength(0);
    // Full reset: status pending AND download_retries 0 AND the claim /
    // failure stamps cleared, so the reels are claimable again.
    const reset = store.adu_reels.filter((r) => r.status === 'pending');
    expect(reset).toHaveLength(3);
    for (const id of ['reel-1', 'reel-2']) {
      const row = reset.find((r) => r.id === id);
      expect(row?.download_retries).toBe(0);
      expect(row?.download_claimed_at).toBeNull();
      expect(row?.download_failed_at).toBeNull();
      expect(Number(row?.download_retries)).toBeLessThan(3);
    }
  });

  it.each([
    'invalid_token',
    'fb_rate_limited',
    'fb_verification_required',
    'account_suspended',
    'check_developer_app',
    'missing_page_access',
    'creator_suspended',
    'completed',
  ])('pauses from %s', async (from) => {
    const c = ON_CASES.find((x) => x.from === from)!;
    const store = await buildStore({
      status: from,
      destinationStatus: c.destinationStatus,
      destinationMetadata: { ...c.destinationMetadata },
      accountStatus: c.accountStatus,
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'paused' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(200);
    expect(configStatus(store)).toBe('paused');
    // OFF clears the destination error too: the card reads Paused
    // (the destination would otherwise override the badge), and
    // the worker skips the paused config. The account is untouched
    // on OFF.
    expect(destinationStatus(store)).toBe('active');
    expect(destinationMetadata(store).fb_status).toBeUndefined();
    expect(accountStatus(store)).toBe(c.accountStatus);
  });

  it('refuses ON when the linked account is revoked', async () => {
    const store = await buildStore({
      status: 'invalid_token',
      destinationStatus: 'error',
      destinationMetadata: { fb_status: 'invalid_token' },
      accountStatus: 'revoked',
    });
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
    expect(destinationStatus(store)).toBe('error');
  });

  it('refuses ON when the destination is disconnected', async () => {
    const store = await buildStore({
      status: 'paused',
      destinationStatus: 'disconnected',
      destinationMetadata: {},
      accountStatus: 'active',
    });
    mockContext(store);
    mockViewFromStore(store);
    const res = await handlePatchAduConfig(
      patchRequest({ status: 'active' }),
      'acme',
      'cfg-1'
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('This page was disconnected. Add it again first.');
    expect(configStatus(store)).toBe('paused');
    expect(destinationStatus(store)).toBe('disconnected');
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

