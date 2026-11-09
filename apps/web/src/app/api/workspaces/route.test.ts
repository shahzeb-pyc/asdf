/**
 * S3 — workspace create mints the NEWLY INSERTED workspace's id
 * (M4, A7). Same dangerous-bug shape as the switch test: the old
 * token's claim must never be carried forward. An admin create mints
 * no claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getSessionSecret,
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import {
  _setMockSupabaseServiceClient,
  _resetMockSupabaseClients,
} from '@/lib/auth/clients';
import { POST } from './route';

type Row = Record<string, unknown>;

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];
  private insertedRow: Row | null = null;

  public constructor(private readonly rows: Row[]) {}

  public select(): this {
    return this;
  }

  public eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  public order(): this {
    return this;
  }

  public limit(): this {
    return this;
  }

  public insert(values: Row): this {
    this.insertedRow = {
      ...values,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return this;
  }

  private matched(): Row[] {
    return this.rows.filter((row) =>
      this.filters.every(([column, value]) => row[column] === value)
    );
  }

  public async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    return { data: this.matched()[0] ?? null, error: null };
  }

  public async single(): Promise<{ data: Row | null; error: unknown }> {
    if (this.insertedRow) {
      return { data: this.insertedRow, error: null };
    }
    return { data: this.matched()[0] ?? null, error: null };
  }

  public then<TResult1 = { data: Row[] | null; error: unknown }>(
    onFulfilled?: ((value: { data: Row[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1> {
    return Promise.resolve({ data: this.matched(), error: null }).then(onFulfilled, onRejected);
  }
}

class FakeSupabase {
  public constructor(private readonly tables: Record<string, Row[]>) {}

  public from(table: string): FakeQuery {
    return new FakeQuery(this.tables[table] ?? []);
  }
}

const USER_ID = '11111111-1111-4111-a111-111111111111';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const WORKSPACE_ROWS: Row[] = [
  { id: WORKSPACE_A, name: 'Acme', subdomain: 'acme', owner_id: USER_ID },
];

function createRequest(token: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/workspaces', {
    method: 'POST',
    headers: {
      cookie: `fbup_session=${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function tokenFromSetCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/fbup_session=([^;]+)/);
  if (!match?.[1]) throw new Error(`no fbup_session cookie in: ${setCookie}`);
  return match[1];
}

describe('POST /api/workspaces mints the new workspace id (S3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setMockSupabaseServiceClient(
      new FakeSupabase({ workspaces: WORKSPACE_ROWS }) as unknown as SupabaseClient
    );
  });

  afterEach(() => {
    _resetMockSupabaseClients();
  });

  it('A7: create mints the NEWLY INSERTED workspace id, not the old token claim', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldToken = await signSessionToken(
      {
        userId: USER_ID,
        email: 'client@gmail.com',
        name: 'Acme Client',
        subdomain: 'acme',
        workspaceId: WORKSPACE_A,
        allowedSubdomains: ['acme'],
        role: 'user',
        status: 'active',
        iat: now,
        exp: now + 86400,
      } satisfies SessionPayload,
      getSessionSecret()
    );

    const response = await POST(
      createRequest(oldToken, { name: 'Acme Three', subdomain: 'acme-three' })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspace?: { id?: string } };
    expect(body.workspace?.id).toBe(WORKSPACE_C);

    const decoded = await verifySessionToken(
      tokenFromSetCookie(response),
      getSessionSecret()
    );
    expect(decoded.subdomain).toBe('acme-three');
    expect(decoded.workspaceId).toBe(WORKSPACE_C);
    expect(decoded.workspaceId).not.toBe(WORKSPACE_A);
  });

  it('A7/A9: an admin create mints a token with no workspaceId claim', async () => {
    const now = Math.floor(Date.now() / 1000);
    const adminToken = await signSessionToken(
      {
        userId: '33333333-3333-4333-a333-333333333333',
        email: 'administrator@gmail.com',
        name: 'System Admin',
        subdomain: 'platform-admin',
        role: 'admin',
        status: 'active',
        iat: now,
        exp: now + 86400,
      } satisfies SessionPayload,
      getSessionSecret()
    );

    const response = await POST(
      createRequest(adminToken, { name: 'Admin Space', subdomain: 'admin-space' })
    );
    expect(response.status).toBe(200);
    const decoded = await verifySessionToken(
      tokenFromSetCookie(response),
      getSessionSecret()
    );
    expect(decoded.subdomain).toBe('admin-space');
    expect(decoded.workspaceId).toBeUndefined();
  });
});
