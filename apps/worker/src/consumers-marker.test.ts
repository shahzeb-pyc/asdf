/**
 * applyDestinationFbStatusMarker — spec 155 SEND BACK (PR #199, item 4).
 *
 * The marker write is a single-statement RPC
 * (`apply_destination_fb_status_marker`, migration
 * 20261109170000): no read-modify-write of the whole metadata
 * object, so concurrent marker writes serialize on the row lock
 * and no concurrent metadata write can be clobbered. These tests
 * prove the helper's contract at the client boundary — the RPC
 * call itself, the null-clear, loud failure logging, and never
 * throwing. The SQL-level behaviour (other keys preserved, clear
 * removes only fb_status, unknown marker raises, grants) is
 * proved on real PostgreSQL by the settle-rpc rig
 * (tests/settle-rpc/check.ts, sectionMarkerRpc).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { applyDestinationFbStatusMarker } from './consumers.js';

const DEST_ID = '22222222-2222-4222-a222-222222222222';

function makeDb(rpcImpl?: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  const rpc = vi.fn(
    rpcImpl ?? (async () => ({ data: null, error: null }))
  );
  const from = vi.fn(() => {
    throw new Error('from() must never be called: the marker write is a single RPC');
  });
  return { db: { rpc, from } as never, rpc, from };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyDestinationFbStatusMarker', () => {
  it('sets the marker through the RPC with no row read', async () => {
    const { db, rpc, from } = makeDb();
    await applyDestinationFbStatusMarker(db, DEST_ID, 'missing_permission');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('apply_destination_fb_status_marker', {
      p_destination_id: DEST_ID,
      p_marker: 'missing_permission',
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('clears the marker with a null marker', async () => {
    const { db, rpc } = makeDb();
    await applyDestinationFbStatusMarker(db, DEST_ID, null);
    expect(rpc).toHaveBeenCalledWith('apply_destination_fb_status_marker', {
      p_destination_id: DEST_ID,
      p_marker: null,
    });
  });

  it('logs loudly but does not throw when the RPC returns an error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb(async () => ({ data: null, error: new Error('marker boom') }));
    await expect(
      applyDestinationFbStatusMarker(db, DEST_ID, 'missing_permission'),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to apply fb_status marker missing_permission'),
      expect.anything()
    );
  });

  it('logs loudly but does not throw when the RPC itself throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb(async () => {
      throw new Error('rpc threw');
    });
    await expect(
      applyDestinationFbStatusMarker(db, DEST_ID, null),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to apply fb_status marker (clear)'),
      expect.anything()
    );
  });
});
