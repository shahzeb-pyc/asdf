/**
 * authenticateTenantRoute with allowAgentKey — behavioural tests.
 *
 * The opt-in must delegate to the agent resolver (Bearer key works
 * on media routes) while the default stays cookie-only, so a
 * media-only key can never open a non-media route through this
 * helper. The database is injected through the repo's own test
 * seam (_setMockSupabaseServiceClient), exactly as other suites do.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '../../src/lib/route-auth';
import {
  _resetMockSupabaseClients,
  _setMockSupabaseServiceClient,
} from '../../src/lib/auth/clients';
import { generateAgentKey, hashAgentKey } from '../../src/lib/agent-auth';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-123456';
const SUBDOMAIN = 'creatorstack';
const USER_ID = '11111111-1111-4111-a111-111111111111';

type Row = Record<string, unknown>;

function createFakeSupabase(store: {
  agent_keys: Row[];
  users: Row[];
  workspaces: Row[];
}) {
  function builder(table: 'agent_keys' | 'users' | 'workspaces') {
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
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        try {
          if (state.mode === 'update') {
            for (const row of store[table]) {
              if (state.filters.every(([col, val]) => row[col] === val)) {
                Object.assign(row, state.patch);
              }
            }
          }
          resolve({ error: null });
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

describe('authenticateTenantRoute allowAgentKey', () => {
  let store: { agent_keys: Row[]; users: Row[]; workspaces: Row[] };
  let key: string;

  beforeEach(() => {
    store = { agent_keys: [], users: [], workspaces: [] };
    store.users.push({ id: USER_ID, email: 'testuser@gmail.com', role: 'user', status: 'active' });
    store.workspaces.push({ id: 'ws-1', owner_id: USER_ID, subdomain: SUBDOMAIN });
    key = generateAgentKey();
    store.agent_keys.push({
      id: '44444444-4444-4444-8444-444444444444',
      user_id: USER_ID,
      key_hash: hashAgentKey(key),
      expires_at: null,
      last_used_at: null,
    });
    _setMockSupabaseServiceClient(createFakeSupabase(store));
  });

  afterEach(() => {
    _resetMockSupabaseClients();
  });

  function bearerRequest(): NextRequest {
    return new NextRequest('http://localhost:3000/api/tenant/creatorstack/media', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
  }

  it('resolves a Bearer key to a session with agentKeyId when opted in', async () => {
    const auth = await authenticateTenantRoute(bearerRequest(), SUBDOMAIN, {
      allowAgentKey: true,
    });
    expect(auth.errorResponse).toBeUndefined();
    expect(auth.session?.userId).toBe(USER_ID);
    expect('agentKeyId' in auth ? auth.agentKeyId : undefined).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('returns the error response when the opted-in Bearer key is unknown', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/creatorstack/media', {
      method: 'GET',
      headers: { Authorization: `Bearer ${generateAgentKey()}` },
    });
    const auth = await authenticateTenantRoute(req, SUBDOMAIN, { allowAgentKey: true });
    expect(auth.errorResponse?.status).toBe(401);
    expect(auth.session).toBeUndefined();
  });

  it('resolves a valid cookie through the opted-in path without an agentKeyId', async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: 'testuser@gmail.com',
        subdomain: SUBDOMAIN,
        allowedSubdomains: [SUBDOMAIN],
        role: 'user',
        status: 'active',
      } as never,
      TEST_SECRET
    );
    const req = new NextRequest('http://localhost:3000/api/tenant/creatorstack/media', {
      method: 'GET',
      headers: { Cookie: `fbup_session=${token}` },
    });
    const auth = await authenticateTenantRoute(req, SUBDOMAIN, { allowAgentKey: true });
    expect(auth.errorResponse).toBeUndefined();
    expect(auth.session?.userId).toBe(USER_ID);
    expect('agentKeyId' in auth ? auth.agentKeyId : undefined).toBeUndefined();
  });

  it('rejects the same Bearer key when not opted in (cookie-only default)', async () => {
    const auth = await authenticateTenantRoute(bearerRequest(), SUBDOMAIN);
    expect(auth.errorResponse?.status).toBe(401);
  });

  it('still resolves a valid cookie session when not opted in', async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: 'testuser@gmail.com',
        subdomain: SUBDOMAIN,
        allowedSubdomains: [SUBDOMAIN],
        role: 'user',
        status: 'active',
      } as never,
      TEST_SECRET
    );
    const req = new NextRequest('http://localhost:3000/api/tenant/creatorstack/billing', {
      method: 'GET',
      headers: { Cookie: `fbup_session=${token}` },
    });
    const auth = await authenticateTenantRoute(req, SUBDOMAIN);
    expect(auth.errorResponse).toBeUndefined();
    expect(auth.session?.userId).toBe(USER_ID);
    expect('agentKeyId' in auth ? auth.agentKeyId : undefined).toBeUndefined();
  });
});
