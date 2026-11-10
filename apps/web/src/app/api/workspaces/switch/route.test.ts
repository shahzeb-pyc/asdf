/**
 * S3 — workspace switch mints the NEW workspace's id (M3, A7).
 *
 * The single most dangerous bug in S3 is carrying the old token's
 * claim forward on switch/create: every subsequent call would
 * silently scope to the wrong workspace. These tests mint an old
 * token carrying workspace A's id, switch to B, and assert the new
 * token carries B's id — not A's. An admin switch mints no claim.
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
  private columns = '';

  public constructor(private readonly rows: Row[]) {}

  public select(columns: string): this {
    this.columns = columns;
    return this;
  }

  public eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
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
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const WORKSPACE_ROWS: Row[] = [
  { id: WORKSPACE_A, name: 'Acme', subdomain: 'acme', owner_id: USER_ID },
  { id: WORKSPACE_B, name: 'Acme Two', subdomain: 'acme-two', owner_id: USER_ID },
];

async function mintOldToken(session: SessionPayload): Promise<string> {
  return signSessionToken(session, getSessionSecret());
}

function switchRequest(token: string, subdomain: string): NextRequest {
  return new NextRequest('http://localhost/api/workspaces/switch', {
    method: 'POST',
    headers: {
      cookie: `fbup_session=${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ subdomain }),
  });
}

function tokenFromSetCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/fbup_session=([^;]+)/);
  if (!match?.[1]) throw new Error(`no fbup_session cookie in: ${setCookie}`);
  return match[1];
}

describe('POST /api/workspaces/switch mints the target workspace id (S3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setMockSupabaseServiceClient(
      new FakeSupabase({ workspaces: WORKSPACE_ROWS }) as unknown as SupabaseClient
    );
  });

  afterEach(() => {
    _resetMockSupabaseClients();
  });

  it('A7: switch mints the TARGET workspace id, not the old token claim', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldToken = await mintOldToken({
      userId: USER_ID,
      email: 'client@gmail.com',
      name: 'Acme Client',
      subdomain: 'acme',
      workspaceId: WORKSPACE_A,
      allowedSubdomains: ['acme', 'acme-two'],
      role: 'user',
      status: 'active',
      iat: now,
      exp: now + 86400,
    });

    const response = await POST(switchRequest(oldToken, 'acme-two'));
    expect(response.status).toBe(200);

    const decoded = await verifySessionToken(
      tokenFromSetCookie(response),
      getSessionSecret()
    );
    expect(decoded.subdomain).toBe('acme-two');
    // Mutation-test the dangerous bug: the new claim must be B, never A.
    expect(decoded.workspaceId).toBe(WORKSPACE_B);
    expect(decoded.workspaceId).not.toBe(WORKSPACE_A);
  });

  it('A7/A9: an admin switch mints a token with no workspaceId claim', async () => {
    const now = Math.floor(Date.now() / 1000);
    const adminToken = await mintOldToken({
      userId: '33333333-3333-4333-a333-333333333333',
      email: 'administrator@gmail.com',
      name: 'System Admin',
      subdomain: 'platform-admin',
      role: 'admin',
      status: 'active',
      iat: now,
      exp: now + 86400,
    });

    const response = await POST(switchRequest(adminToken, 'acme'));
    expect(response.status).toBe(200);
    const decoded = await verifySessionToken(
      tokenFromSetCookie(response),
      getSessionSecret()
    );
    expect(decoded.subdomain).toBe('acme');
    expect(decoded.workspaceId).toBeUndefined();
  });

  it('switching to a workspace the user does not own still 403s', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldToken = await mintOldToken({
      userId: USER_ID,
      email: 'client@gmail.com',
      name: 'Acme Client',
      subdomain: 'acme',
      workspaceId: WORKSPACE_A,
      role: 'user',
      status: 'active',
      iat: now,
      exp: now + 86400,
    });

    const response = await POST(switchRequest(oldToken, 'other'));
    expect(response.status).toBe(403);
  });
});
