/**
 * S3 — signup OTP verify mints the workspaceId claim (M2).
 *
 * A8: the token carries the claim for the workspace the signup RPC
 * just created (one extra select allowed); if that select is forced
 * to fail, signup still succeeds and the token is claimless
 * (coordinator Q4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getSessionSecret,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import {
  _setMockSupabaseAuthClient,
  _setMockSupabaseServiceClient,
  _resetMockSupabaseClients,
} from './clients';
import { verifySignupOtpViaSupabase } from './signup';

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

import { logServerError } from '@/lib/server-analytics';

const USER_ID = '11111111-1111-4111-a111-111111111111';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Row = Record<string, unknown>;

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];
  private columns = '';

  public constructor(
    private readonly rows: Row[],
    private readonly failSelects: Set<string>,
    public readonly selectCalls: Array<{ table: string; columns: string }>,
    private readonly table: string
  ) {}

  public select(columns: string): this {
    this.columns = columns;
    this.selectCalls.push({ table: this.table, columns });
    return this;
  }

  public eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  public or(): this {
    return this;
  }

  public order(): this {
    return this;
  }

  public limit(): this {
    return this;
  }

  public async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    if (this.failSelects.has(this.columns)) {
      throw new Error('forced DB error');
    }
    const match =
      this.rows.find((row) =>
        this.filters.every(([column, value]) => row[column] === value)
      ) ?? null;
    return { data: match, error: null };
  }
}

class FakeSupabase {
  public readonly selectCalls: Array<{ table: string; columns: string }> = [];

  public constructor(
    private readonly tables: Record<string, Row[]>,
    private readonly failSelects: Set<string> = new Set()
  ) {}

  public from(table: string): FakeQuery {
    return new FakeQuery(this.tables[table] ?? [], this.failSelects, this.selectCalls, table);
  }

  public auth = {
    verifyOtp: vi.fn(async () => ({
      data: {
        user: {
          id: USER_ID,
          email: 'client@gmail.com',
          user_metadata: { name: 'Acme Client', phone: null, subdomain: 'acme' },
        },
      },
      error: null,
    })),
  };

  public rpc = vi.fn(async () => ({ data: null, error: null }));
}

const USER_ROW: Row = {
  id: USER_ID,
  email: 'client@gmail.com',
  name: 'Acme Client',
  phone: null,
  role: 'user',
  status: 'active',
  password_updated_at: null,
};

describe('verifySignupOtpViaSupabase mints the workspaceId claim (S3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetMockSupabaseClients();
  });

  it('A8: OTP verify mints the claim for the workspace the RPC created', async () => {
    const fake = new FakeSupabase({
      users: [USER_ROW],
      workspaces: [{ id: WORKSPACE_A, subdomain: 'acme', owner_id: USER_ID }],
    });
    _setMockSupabaseServiceClient(fake as unknown as SupabaseClient);
    _setMockSupabaseAuthClient(fake as unknown as SupabaseClient);

    const { token, user } = await verifySignupOtpViaSupabase({
      email: 'client@gmail.com',
      otp: '123456',
    });
    expect(user.subdomain).toBe('acme');
    const decoded = await verifySessionToken(token, getSessionSecret());
    expect(decoded.workspaceId).toBe(WORKSPACE_A);
    expect(decoded.subdomain).toBe('acme');

    // Exactly one extra select for the claim (the `id` lookup).
    expect(
      fake.selectCalls.filter((c) => c.table === 'workspaces' && c.columns === 'id')
    ).toHaveLength(1);
  });

  it('A8/Q4: a failed workspace-id select still verifies signup, claimless', async () => {
    const fake = new FakeSupabase(
      {
        users: [USER_ROW],
        workspaces: [{ id: WORKSPACE_A, subdomain: 'acme', owner_id: USER_ID }],
      },
      new Set(['id'])
    );
    _setMockSupabaseServiceClient(fake as unknown as SupabaseClient);
    _setMockSupabaseAuthClient(fake as unknown as SupabaseClient);

    const { token } = await verifySignupOtpViaSupabase({
      email: 'client@gmail.com',
      otp: '123456',
    });
    const decoded = await verifySessionToken(token, getSessionSecret());
    expect(decoded.workspaceId).toBeUndefined();
    expect(decoded.subdomain).toBe('acme');
    expect(logServerError).toHaveBeenCalledWith(
      '[signup] workspace id for session claim not resolved',
      expect.anything(),
      expect.objectContaining({ source: 'signup' })
    );
  });
});
