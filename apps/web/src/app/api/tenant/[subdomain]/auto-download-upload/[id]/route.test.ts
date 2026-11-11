/**
 * ADU reactivation guard — spec 164.
 *
 * Turning a setup back on while its Page is still in error used to sail
 * through the guard (`fb_verification_required` → `active` is a direct
 * activate), so intake immediately minted stuck jobs again. The guard
 * now reads the destination first and blocks activation while the Page
 * is blocked. These tests pin the matrix through `handlePatchAduConfig`
 * with a fake Supabase client, plus the predicate itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  aduContext: vi.fn(),
  loadAduConfigView: vi.fn(),
}));

vi.mock('@/lib/server/adu', () => ({
  aduContext: mocks.aduContext,
  loadAduConfigView: mocks.loadAduConfigView,
  releaseAduConfigUsage: vi.fn(),
}));
vi.mock('@/lib/server/tikwm', () => ({
  fetchTikwmUserPosts: vi.fn(async () => []),
  TikwmError: class TikwmError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

import { handlePatchAduConfig, isDestinationBlockedForAduReactivation } from './route';

const WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONFIG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Op = { kind: string; args: unknown[] };
type Row = Record<string, unknown>;

interface Call {
  table: string;
  ops: Op[];
}

/** Minimal chainable Supabase fake: records every terminal call. */
class FakeBuilder {
  ops: Op[] = [];
  constructor(
    private readonly table: string,
    private readonly handler: (table: string, ops: Op[]) => unknown,
    private readonly calls: Call[],
  ) {}

  select() {
    this.ops.push({ kind: 'select', args: [] });
    return this;
  }

  eq(col: string, val: unknown) {
    this.ops.push({ kind: 'eq', args: [col, val] });
    return this;
  }

  update(payload: unknown) {
    this.ops.push({ kind: 'update', args: [payload] });
    return this;
  }

  maybeSingle() {
    this.ops.push({ kind: 'maybeSingle', args: [] });
    return this;
  }

  then(resolve: (value: unknown) => void) {
    this.calls.push({ table: this.table, ops: [...this.ops] });
    resolve(this.handler(this.table, this.ops));
  }
}

function makeSupabase(configRow: Row, destRow: Row | null) {
  const calls: Call[] = [];
  const supabase = {
    calls,
    from: (table: string) =>
      new FakeBuilder(
        table,
        (t, ops) => {
          if (t === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
            return { data: configRow, error: null };
          }
          if (t === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
            return { data: destRow, error: null };
          }
          if (t === 'adu_configs' && ops.some((o) => o.kind === 'update')) {
            return { error: null };
          }
          return { data: null, error: null };
        },
        calls,
      ),
  };
  return supabase;
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/tenant/acme/auto-download-upload/x', {
    method: 'PATCH',
    headers: {
      cookie: 'fbu-session=test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function configRow(status: string): Row {
  return {
    status,
    destination_id: 'dest-1',
    source_platform: 'tiktok',
    source_username: 'someone',
  };
}

async function patchWith(configStatus: string, destRow: Row | null) {
  const supabase = makeSupabase(configRow(configStatus), destRow);
  mocks.aduContext.mockResolvedValue({
    context: { workspaceId: WORKSPACE_ID, supabase },
  });
  mocks.loadAduConfigView.mockResolvedValue({ id: CONFIG_ID, status: 'active' });
  const response = await handlePatchAduConfig(patchRequest({ status: 'active' }), 'acme', CONFIG_ID);
  const body = (await response.json()) as { error?: string; config?: unknown };
  return { response, body, supabase };
}

function configUpdated(supabase: { calls: Call[] }): boolean {
  return supabase.calls.some(
    (c) => c.table === 'adu_configs' && c.ops.some((o) => o.kind === 'update'),
  );
}

describe('isDestinationBlockedForAduReactivation', () => {
  it('blocks error destinations', () => {
    expect(isDestinationBlockedForAduReactivation('error', null)).toBe(true);
    expect(isDestinationBlockedForAduReactivation('error', 'checkpoint')).toBe(true);
  });

  it('blocks plain disconnected destinations', () => {
    expect(isDestinationBlockedForAduReactivation('disconnected', null)).toBe(true);
    expect(isDestinationBlockedForAduReactivation('disconnected', 'invalid_token')).toBe(true);
  });

  it('allows a Pages-paused destination (disconnected + paused marker)', () => {
    expect(isDestinationBlockedForAduReactivation('disconnected', 'paused')).toBe(false);
  });

  it('allows active and rate_limited destinations', () => {
    expect(isDestinationBlockedForAduReactivation('active', null)).toBe(false);
    expect(isDestinationBlockedForAduReactivation('rate_limited', null)).toBe(false);
  });
});

describe('handlePatchAduConfig reactivation guard — spec 164', () => {
  it('rejects toggle-ON while the destination is in error, config untouched', async () => {
    const { response, body, supabase } = await patchWith('fb_verification_required', {
      status: 'error',
      metadata: {},
    });
    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "This page can't post right now. Fix the issue in the Pages section first, then turn automation back on.",
    );
    expect(configUpdated(supabase)).toBe(false);
  });

  it('rejects toggle-ON while the destination is plain disconnected', async () => {
    const { response, body, supabase } = await patchWith('paused', {
      status: 'disconnected',
      metadata: {},
    });
    expect(response.status).toBe(400);
    expect(body.error).toBe('This page was removed. Add the page again to turn automation back on.');
    expect(configUpdated(supabase)).toBe(false);
  });

  it('allows toggle-ON for a Pages-paused destination', async () => {
    const { response, body, supabase } = await patchWith('paused', {
      status: 'disconnected',
      metadata: { fb_status: 'paused' },
    });
    expect(response.status).toBe(200);
    expect(body.config).toBeDefined();
    expect(configUpdated(supabase)).toBe(true);
  });

  it('allows toggle-ON once the destination is active again', async () => {
    const { response, body, supabase } = await patchWith('fb_verification_required', {
      status: 'active',
      metadata: {},
    });
    expect(response.status).toBe(200);
    expect(body.config).toBeDefined();
    expect(configUpdated(supabase)).toBe(true);
  });

  it('fails closed when the destination row is missing', async () => {
    const { response, body, supabase } = await patchWith('fb_verification_required', null);
    expect(response.status).toBe(400);
    expect(body.error).toBe('Could not find this page. Try again.');
    expect(configUpdated(supabase)).toBe(false);
  });
});
