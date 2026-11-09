import { describe, expect, it, vi } from 'vitest';
import {
  checkSessionStatus,
  SESSION_STATUS_PATH,
} from './session-check';

/**
 * Spec 152 O4 — the session check has two proofs. Token mode must
 * hit `?mode=token` (no database lookup server-side); full mode
 * must hit the bare path. The status mapping is unchanged in both
 * modes: 200 alive, 401 dead (bounce), anything else neutral.
 */
describe('checkSessionStatus (spec 152 O4)', () => {
  const ok = (status: number) => new Response(null, { status });
  const fetchOk = vi.fn(async () => ok(200));
  const fetchDead = vi.fn(async () => ok(401));
  const fetchError = vi.fn(async () => ok(503));
  const fetchThrow = vi.fn(async () => {
    throw new Error('offline');
  });

  it('token mode requests ?mode=token and maps 200 to active', async () => {
    fetchOk.mockClear();
    expect(await checkSessionStatus(fetchOk as unknown as typeof fetch, 'token')).toBe('active');
    expect(fetchOk).toHaveBeenCalledWith(
      `${SESSION_STATUS_PATH}?mode=token`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('full mode requests the bare path and maps 200 to active', async () => {
    fetchOk.mockClear();
    expect(await checkSessionStatus(fetchOk as unknown as typeof fetch, 'full')).toBe('active');
    expect(fetchOk).toHaveBeenCalledWith(
      SESSION_STATUS_PATH,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('defaults to full mode', async () => {
    fetchOk.mockClear();
    expect(await checkSessionStatus(fetchOk as unknown as typeof fetch)).toBe('active');
    expect(fetchOk).toHaveBeenCalledWith(
      SESSION_STATUS_PATH,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('maps 401 to dead in both modes (the bounce signal)', async () => {
    expect(await checkSessionStatus(fetchDead as unknown as typeof fetch, 'token')).toBe('dead');
    expect(await checkSessionStatus(fetchDead as unknown as typeof fetch, 'full')).toBe('dead');
  });

  it('maps 503 and network failure to error, never a bounce', async () => {
    expect(await checkSessionStatus(fetchError as unknown as typeof fetch, 'token')).toBe('error');
    expect(await checkSessionStatus(fetchThrow as unknown as typeof fetch, 'token')).toBe('error');
  });
});
