/**
 * Muse agent auth — behavioural tests for resolveTenantSession.
 *
 * Covers the Sonar-flagged Bearer parse (now whitespace-split, no
 * regex) and every branch of agent session resolution: cookie
 * precedence, unknown/expired keys, inactive or wrong-role users,
 * workspace gating, admin bypass, query errors, telemetry failure,
 * and the unavailable-database path. A key is never logged here;
 * only key ids (never key values) appear in assertions.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  generateAgentKey,
  hashAgentKey,
  resolveTenantSession,
} from '../../src/lib/agent-auth';
import { _resetMockSupabaseClients } from '../../src/lib/auth/clients';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-123456';
const SUBDOMAIN = 'creatorstack';
const USER_ID = '11111111-1111-4111-a111-111111111111';
const OTHER_ID = '22222222-2222-4222-a222-222222222222';
const ADMIN_ID = '33333333-3333-4333-a333-333333333333';

type Row = Record<string, unknown>;

interface Store {
  agent_keys: Row[];
  users: Row[];
  workspaces: Row[];
  errors: Partial<Record<'agent_keys' | 'users' | 'workspaces', boolean>>;
  failUpdate: boolean;
}

function createFakeSupabase(store: Store) {
  function builder(table: keyof Pick<Store, 'agent_keys' | 'users' | 'workspaces'>) {
    const state = {
      mode: 'select' as 'select' | 'update',
      patch: null as Row | null,
      filters: [] as Array<[string, unknown]>,
    };
    const api: Record<string, unknown> = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        state.filters.push([col, val]);
        return api;
      },
      update(patch: Row) {
        state.mode = 'update';
        state.patch = patch;
        return api;
      },
      maybeSingle() {
        const filtered = store[table].filter((row) =>
          state.filters.every(([col, val]) => row[col] === val)
        );
        if (store.errors[table]) {
          return Promise.resolve({ data: null, error: { code: 'DBERR' } });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        try {
          if (state.mode === 'update') {
            if (store.failUpdate) throw new Error('update failed');
            for (const row of store[table]) {
              if (state.filters.every(([col, val]) => row[col] === val)) {
                Object.assign(row, state.patch);
              }
            }
            resolve({ error: null });
            return;
          }
          const filtered = store[table].filter((row) =>
            state.filters.every(([col, val]) => row[col] === val)
          );
          resolve({ data: filtered, error: null });
        } catch (err) {
          reject(err);
        }
      },
    };
    return api;
  }
  return {
    from(table: 'agent_keys' | 'users' | 'workspaces') {
      return builder(table);
    },
  } as never;
}

function newStore(): Store {
  return { agent_keys: [], users: [], workspaces: [], errors: {}, failUpdate: false };
}

function seedUser(store: Store, overrides: Partial<Row> = {}): string {
  const id = (overrides.id as string | undefined) ?? USER_ID;
  store.users.push({
    id,
    email: `${id.slice(0, 8)}@example.com`,
    role: 'user',
    status: 'active',
    ...overrides,
  });
  return id;
}

function seedWorkspace(store: Store, ownerId: string, subdomain = SUBDOMAIN) {
  store.workspaces.push({ id: 'ws-1', owner_id: ownerId, subdomain });
}

function seedKey(store: Store, userId: string, overrides: Partial<Row> = {}): string {
  const key = generateAgentKey();
  store.agent_keys.push({
    id: '44444444-4444-4444-8444-444444444444',
    user_id: userId,
    key_hash: hashAgentKey(key),
    expires_at: null,
    last_used_at: null,
    ...overrides,
  });
  return key;
}

function bearerRequest(authorization: string | null, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.Authorization = authorization;
  if (cookie) headers.Cookie = `fbup_session=${cookie}`;
  return new NextRequest('http://localhost:3000/api/tenant/creatorstack/media', {
    method: 'GET',
    headers,
  });
}

async function cookieToken(overrides: Record<string, unknown> = {}): Promise<string> {
  process.env.SESSION_SECRET = TEST_SECRET;
  return signSessionToken(
    {
      userId: USER_ID,
      email: 'testuser@gmail.com',
      subdomain: SUBDOMAIN,
      allowedSubdomains: [SUBDOMAIN],
      role: 'user',
      status: 'active',
      ...overrides,
    } as never,
    TEST_SECRET
  );
}

async function statusOf(
  result: Awaited<ReturnType<typeof resolveTenantSession>>
): Promise<number | string> {
  if ('errorResponse' in result) return result.errorResponse.status;
  return `ok:${result.session.userId}:${result.agentKeyId ?? 'cookie'}`;
}

describe('parseBearerKey through resolveTenantSession', () => {
  let store: Store;
  let db: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    store = newStore();
    db = createFakeSupabase(store);
    seedUser(store);
    seedWorkspace(store, USER_ID);
  });

  afterEach(() => {
    _resetMockSupabaseClients();
    vi.restoreAllMocks();
  });

  it('rejects a missing header', async () => {
    const res = await resolveTenantSession(bearerRequest(null), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('rejects a non-Bearer scheme', async () => {
    const res = await resolveTenantSession(bearerRequest('Basic abc123'), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('rejects Bearer with no token', async () => {
    const res = await resolveTenantSession(bearerRequest('Bearer'), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('rejects Bearer with an invalid key format', async () => {
    const res = await resolveTenantSession(bearerRequest('Bearer fbu_short'), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('rejects Bearer with extra tokens after the key', async () => {
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(
      bearerRequest(`Bearer ${key} extra`),
      SUBDOMAIN,
      { allowAgentKey: true, dbClient: db }
    );
    expect(await statusOf(res)).toBe(401);
  });

  it('accepts a lowercase bearer scheme', async () => {
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(bearerRequest(`bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(`ok:${USER_ID}:44444444-4444-4444-8444-444444444444`);
  });

  it('accepts extra whitespace and tabs around the scheme and key', async () => {
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(
      bearerRequest(`  Bearer\t${key}   `),
      SUBDOMAIN,
      { allowAgentKey: true, dbClient: db }
    );
    expect(await statusOf(res)).toBe(`ok:${USER_ID}:44444444-4444-4444-8444-444444444444`);
  });

  it('rejects an unknown key', async () => {
    const res = await resolveTenantSession(
      bearerRequest(`Bearer ${generateAgentKey()}`),
      SUBDOMAIN,
      { allowAgentKey: true, dbClient: db }
    );
    expect(await statusOf(res)).toBe(401);
  });

  it('rejects an expired key', async () => {
    const key = seedKey(store, USER_ID, { expires_at: '2020-01-01T00:00:00.000Z' });
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('accepts a key with a future expiry', async () => {
    const key = seedKey(store, USER_ID, { expires_at: '2099-01-01T00:00:00.000Z' });
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(`ok:${USER_ID}:44444444-4444-4444-8444-444444444444`);
  });

  it('rejects a key whose user is inactive', async () => {
    store.users[0].status = 'suspended';
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('rejects a key whose user is missing', async () => {
    store.users.length = 0;
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('forbids a key whose user role is neither user nor admin', async () => {
    store.users[0].role = 'guest';
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(403);
  });

  it('forbids a key for a workspace the user does not own', async () => {
    seedUser(store, { id: OTHER_ID });
    const key = seedKey(store, OTHER_ID);
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(403);
  });

  it('lets an admin key through without a workspace row', async () => {
    seedUser(store, { id: ADMIN_ID, role: 'admin' });
    const key = seedKey(store, ADMIN_ID);
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(`ok:${ADMIN_ID}:44444444-4444-4444-8444-444444444444`);
  });

  it('maps a key-query error to 401, a user-query error to 401, a workspace-query error to 403', async () => {
    const key = seedKey(store, USER_ID);
    store.errors = { agent_keys: true };
    expect(
      await statusOf(
        await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
          allowAgentKey: true,
          dbClient: db,
        })
      )
    ).toBe(401);
    store.errors = { users: true };
    expect(
      await statusOf(
        await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
          allowAgentKey: true,
          dbClient: db,
        })
      )
    ).toBe(401);
    store.errors = { workspaces: true };
    expect(
      await statusOf(
        await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
          allowAgentKey: true,
          dbClient: db,
        })
      )
    ).toBe(403);
  });

  it('records last_used_at on success, and still succeeds when that update fails', async () => {
    const key = seedKey(store, USER_ID);
    const ok = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(ok)).toContain('ok:');
    expect(store.agent_keys[0].last_used_at).not.toBeNull();

    store.failUpdate = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const again = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(again)).toContain('ok:');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not try a Bearer key when allowAgentKey is false', async () => {
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('returns 500 when no database client can be resolved', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    _resetMockSupabaseClients();
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(bearerRequest(`Bearer ${key}`), SUBDOMAIN, {
      allowAgentKey: true,
    });
    expect(await statusOf(res)).toBe(500);
  });
});

describe('cookie precedence in resolveTenantSession', () => {
  let store: Store;
  let db: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    store = newStore();
    db = createFakeSupabase(store);
    seedUser(store);
    seedWorkspace(store, USER_ID);
  });

  afterEach(() => {
    _resetMockSupabaseClients();
  });

  it('a valid cookie wins over a Bearer key for another user', async () => {
    seedUser(store, { id: OTHER_ID });
    seedWorkspace(store, OTHER_ID);
    const otherKey = seedKey(store, OTHER_ID, {
      id: '55555555-5555-4555-8555-555555555555',
    });
    const res = await resolveTenantSession(
      bearerRequest(`Bearer ${otherKey}`, await cookieToken()),
      SUBDOMAIN,
      { allowAgentKey: true, dbClient: db }
    );
    expect(await statusOf(res)).toBe(`ok:${USER_ID}:cookie`);
  });

  it('an invalid cookie falls through to a valid Bearer key, not straight to 401', async () => {
    const key = seedKey(store, USER_ID);
    const res = await resolveTenantSession(
      bearerRequest(`Bearer ${key}`, 'not-a-valid-token'),
      SUBDOMAIN,
      { allowAgentKey: true, dbClient: db }
    );
    expect(await statusOf(res)).toContain(`ok:${USER_ID}:`);
  });

  it('an invalid cookie with no Bearer header is 401', async () => {
    const res = await resolveTenantSession(bearerRequest(null, 'not-a-valid-token'), SUBDOMAIN, {
      allowAgentKey: true,
      dbClient: db,
    });
    expect(await statusOf(res)).toBe(401);
  });

  it('a valid cookie for a suspended session is 401', async () => {
    const res = await resolveTenantSession(
      bearerRequest(null, await cookieToken({ status: 'suspended' })),
      SUBDOMAIN,
      { allowAgentKey: true, dbClient: db }
    );
    expect(await statusOf(res)).toBe(401);
  });

  it('a valid cookie for the wrong tenant is 403', async () => {
    const res = await resolveTenantSession(
      bearerRequest(null, await cookieToken()),
      'otherworkspace',
      { allowAgentKey: true, dbClient: db }
    );
    expect(await statusOf(res)).toBe(403);
  });
});
