import { describe, expect, it, vi } from 'vitest';
import {
  checkSessionStatus,
  SESSION_CHECK_FOCUS_THROTTLE_MS,
  SESSION_CHECK_INTERVAL_MS,
  SESSION_STATUS_PATH,
} from '@/lib/api/session-check';

/**
 * Global session check outcomes (session-global-check spec §2.2).
 * Only the HTTP status is interpreted: 200 → active, 401 → dead,
 * anything else (or a thrown fetch) → error (neutral, never a
 * bounce). The body is never parsed.
 */
describe('checkSessionStatus', () => {
  it('returns active on 200', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ active: true }), { status: 200 }));
    await expect(checkSessionStatus(fetchFn as typeof fetch)).resolves.toBe('active');
    expect(fetchFn).toHaveBeenCalledWith(SESSION_STATUS_PATH, {
      method: 'GET',
      credentials: 'same-origin',
    });
  });

  it('returns dead on 401', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    await expect(checkSessionStatus(fetchFn as typeof fetch)).resolves.toBe('dead');
  });

  it('returns error on 503 (lookup failure must not look like expiry)', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), { status: 503 }));
    await expect(checkSessionStatus(fetchFn as typeof fetch)).resolves.toBe('error');
  });

  it('returns error on any other status', async () => {
    const fetchFn = vi.fn(async () => new Response('oops', { status: 500 }));
    await expect(checkSessionStatus(fetchFn as typeof fetch)).resolves.toBe('error');
  });

  it('returns error (never throws) when fetch itself throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(checkSessionStatus(fetchFn as typeof fetch)).resolves.toBe('error');
  });

  it('pins the check timing constants', () => {
    // 5-minute interval, 1-minute focus throttle (spec §2.2).
    expect(SESSION_CHECK_INTERVAL_MS).toBe(300_000);
    expect(SESSION_CHECK_FOCUS_THROTTLE_MS).toBe(60_000);
  });
});
