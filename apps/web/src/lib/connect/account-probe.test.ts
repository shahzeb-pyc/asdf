import { describe, expect, it, vi } from 'vitest';
import {
  isTokenDeadGraphStatus,
  markAccountConnectionError,
} from '@/lib/connect/account-probe';

// Deterministic no-database suite: the admin client is null, so
// the supabase fallback path returns quietly.
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => null,
}));

describe('isTokenDeadGraphStatus', () => {
  it('treats 400/401/403 as a dead token and 5xx/network as transient', () => {
    expect(isTokenDeadGraphStatus(400)).toBe(true);
    expect(isTokenDeadGraphStatus(401)).toBe(true);
    expect(isTokenDeadGraphStatus(403)).toBe(true);
    expect(isTokenDeadGraphStatus(500)).toBe(false);
    expect(isTokenDeadGraphStatus(429)).toBe(false);
    expect(isTokenDeadGraphStatus(undefined)).toBe(false);
  });
});

describe('markAccountConnectionError', () => {
  it('flips only active/expired rows via the SQL path', async () => {
    const query = vi.fn(async () => []);
    const client = { query } as unknown as Parameters<
      typeof markAccountConnectionError
    >[0];
    await markAccountConnectionError(client, 'ws-1', 'acct-1');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('active', 'expired')"),
      ['acct-1', 'ws-1']
    );
  });

  it('never throws when the store fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const query = vi.fn(async () => {
      throw new Error('db down');
    });
    const client = { query } as unknown as Parameters<
      typeof markAccountConnectionError
    >[0];
    await expect(
      markAccountConnectionError(client, 'ws-1', 'acct-1')
    ).resolves.toBeUndefined();
  });

  it('does nothing without a client and without an admin client', async () => {
    // No client and (in this suite) no admin client configured:
    // the helper returns quietly instead of throwing.
    await expect(
      markAccountConnectionError(null, 'ws-1', 'acct-1')
    ).resolves.toBeUndefined();
  });
});
