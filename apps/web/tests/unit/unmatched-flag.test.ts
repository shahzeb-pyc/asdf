/**
 * refreshDestinationUnmatchedFlag — best-effort flag maintenance.
 *
 * A refresh failure must never fail the mutation that triggered it:
 * the function logs loudly and resolves. It speaks both client
 * shapes the routes use: a DatabaseClient (SQL query) and a
 * Supabase client (rpc).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { refreshDestinationUnmatchedFlag } from '../../src/lib/server/unmatched-flag';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refreshDestinationUnmatchedFlag', () => {
  it('uses the SQL query path for a DatabaseClient', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await refreshDestinationUnmatchedFlag(
      { query } as never,
      'dest-1',
    );
    expect(query).toHaveBeenCalledWith(
      'SELECT public.refresh_destination_unmatched_flag($1)',
      ['dest-1'],
    );
  });

  it('uses the rpc path for a Supabase-style client', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await refreshDestinationUnmatchedFlag({ rpc } as never, 'dest-1');
    expect(rpc).toHaveBeenCalledWith('refresh_destination_unmatched_flag', {
      p_destination_id: 'dest-1',
    });
  });

  it('does not throw when the rpc returns an error', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: new Error('rpc boom') });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      refreshDestinationUnmatchedFlag({ rpc } as never, 'dest-1'),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it('does not throw when the query path throws', async () => {
    const query = vi.fn().mockRejectedValue(new Error('query boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      refreshDestinationUnmatchedFlag({ query } as never, 'dest-1'),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it('resolves silently for a client with neither query nor rpc', async () => {
    await expect(
      refreshDestinationUnmatchedFlag({} as never, 'dest-1'),
    ).resolves.toBeUndefined();
  });
});
