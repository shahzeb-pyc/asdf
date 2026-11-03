import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleCreateKey,
  handleListKeys,
} from '../../src/app/api/tenant/[subdomain]/muse/keys/route';
import { handleDeleteKey } from '../../src/app/api/tenant/[subdomain]/muse/keys/[keyId]/route';
import { handleMuseActivity } from '../../src/app/api/tenant/[subdomain]/muse/activity/route';
import { generateAgentKey, hashAgentKey } from '../../src/lib/agent-auth';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-123456';
const USER_ID = '11111111-1111-4111-a111-111111111111';
const SUBDOMAIN = 'creatorstack';

/** Minimal thenable Supabase-style query builder over in-memory rows. */
function createFakeSupabase(store: {
  agent_keys: Record<string, unknown>[];
  agent_activity: Record<string, unknown>[];
}) {
  let idCounter = 0;
  function builder(table: 'agent_keys' | 'agent_activity') {
    const state = {
      mode: 'select' as 'select' | 'insert' | 'delete',
      inserted: null as Record<string, unknown> | null,
      filters: [] as Array<[string, unknown]>,
      sortAsc: true,
      limit: null as number | null,
      single: false,
      countExact: false,
    };
    const api: Record<string, unknown> = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        state.filters.push([col, val]);
        return api;
      },
      order(_col: string, opts?: { ascending?: boolean }) {
        state.sortAsc = opts?.ascending ?? true;
        return api;
      },
      limit(n: number) {
        state.limit = n;
        return api;
      },
      single() {
        state.single = true;
        return api;
      },
      insert(row: Record<string, unknown>) {
        state.mode = 'insert';
        state.inserted = {
          ...row,
          id: `44444444-4444-4444-8444-${String(++idCounter).padStart(12, '0')}`,
          created_at: new Date().toISOString(),
          last_used_at: null,
        };
        return api;
      },
      delete(opts?: { count?: string }) {
        state.mode = 'delete';
        state.countExact = opts?.count === 'exact';
        return api;
      },
      then(
        resolve: (value: unknown) => void,
        reject: (err: unknown) => void
      ) {
        try {
          const rows = store[table];
          if (state.mode === 'insert' && state.inserted) {
            rows.push(state.inserted);
            resolve({
              data: state.single ? state.inserted : [state.inserted],
              error: null,
            });
            return;
          }
          const filtered = rows.filter((row) =>
            state.filters.every(([col, val]) => row[col] === val)
          );
          if (state.mode === 'delete') {
            for (const row of filtered) {
              rows.splice(rows.indexOf(row), 1);
            }
            resolve({ error: null, count: filtered.length });
            return;
          }
          const sorted = [...filtered].sort((a, b) => {
            const av = String(a.created_at ?? '');
            const bv = String(b.created_at ?? '');
            return state.sortAsc
              ? av.localeCompare(bv)
              : bv.localeCompare(av);
          });
          const limited =
            state.limit !== null ? sorted.slice(0, state.limit) : sorted;
          resolve({
            data: state.single ? (limited[0] ?? null) : limited,
            error: null,
          });
        } catch (err) {
          reject(err);
        }
      },
    };
    return api;
  }
  return {
    from(table: 'agent_keys' | 'agent_activity') {
      return builder(table);
    },
  } as never;
}

