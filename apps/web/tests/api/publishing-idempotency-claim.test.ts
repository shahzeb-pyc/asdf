/**
 * @file publishing-idempotency-claim.test.ts
 * @description Claim / complete / release and lookup-failure paths
 * of the idempotency helpers, on the Supabase client path and the
 * legacy SQL path. The route tests exercise lookup + store; these
 * are the branches Sonar counts on this PR's new code in
 * src/lib/publishing/idempotency.ts (components and routes are
 * excluded from Sonar coverage by sonar-project.properties).
 *
 * The Supabase fake is a small chainable builder: insert/select/
 * update/delete return it, single/maybeSingle resolve a scripted
 * result, and awaiting an update/delete chain resolves its
 * scripted result — mirroring the real client's thenable builders.
 */

import { describe, expect, it } from 'vitest';
import {
  claimIdempotencyResult,
  completeIdempotencyResult,
  IdempotencyStoreError,
  lookupIdempotencyResult,
  releaseIdempotencyClaim,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';

const SCOPE: IdempotencyScope = {
  workspaceId: '22222222-2222-4222-a222-222222222222',
  userId: '11111111-1111-4111-a111-111111111111',
  action: 'destination-queue',
  key: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
};

type Scripted = { data: unknown; error: unknown };

function supabaseFake(script: {
  single?: Scripted;
  maybeSingle?: Scripted;
  chain?: Scripted | Error;
}) {
  const calls: string[] = [];
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.gt = () => b;
  b.lt = () => b;
  b.insert = (row: Record<string, unknown>) => {
    calls.push(`insert:${String(row.response_status)}`);
    return b;
  };
  b.update = () => b;
  b.delete = () => b;
  b.single = () => Promise.resolve(script.single ?? { data: null, error: null });
  b.maybeSingle = () => Promise.resolve(script.maybeSingle ?? { data: null, error: null });
  b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
    if (script.chain instanceof Error) return Promise.resolve().then(() => { throw script.chain; }).then(onOk, onErr);
    return Promise.resolve(script.chain ?? { data: [], error: null }).then(onOk, onErr);
  };
  return { from: () => b, calls };
}

describe('claimIdempotencyResult (Supabase path)', () => {
  it('claims on insert success', async () => {
    const fake = supabaseFake({ single: { data: { id: 'sentinel-1' }, error: null } });
    expect(await claimIdempotencyResult(fake as never, SCOPE)).toBe('claimed');
    expect(fake.calls).toEqual(['insert:102']);
  });

  it('reports already-processing on a 23505 conflict', async () => {
    const fake = supabaseFake({
      single: { data: null, error: { code: '23505', message: 'duplicate key' } },
    });
    expect(await claimIdempotencyResult(fake as never, SCOPE)).toBe('already-processing');
  });

  it('reports already-processing when the insert returns no row', async () => {
    const fake = supabaseFake({ single: { data: null, error: null } });
    expect(await claimIdempotencyResult(fake as never, SCOPE)).toBe('already-processing');
  });

  it('throws a store error on any other insert failure', async () => {
    const fake = supabaseFake({
      single: { data: null, error: new Error('db down') },
    });
    await expect(claimIdempotencyResult(fake as never, SCOPE)).rejects.toBeInstanceOf(
      IdempotencyStoreError
    );
  });

  it('throws a store error when no Supabase client is available', async () => {
    await expect(claimIdempotencyResult({} as never, SCOPE)).rejects.toThrow(
      'Idempotency store unavailable'
    );
  });
});

describe('lookupIdempotencyResult (Supabase path)', () => {
  it('wraps a Supabase lookup error in IdempotencyStoreError', async () => {
    const fake = supabaseFake({
      maybeSingle: { data: null, error: new Error('read boom') },
    });
    await expect(lookupIdempotencyResult(fake as never, SCOPE)).rejects.toBeInstanceOf(
      IdempotencyStoreError
    );
  });

  it('returns null for a processing sentinel instead of replaying it', async () => {
    const fake = supabaseFake({
      maybeSingle: { data: { response_status: 102, response_body: { processing: true } }, error: null },
    });
    expect(await lookupIdempotencyResult(fake as never, SCOPE)).toBeNull();
  });

  it('returns the stored result for a completed row', async () => {
    const fake = supabaseFake({
      maybeSingle: { data: { response_status: 201, response_body: { id: 'queued-1' } }, error: null },
    });
    expect(await lookupIdempotencyResult(fake as never, SCOPE)).toEqual({
      status: 201,
      body: { id: 'queued-1' },
    });
  });
});

describe('releaseIdempotencyClaim', () => {
  it('deletes the sentinel on the legacy path', async () => {
    const seen: unknown[][] = [];
    const legacy = { query: async (_sql: string, params: unknown[]) => { seen.push(params); return []; } };
    await releaseIdempotencyClaim(legacy as never, SCOPE);
    expect(seen[0]?.[4]).toBe(102);
  });

  it('deletes the sentinel on the Supabase path and no-ops without a client', async () => {
    const fake = supabaseFake({ chain: { data: [], error: null } });
    await expect(releaseIdempotencyClaim(fake as never, SCOPE)).resolves.toBeUndefined();
    await expect(releaseIdempotencyClaim({} as never, SCOPE)).resolves.toBeUndefined();
  });

  it('swallows a Supabase release failure instead of throwing', async () => {
    const fake = supabaseFake({ chain: new Error('delete boom') });
    await expect(releaseIdempotencyClaim(fake as never, SCOPE)).resolves.toBeUndefined();
  });
});

describe('completeIdempotencyResult', () => {
  const result = { status: 201, body: { id: 'queued-1' } };

  it('returns true when the legacy update matches, false when it matches nothing', async () => {
    const hit = { query: async () => [{ id: 'sentinel-1' }] };
    expect(await completeIdempotencyResult(hit as never, SCOPE, result)).toBe(true);
    const miss = { query: async () => [] };
    expect(await completeIdempotencyResult(miss as never, SCOPE, result)).toBe(false);
  });

  it('returns true on Supabase update success, false without a client or on error', async () => {
    const ok = supabaseFake({ chain: { data: [{ id: 'sentinel-1' }], error: null } });
    expect(await completeIdempotencyResult(ok as never, SCOPE, result)).toBe(true);
    expect(await completeIdempotencyResult({} as never, SCOPE, result)).toBe(false);
    const err = supabaseFake({ chain: { data: null, error: new Error('update boom') } });
    expect(await completeIdempotencyResult(err as never, SCOPE, result)).toBe(false);
  });
});
