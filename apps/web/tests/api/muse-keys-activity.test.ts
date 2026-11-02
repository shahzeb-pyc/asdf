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
      email: 'user@gmail.com',
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
    body: body ? JSON.stringify(body) : undefined,
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
          id: 'a1',
          media_id: 'm1',
          name: 'today-reel.mp4',
          media_type: 'video',
          folder_id: null,
          created_at: '2026-11-03T10:00:00.000Z',
        },
        {
          id: 'a2',
          media_id: 'm2',
          name: 'today-cover.jpg',
          media_type: 'image',
          folder_id: null,
          created_at: '2026-11-03T11:00:00.000Z',
        },
        {
          id: 'a3',
          media_id: 'm3',
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
