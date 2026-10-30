import { describe, expect, it, vi } from 'vitest';
import { markAccountConnectionError } from '@/lib/connect/account-probe';

// Admin-fallback path: no client passed, so the helper uses the admin
// client. Kept in its own file because the sibling suite mocks the admin
// client to null.
const { adminClient, seen } = vi.hoisted(() => {
  const seen: {
    table: string | null;
    payload: unknown;
    eqs: Array<[string, unknown]>;
  } = { table: null, payload: null, eqs: [] };
  const chain: Record<string, (...args: never[]) => unknown> = {};
  chain.update = ((payload: unknown) => {
    seen.payload = payload;
    return chain;
  }) as (...args: never[]) => unknown;
  chain.eq = ((column: string, value: unknown) => {
    seen.eqs.push([column, value]);
    return chain;
  }) as (...args: never[]) => unknown;
  chain.in = (() => ({ error: null })) as (...args: never[]) => unknown;
  const adminClient = {
    from: (table: string) => {
      seen.table = table;
      return chain;
    },
  };
  return { adminClient, seen };
});

vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => adminClient,
}));

describe('markAccountConnectionError admin fallback', () => {
  it('marks via the admin client when no client is passed', async () => {
    await expect(
      markAccountConnectionError(null, 'ws-1', 'acct-1')
    ).resolves.toBeUndefined();
    expect(seen.table).toBe('social_accounts');
    expect(seen.payload).toMatchObject({ status: 'error' });
    expect(seen.eqs).toContainEqual(['id', 'acct-1']);
    expect(seen.eqs).toContainEqual(['workspace_id', 'ws-1']);
  });
});
