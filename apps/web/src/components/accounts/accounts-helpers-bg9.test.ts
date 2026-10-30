/**
 * Audit BG9 — Connect click routing by BYOC check state.
 *
 * A failed check (error, configuration unknown) must route to a
 * retry, never to the credentials prompt that implies the App
 * ID/Secret are missing. A successful check routes to Connect
 * when configured and to the prompt only when it confirms
 * credentials are missing.
 */
import { describe, expect, it } from 'vitest';
import { resolveConnectClick } from '@/components/accounts/accounts-helpers';

describe('resolveConnectClick (BG9)', () => {
  it('routes a failed check with unknown configuration to retry, not the prompt', () => {
    expect(
      resolveConnectClick({ isConfigured: false, error: 'check failed' })
    ).toBe('retry');
  });

  it('routes configured credentials to Connect, even with a failed re-check', () => {
    expect(
      resolveConnectClick({ isConfigured: true, error: 'check failed' })
    ).toBe('connect');
  });

  it('routes a successful check with missing credentials to the prompt', () => {
    expect(resolveConnectClick({ isConfigured: false, error: null })).toBe(
      'prompt'
    );
  });

  it('routes configured credentials with a clean check to Connect', () => {
    expect(resolveConnectClick({ isConfigured: true, error: null })).toBe(
      'connect'
    );
  });
});