async function cookieRequest(
  method: string,
  body?: unknown
): Promise<NextRequest> {
  process.env.SESSION_SECRET = TEST_SECRET;
  const token = await signSessionToken(
    {
      userId: USER_ID,
      email: 'testuser@gmail.com',
      subdomain: SUBDOMAIN,
      allowedSubdomains: [SUBDOMAIN],
      role: 'user',
      status: 'active',
    },
    TEST_SECRET
  );
  return new NextRequest('http://localhost:3000/api/tenant/creatorstack/muse', {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fbup_session=${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('Muse keys API', () => {
  let store: {
    agent_keys: Record<string, unknown>[];
    agent_activity: Record<string, unknown>[];
  };
  let db: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    store = { agent_keys: [], agent_activity: [] };
    db = createFakeSupabase(store);
  });

  it('creates a key once, and the list never returns plaintext', async () => {
    const created = await handleCreateKey(
      await cookieRequest('POST', { name: 'My Muse' }),
      SUBDOMAIN,
      db
    );
    expect(created.status).toBe(201);
    const createdJson = await created.json();
    expect(createdJson.key).toMatch(/^fbu_[0-9a-f]{32}$/);
    expect(createdJson.keyPrefix).toBe(
      `fbu_…${createdJson.key.slice(-4)}`
    );
    // Only the hash is stored, never the plaintext.
    expect(store.agent_keys).toHaveLength(1);
    expect(store.agent_keys[0].key_hash).toBe(hashAgentKey(createdJson.key));
    expect('key' in (store.agent_keys[0] as object)).toBe(false);

    const listed = await handleListKeys(
      await cookieRequest('GET'),
      SUBDOMAIN,
      db
    );
    const listedJson = await listed.json();
    expect(listedJson.keys).toHaveLength(1);
    expect('key' in listedJson.keys[0]).toBe(false);
    expect('key_hash' in listedJson.keys[0]).toBe(false);
    expect('keyHash' in listedJson.keys[0]).toBe(false);
  });

  it('revoke deletes the row; a second revoke is 404', async () => {
    const created = await handleCreateKey(
      await cookieRequest('POST', { name: 'To revoke' }),
      SUBDOMAIN,
      db
    );
    const { id } = await created.json();
    const revoked = await handleDeleteKey(
      await cookieRequest('DELETE'),
      SUBDOMAIN,
      id,
      db
    );
    expect(revoked.status).toBe(200);
    expect(store.agent_keys).toHaveLength(0);
    const again = await handleDeleteKey(
      await cookieRequest('DELETE'),
      SUBDOMAIN,
      id,
      db
    );
    expect(again.status).toBe(404);
  });

  it('rejects key creation without a session', async () => {
    const req = new NextRequest('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No session' }),
    });
    const res = await handleCreateKey(req, SUBDOMAIN, db);
    expect(res.status).toBe(401);
  });
});

describe('Muse activity API', () => {
  it('counts today by type and groups rows by day, Muse uploads only', async () => {
    const store = {
      agent_keys: [] as Record<string, unknown>[],
      agent_activity: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
          user_id: USER_ID,
          media_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb1',
          name: 'today-reel.mp4',
          media_type: 'video',
          folder_id: null,
          created_at: '2026-11-03T10:00:00.000Z',
        },
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
          user_id: USER_ID,
          media_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2',
          name: 'today-cover.jpg',
          media_type: 'image',
          folder_id: null,
          created_at: '2026-11-03T11:00:00.000Z',
        },
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
          user_id: USER_ID,
          media_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb3',
          name: 'yesterday-reel.mp4',
          media_type: 'video',
          folder_id: null,
          created_at: '2026-11-02T09:00:00.000Z',
        },
      ] as Record<string, unknown>[],
    };
    const db = createFakeSupabase(store);
    const res = await handleMuseActivity(
      await cookieRequest('GET'),
      SUBDOMAIN,
      db,
      new Date('2026-11-03T12:00:00.000Z')
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.today).toEqual({ videos: 1, images: 1, total: 2 });
    expect(json.days.map((d: { label: string }) => d.label)).toEqual([
      'Today',
      'Yesterday',
    ]);
    expect(json.days[0].rows).toHaveLength(2);
  });
});

