/**
 * @file router-cache.test.ts
 * @description Guards the Next.js router-cache window that makes
 * back/forward navigation reuse the previous page instead of
 * re-fetching its RSC payload and re-running every server
 * prefetch. If these values are removed or zeroed, back-nav
 * silently goes back to fetching everything on every visit.
 */
import { describe, it, expect } from 'vitest';

import nextConfig from '../../next.config';

describe('router cache (back-nav reuse)', () => {
  it('keeps dynamic pages in the router cache for 30s', () => {
    const experimental = (nextConfig as { experimental?: { staleTimes?: { dynamic?: number; static?: number } } })
      .experimental;
    expect(experimental?.staleTimes?.dynamic).toBe(30);
  });

  it('keeps static segments cached longer than dynamic ones', () => {
    const staleTimes = (nextConfig as { experimental?: { staleTimes?: { dynamic?: number; static?: number } } })
      .experimental?.staleTimes;
    expect(staleTimes?.static).toBeGreaterThanOrEqual(
      staleTimes?.dynamic ?? 0
    );
  });
});
