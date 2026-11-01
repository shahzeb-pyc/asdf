import { describe, expect, it } from 'vitest';
import {
  getPlatformConnectConfig,
  hasPlatformConnectConfig,
} from '@/lib/connect/registry';
import { createInstagramConnectConfig } from '@/lib/connect/platforms/instagram';

/**
 * Framework Instagram removal guard (2026-11-02): the old framework
 * Instagram flow was deleted — the Instagram platform module must no
 * longer register a framework connect config on import, while the
 * direct callback's exchange factory must stay intact (the direct
 * flow builds its exchange from it, not from the registry).
 *
 * NOTE: this file deliberately does NOT clear the registry first —
 * clearing would erase a re-added side effect and make the first test
 * pass vacuously. Vitest isolates modules per test file, so the
 * registry here contains exactly what this file's imports registered
 * (nothing, after the removal).
 *
 * If someone re-adds the module side-effect registration, the first
 * test here fails. The framework initiate/callback then resolve no
 * Instagram config and fail cleanly (error redirect / notice
 * redirect), which the framework handlers already implement.
 */
describe('Instagram framework flow removal', () => {
  it('importing the Instagram platform module registers no framework config', () => {
    expect(hasPlatformConnectConfig('instagram')).toBe(false);
    expect(getPlatformConnectConfig('instagram')).toBeNull();
  });

  it('the direct flow exchange factory is still intact', () => {
    const config = createInstagramConnectConfig();
    expect(config.platform).toBe('instagram');
    expect(typeof config.exchangeCode).toBe('function');
    expect(typeof config.fetchDestinations).toBe('function');
  });
});