describe('Muse keys API — validation, ownership, and missing-table paths', () => {
  let store: {
    agent_keys: Record<string, unknown>[];
    agent_activity: Record<string, unknown>[];
  };
  let db: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    store = { agent_keys: [], agent_activity: [] };
    db = createFakeSupabase(store);
  });

  it('rejects an empty, missing, or over-long key name with 400', async () => {
    for (const body of [{ name: '' }, {}, { name: 'x'.repeat(101) }]) {
      const res = await handleCreateKey(await cookieRequest('POST', body), SUBDOMAIN, db);
      expect(res.status).toBe(400);
    }
    expect(store.agent_keys).toHaveLength(0);
  });

  it('rejects list and delete without a session with 401', async () => {
    const anon = new NextRequest('http://localhost:3000/api/x', { method: 'GET' });
    expect((await handleListKeys(anon, SUBDOMAIN, db)).status).toBe(401);
    const anonDel = new NextRequest('http://localhost:3000/api/x', { method: 'DELETE' });
    expect(
      (await handleDeleteKey(anonDel, SUBDOMAIN, '44444444-4444-4444-8444-444444444444', db)).status
    ).toBe(401);
  });

  it('rejects delete with a malformed key id with 400', async () => {
    const res = await handleDeleteKey(await cookieRequest('DELETE'), SUBDOMAIN, 'not-a-uuid', db);
    expect(res.status).toBe(400);
  });

  it('lists only the caller’s own keys', async () => {
    await handleCreateKey(await cookieRequest('POST', { name: 'Mine' }), SUBDOMAIN, db);
    store.agent_keys.push({
      id: '55555555-5555-4555-8555-555555555555',
      user_id: '99999999-9999-4999-8999-999999999999',
      name: 'Someone else',
      key_prefix: 'fbu_…zzzz',
      scopes: ['media:read', 'media:write'],
      expires_at: null,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
    const listed = await handleListKeys(await cookieRequest('GET'), SUBDOMAIN, db);
    const json = await listed.json();
    expect(json.keys).toHaveLength(1);
    expect(json.keys[0].name).toBe('Mine');
  });

  it('reports a plain not-set-up-yet 500 when the keys table is missing', async () => {
    const missingTable = {
      from() {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.insert = () => chain;
        chain.single = () => Promise.resolve({ data: null, error: { code: '42P01' } });
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { code: '42P01' } });
        return chain;
      },
    } as never;
    const listed = await handleListKeys(await cookieRequest('GET'), SUBDOMAIN, missingTable);
    expect(listed.status).toBe(500);
    expect((await listed.json()).error).toBe('Muse keys are not set up yet');
    const created = await handleCreateKey(
      await cookieRequest('POST', { name: 'X' }),
      SUBDOMAIN,
      missingTable
    );
    expect(created.status).toBe(500);
  });
});

describe('Muse activity API — ownership, labels, and auth', () => {
  it('rejects activity without a session and excludes other users’ rows', async () => {
    const store = {
      agent_keys: [] as Record<string, unknown>[],
      agent_activity: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa9',
          user_id: '99999999-9999-4999-8999-999999999999',
          media_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb9',
          name: 'someone-else.mp4',
          media_type: 'video',
          folder_id: null,
          created_at: '2026-11-03T09:00:00.000Z',
        },
      ] as Record<string, unknown>[],
    };
    const db = createFakeSupabase(store);
    const anon = new NextRequest('http://localhost:3000/api/x', { method: 'GET' });
    expect((await handleMuseActivity(anon, SUBDOMAIN, db)).status).toBe(401);
    const res = await handleMuseActivity(
      await cookieRequest('GET'),
      SUBDOMAIN,
      db,
      new Date('2026-11-03T12:00:00.000Z')
    );
    const json = await res.json();
    expect(json.today).toEqual({ videos: 0, images: 0, total: 0 });
    expect(json.days).toEqual([]);
  });

  it('labels an older day with its date, not Today or Yesterday', async () => {
    const store = {
      agent_keys: [] as Record<string, unknown>[],
      agent_activity: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa8',
          user_id: USER_ID,
          media_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb8',
          name: 'old-reel.mp4',
          media_type: 'video',
          folder_id: null,
          created_at: '2026-10-30T09:00:00.000Z',
        },
      ] as Record<string, unknown>[],
    };
    const db = createFakeSupabase(store);
    const res = await handleMuseActivity(
      await cookieRequest('GET'),
      SUBDOMAIN,
      db,
      new Date('2026-11-03T12:00:00.000Z')
    );
    const json = await res.json();
    expect(json.days.map((d: { label: string }) => d.label)).toEqual(['30 Oct 2026']);
    expect(json.today).toEqual({ videos: 0, images: 0, total: 0 });
  });

  it('reports a plain not-set-up-yet 500 when the activity table is missing', async () => {
    const missingTable = {
      from() {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.limit = () => chain;
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { code: '42P01' } });
        return chain;
      },
    } as never;
    const res = await handleMuseActivity(await cookieRequest('GET'), SUBDOMAIN, missingTable);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Muse activity is not set up yet');
  });
});

describe('agent key generation', () => {
  it('generates distinct keys whose hash is deterministic and one-way', () => {
    const keyA = generateAgentKey();
    const keyB = generateAgentKey();
    expect(keyA).not.toBe(keyB);
    expect(hashAgentKey(keyA)).toBe(hashAgentKey(keyA));
    expect(hashAgentKey(keyA)).not.toBe(keyA);
    expect(hashAgentKey(keyA)).not.toBe(hashAgentKey(keyB));
  });
});
