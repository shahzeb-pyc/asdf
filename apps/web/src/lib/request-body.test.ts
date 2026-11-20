/**
 * `enforceIpRateLimit` scoping (spec 210): a `scope` replaces the bare-IP
 * key segment, so one workspace's burst does not spend another's budget —
 * and a scoped burst is never charged to the IP bucket. Without a scope
 * the key is exactly as before.
 */
import { describe, beforeEach, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { enforceIpRateLimit } from './request-body';
import { _resetRateLimiter } from './rate-limiter';

function request(ip: string): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    headers: { 'x-real-ip': ip },
  });
}

describe('enforceIpRateLimit', () => {
  beforeEach(() => {
    _resetRateLimiter();
  });

  it('scopes buckets per workspace: separate scopes do not share a budget', async () => {
    expect(await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 2, { scope: 'ws:alpha' })).toBeNull();
    expect(await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 2, { scope: 'ws:alpha' })).toBeNull();
    const limited = await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 2, { scope: 'ws:alpha' });
    expect(limited?.status).toBe(429);
    // A different workspace's bucket is untouched by alpha's burst.
    expect(await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 2, { scope: 'ws:beta' })).toBeNull();
  });

  it('without a scope the bucket stays per-IP (existing behaviour)', async () => {
    expect(await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 1)).toBeNull();
    expect((await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 1))?.status).toBe(429);
    // A different IP gets its own bucket.
    expect(await enforceIpRateLimit(request('5.6.7.8'), 'test_discover', 1)).toBeNull();
  });

  it('a scoped burst is not charged to the IP bucket', async () => {
    expect(await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 1, { scope: 'ws:alpha' })).toBeNull();
    expect((await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 1, { scope: 'ws:alpha' }))?.status).toBe(429);
    expect(await enforceIpRateLimit(request('1.2.3.4'), 'test_discover', 1)).toBeNull();
  });
});
