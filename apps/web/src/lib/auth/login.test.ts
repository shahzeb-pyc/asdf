/**
 * S3 — login mints the workspaceId claim (M1).
 *
 * A6: a user login mints a token whose workspaceId is the primary
 * workspace's id, with no additional query beyond the existing
 * workspaces select (the select just gains the `id` column).
 * A9: admin and seller logins mint tokens with no claim.
 * A10: a failed workspace lookup at mint time still logs the user in
 * with a claimless token — never fail auth for the optimisation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getSessionSecret,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import {
  _setMockSupabaseServiceClient,
  _resetMockSupabaseClients,
} from './clients';
import { loginTenantUser } from './login';

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

import { logServerError } from '@/lib/server-analytics';

const USER_ID = '11111111-1111-4111-a111-111111111111';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = Record<string, unknown>;

interface SelectCall {
  table: string;
  columns: string;
}

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];
  private columns = '';

  public constructor(
    private readonly rows: Row[],
    private readonly calls: SelectCall[],
    private readonly table: string,
    private readonly failSelects?: Set<string>
  ) {}

  public select(columns: string): this {
    this.columns = columns;
    this.calls.push({ table: this.table, columns });
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

  public upsert(): this {
    return this;
  }

  private matched(): Row[] {
    return this.rows.filter((row) =>
      this.filters.every(([column, value]) => row[column] === value)
    );
  }

  public async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    if (this.failSelects?.has(this.columns)) {
      throw new Error('forced DB error');
    }
    return { data: this.matched()[0] ?? null, error: null };
  }

  public async single(): Promise<{ data: Row | null; error: unknown }> {
    return this.maybeSingle();
  }

  public then<TResult1 = { data: Row[] | null; error: unknown }>(
    onFulfilled?: ((value: { data: Row[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1> {
    if (this.failSelects?.has(this.columns)) {
      return Promise.reject(new Error('forced DB error')).then(onFulfilled, onRejected);
    }
    return Promise.resolve({ data: this.matched(), error: null }).then(onFulfilled, onRejected);
  }
}

class FakeSupabase {
  public readonly selectCalls: SelectCall[] = [];

  public constructor(
    private readonly tables: Record<string, Row[]>,
    private readonly failSelects?: Set<string>
  ) {}

  public from(table: string): FakeQuery {
    return new FakeQuery(this.tables[table] ?? [], this.selectCalls, table, this.failSelects);
  }

  public auth = {
    signInWithPassword: vi.fn(async () => ({
      data: { user: { id: USER_ID, email: 'client@gmail.com', user_metadata: {} } },
      error: null,
    })),
  };
}

function installFake(
  userRow: Row,
  workspaceRows: Row[],
  failSelects?: Set<string>
): FakeSupabase {
  const fake = new FakeSupabase(
    { users: [userRow], workspaces: workspaceRows },
    failSelects
  );
  _setMockSupabaseServiceClient(fake as unknown as SupabaseClient);
  return fake;
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

const WORKSPACE_ROWS: Row[] = [
  { id: WORKSPACE_A, subdomain: 'acme', owner_id: USER_ID },
  { id: WORKSPACE_B, subdomain: 'acme-two', owner_id: USER_ID },
];

describe('loginTenantUser mints the workspaceId claim (S3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetMockSupabaseClients();
  });

  it('A6: user login mints the primary workspace id with no extra query', async () => {
    const fake = installFake(USER_ROW, WORKSPACE_ROWS);
    const { token } = await loginTenantUser({
      email: 'client@gmail.com',
      password: 'correct-password',
    });
    const decoded = await verifySessionToken(token, getSessionSecret());
    expect(decoded.workspaceId).toBe(WORKSPACE_A);
    expect(decoded.subdomain).toBe('acme');
    expect(decoded.allowedSubdomains).toEqual(['acme', 'acme-two']);

    // The claim comes from the existing workspaces select (now
    // `id, subdomain`); no third workspaces query runs for the id.
    const workspaceSelects = fake.selectCalls.filter((c) => c.table === 'workspaces');
    expect(workspaceSelects).toHaveLength(2);
    expect(workspaceSelects.map((c) => c.columns).sort()).toEqual([
      'id, subdomain',
      'subdomain',
    ]);
  });

  it('A9: admin login mints a token with no workspaceId claim', async () => {
    const adminRow: Row = {
      ...USER_ROW,
      id: '33333333-3333-4333-a333-333333333333',
      email: 'administrator@gmail.com',
      role: 'admin',
    };
    installFake(adminRow, []);
    const { token } = await loginTenantUser({
      email: 'administrator@gmail.com',
      password: 'correct-password',
    });
    const decoded = await verifySessionToken(token, getSessionSecret());
    expect(decoded.workspaceId).toBeUndefined();
    expect(decoded.role).toBe('admin');
  });

  it('A9: seller login mints a token with no workspaceId claim', async () => {
    const sellerRow: Row = {
      ...USER_ROW,
      id: '22222222-2222-4222-a222-222222222222',
      email: 'seller@gmail.com',
      role: 'seller',
    };
    installFake(sellerRow, []);
    const { token } = await loginTenantUser({
      email: 'seller@gmail.com',
      password: 'correct-password',
    });
    const decoded = await verifySessionToken(token, getSessionSecret());
    expect(decoded.workspaceId).toBeUndefined();
    expect(decoded.role).toBe('seller');
  });

  it('A10: a failed workspace lookup still logs the user in, claimless', async () => {
    const fake = installFake(USER_ROW, WORKSPACE_ROWS, new Set(['id, subdomain']));
    const { token, user } = await loginTenantUser({
      email: 'client@gmail.com',
      password: 'correct-password',
    });
    expect(user.subdomain).toBe('acme');
    const decoded = await verifySessionToken(token, getSessionSecret());
    expect(decoded.workspaceId).toBeUndefined();
    expect(logServerError).toHaveBeenCalledWith(
      '[login] workspace id for session claim not resolved',
      expect.anything(),
      expect.objectContaining({ source: 'login' })
    );
    // The failing select was attempted exactly once — no retry loop.
    expect(fake.selectCalls.filter((c) => c.columns === 'id, subdomain')).toHaveLength(1);
  });
});
