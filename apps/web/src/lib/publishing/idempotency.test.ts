import { describe, expect, it, vi } from 'vitest';
import {
  parseIdempotencyKeyHeader,
  updateIdempotencyResult,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';

const SCOPE: IdempotencyScope = {
  workspaceId: 'ws-1',
  userId: 'user-1',
  action: 'publish-now',
  key: '11111111-1111-4111-8111-111111111111',
};

/**
 * Minimal Supabase-shaped fake for the update path: from() →
 * update(payload) → eq()… → select() → { data, error }.
 * Only the chain updateIdempotencyResult actually walks is built.
 */
function fakeSupabase(result: {
  data: Array<{ id: string }> | null;
  error: { message: string } | null;
}) {
  const eqCalls: Array<[string, unknown]> = [];
  let updatePayload: unknown = null;
  const chain: Record<string, (...args: never[]) => unknown> = {};
  chain.eq = ((column: string, value: unknown) => {
    eqCalls.push([column, value]);
    return chain;
  }) as (...args: never[]) => unknown;
  chain.select = (() => result) as (...args: never[]) => unknown;
  chain.update = ((payload: unknown) => {
    updatePayload = payload;
    return chain;
  }) as (...args: never[]) => unknown;
  const client = {
    from: () => chain,
  };
  return {
    client: client as unknown as Parameters<
      typeof updateIdempotencyResult
    >[0],
    eqCalls,
    get updatePayload() {
      return updatePayload as {
        response_status: number;
        response_body: unknown;
        expires_at: string;
      } | null;
    },
  };
}

describe('parseIdempotencyKeyHeader', () => {
  it('returns null when the header is absent', () => {
    const headers = { get: () => null };
    expect(parseIdempotencyKeyHeader(headers)).toEqual({
      key: null,
      invalid: false,
    });
  });

  it('returns the key for a valid UUID', () => {
    const headers = {
      get: () => '11111111-1111-4111-8111-111111111111',
    };
    expect(parseIdempotencyKeyHeader(headers)).toEqual({
      key: '11111111-1111-4111-8111-111111111111',
      invalid: false,
    });
  });

  it('flags a present-but-malformed key as invalid', () => {
    const headers = { get: () => 'not-a-uuid' };
    expect(parseIdempotencyKeyHeader(headers)).toEqual({
      key: null,
      invalid: true,
    });
  });
});

describe('updateIdempotencyResult (BG16)', () => {
  it('overwrites the stored body regardless of current status and scopes by workspace/user/action/key', async () => {
    const fake = fakeSupabase({ data: [{ id: 'row-1' }], error: null });
    const body = { results: [{ status: 'published' }] };
    const ok = await updateIdempotencyResult(fake.client, SCOPE, {
      status: 200,
      body,
    });
    expect(ok).toBe(true);
    expect(fake.updatePayload?.response_status).toBe(200);
    expect(fake.updatePayload?.response_body).toEqual(body);
    expect(typeof fake.updatePayload?.expires_at).toBe('string');
    expect(fake.eqCalls).toEqual([
      ['workspace_id', 'ws-1'],
      ['user_id', 'user-1'],
      ['action', 'publish-now'],
      ['idempotency_key', '11111111-1111-4111-8111-111111111111'],
    ]);
  });

  it('returns false (never throws) when the store update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeSupabase({
      data: null,
      error: { message: 'boom' },
    });
    const ok = await updateIdempotencyResult(fake.client, SCOPE, {
      status: 200,
      body: { results: [] },
    });
    expect(ok).toBe(false);
  });
});
