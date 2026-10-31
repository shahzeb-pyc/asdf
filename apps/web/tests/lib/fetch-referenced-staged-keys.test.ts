import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import {
  fetchReferencedStagedKeys,
  LIVE_QUEUE_STATUSES_FOR_SWEEP,
} from '@/lib/publishing/destination-enqueue';
import {
  sweepUnclaimedStagedUploads,
  postStagingKeyPrefix,
} from '@/lib/publishing/post-owned-media';
import { MockStorageProvider } from '../helpers/mock-storage';

/**
 * Send-back 2 (PR #74): fetchReferencedStagedKeys used to take an
 * arbitrary first 1,000 staged-key rows of ANY status, so once a
 * workspace passed 1,000 such rows the sweep's keep set could drop
 * a still-queued staged post scheduled far out — and the sweep
 * then deleted bytes its later publish needed.
 */

const userId = '11111111-1111-4111-a111-111111111111';
const workspaceId = '22222222-2222-4222-a222-222222222222';

function stagedId(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function stagedKey(i: number): string {
  return `${postStagingKeyPrefix(userId)}aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/file-${i}.jpg`;
}

interface StagedRow {
  id: string;
  workspace_id: string;
  media_storage_key: string;
  status: string;
}

/** Legacy fake that honours the keep-set query like a real DB:
 * workspace + prefix + status filter, keyset paging on id, LIMIT. */
class FakeLegacyDb {
  rows: StagedRow[] = [];
  seenSql: string[] = [];
  seenStatuses: unknown[] = [];

  query = vi.fn(async (sql: string, params: unknown[] = []) => {
    this.seenSql.push(sql);
    const [ws, like, statuses, lastId] = params as [string, string, string[], string];
    this.seenStatuses.push(statuses);
    const prefix = like.replace(/%$/, '');
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 1000);
    return this.rows
      .filter(
        (r) =>
          r.workspace_id === ws &&
          r.media_storage_key.startsWith(prefix) &&
          statuses.includes(r.status) &&
          r.id > lastId
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((r) => ({ id: r.id, media_storage_key: r.media_storage_key }));
  });
}

/** Supabase fake with the same filtering semantics, chainable. */
function makeSupabase(rows: StagedRow[]) {
  const seenInFilters: Array<[string, unknown[]]> = [];
  const builder = () => {
    const state: {
      eqFilters: Array<[string, unknown]>;
      likeFilters: Array<[string, string]>;
      inFilters: Array<[string, unknown[]]>;
      gt: [string, unknown] | null;
      limit: number;
    } = { eqFilters: [], likeFilters: [], inFilters: [], gt: null, limit: 1000 };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        state.eqFilters.push([column, value]);
        return chain;
      },
      like: (column: string, pattern: string) => {
        state.likeFilters.push([column, pattern]);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        state.inFilters.push([column, values]);
        seenInFilters.push([column, values]);
        return chain;
      },
      gt: (column: string, value: unknown) => {
        state.gt = [column, value];
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        state.limit = n;
        return chain;
      },
    };
    (chain as { then: unknown }).then = (onFulfilled: (value: unknown) => unknown) => {
      let page = [...rows];
      for (const [column, value] of state.eqFilters) {
        if (column === 'workspace_id') {
          page = page.filter((r) => r.workspace_id === value);
        }
      }
      for (const [column, pattern] of state.likeFilters) {
        if (column === 'media_storage_key') {
          const prefix = pattern.replace(/%$/, '');
          page = page.filter((r) => r.media_storage_key.startsWith(prefix));
        }
      }
      for (const [column, values] of state.inFilters) {
        if (column === 'status') {
          page = page.filter((r) => (values as unknown[]).includes(r.status));
        }
      }
      if (state.gt && state.gt[0] === 'id') {
        page = page.filter((r) => r.id > (state.gt as [string, string])[1]);
      }
      page.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const sliced = page.slice(0, state.limit);
      return Promise.resolve({
        data: sliced.map((r) => ({ id: r.id, media_storage_key: r.media_storage_key })),
        error: null,
      }).then(onFulfilled);
    };
    return chain;
  };
  return {
    supabase: { from: vi.fn(() => builder()) },
    seenInFilters,
  };
}

describe('fetchReferencedStagedKeys keep set (PR #74 send-back 2)', () => {
  it('keeps a queued staged key past the old 1,000-row cap (legacy path)', async () => {
    const db = new FakeLegacyDb();
    // 2,500 queued staged rows: the old LIMIT 1000 slice would
    // have dropped everything past row 1,000.
    for (let i = 0; i < 2500; i++) {
      db.rows.push({
        id: stagedId(i),
        workspace_id: workspaceId,
        media_storage_key: stagedKey(i),
        status: 'queued',
      });
    }
    // Terminal rows must NOT be kept, even though they match the prefix.
    db.rows.push({
      id: stagedId(9000),
      workspace_id: workspaceId,
      media_storage_key: stagedKey(9000),
      status: 'published',
    });
    db.rows.push({
      id: stagedId(9001),
      workspace_id: workspaceId,
      media_storage_key: stagedKey(9001),
      status: 'cancelled',
    });
    // A queued row under a different prefix is not a staged key.
    db.rows.push({
      id: stagedId(9002),
      workspace_id: workspaceId,
      media_storage_key: `users/${userId}/media/library.jpg`,
      status: 'queued',
    });

    const keys = await fetchReferencedStagedKeys(
      db as unknown as DatabaseClient,
      workspaceId,
      userId
    );
    expect(keys.size).toBe(2500);
    // The target: a queued staged key near the end of the set —
    // past the old cap — still in the keep set.
    expect(keys.has(stagedKey(2400))).toBe(true);
    expect(keys.has(stagedKey(9000))).toBe(false);
    expect(keys.has(stagedKey(9001))).toBe(false);
    expect(keys.has(`users/${userId}/media/library.jpg`)).toBe(false);
    // Only live statuses are ever requested.
    expect(db.seenStatuses).toHaveLength(3);
    for (const statuses of db.seenStatuses) {
      expect(statuses).toEqual([...LIVE_QUEUE_STATUSES_FOR_SWEEP]);
    }
  });

  it('keeps a queued staged key past the old 1,000-row cap (Supabase path)', async () => {
    const rows: StagedRow[] = [];
    for (let i = 0; i < 1500; i++) {
      rows.push({
        id: stagedId(i),
        workspace_id: workspaceId,
        media_storage_key: stagedKey(i),
        status: i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'publishing' : 'queued',
      });
    }
    rows.push({
      id: stagedId(9000),
      workspace_id: workspaceId,
      media_storage_key: stagedKey(9000),
      status: 'cancelled',
    });
    const { supabase, seenInFilters } = makeSupabase(rows);
    const keys = await fetchReferencedStagedKeys(
      supabase as never,
      workspaceId,
      userId
    );
    expect(keys.size).toBe(1500);
    expect(keys.has(stagedKey(1499))).toBe(true);
    expect(keys.has(stagedKey(9000))).toBe(false);
    expect(
      seenInFilters.some(
        ([column, values]) =>
          column === 'status' &&
          JSON.stringify(values) === JSON.stringify([...LIVE_QUEUE_STATUSES_FOR_SWEEP])
      )
    ).toBe(true);
  });

  it('a queued staged key older than 24h is never swept when the keep set is large', async () => {
    const db = new FakeLegacyDb();
    for (let i = 0; i < 1200; i++) {
      db.rows.push({
        id: stagedId(i),
        workspace_id: workspaceId,
        media_storage_key: stagedKey(i),
        status: 'queued',
      });
    }
    const referenced = await fetchReferencedStagedKeys(
      db as unknown as DatabaseClient,
      workspaceId,
      userId
    );
    expect(referenced.has(stagedKey(1100))).toBe(true);

    // The sweep itself, fed that keep set: the old (>24h) target
    // key survives, while an equally old unreferenced key is swept.
    const storage = new MockStorageProvider();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    storage.uploadedObjects.set(stagedKey(1100), {
      contentType: 'image/jpeg',
      byteLength: 10,
      uploadedAt: old,
    });
    const orphanKey = `${postStagingKeyPrefix(userId)}aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/orphan.jpg`;
    storage.uploadedObjects.set(orphanKey, {
      contentType: 'image/jpeg',
      byteLength: 10,
      uploadedAt: old,
    });
    const report = await sweepUnclaimedStagedUploads(
      storage,
      userId,
      referenced,
      new Date()
    );
    expect(report.deleted).toContain(orphanKey);
    expect(report.deleted).not.toContain(stagedKey(1100));
    expect(storage.uploadedObjects.has(stagedKey(1100))).toBe(true);
  });
});
