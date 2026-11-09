/**
 * Regression tests for the five classifier branches fixed by the ADU
 * statuses build (spec §3.1): checkpoint codes misrouted to invalid
 * token / rate limited, the 400/4854002 checkpoint losing its meaning,
 * and the two app-bug codes (190/2069032, 3) misrouted to auth / the
 * retryable fallback. Each test pins the NEW behaviour — reintroducing
 * the old routing fails it. The unchanged branches are pinned too, so
 * a fix here cannot silently move another code.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGraphApiError } from './facebook-health.js';

describe('evaluateGraphApiError — ADU statuses fixes', () => {
  it('190/459 (user checkpointed) is a page checkpoint, not invalid token', () => {
    const result = evaluateGraphApiError(190, 459);
    expect(result).not.toBeNull();
    expect(result?.pageStatus).toBe('page_checkpoint');
    expect(result?.accountStatus).toBe('active');
    expect(result?.requiresManualVerification).toBe(true);
    expect(result?.requiresReauth).toBe(false);
    expect(result?.isTransient).toBe(false);
  });

  it('190/464 (unconfirmed user) is a page checkpoint, not invalid token', () => {
    const result = evaluateGraphApiError(190, 464);
    expect(result).not.toBeNull();
    expect(result?.pageStatus).toBe('page_checkpoint');
    expect(result?.accountStatus).toBe('active');
    expect(result?.requiresManualVerification).toBe(true);
    expect(result?.requiresReauth).toBe(false);
    expect(result?.isTransient).toBe(false);
  });

  it('368/1404078 (Publishing Authorization incomplete) is a page checkpoint, not rate limited', () => {
    const result = evaluateGraphApiError(368, 1404078);
    expect(result).not.toBeNull();
    expect(result?.pageStatus).toBe('page_checkpoint');
    expect(result?.accountStatus).toBe('active');
    expect(result?.requiresManualVerification).toBe(true);
    expect(result?.requiresReauth).toBe(false);
    expect(result?.isTransient).toBe(false);
  });

  it('400/4854002 is the same checkpoint as 368/4854002', () => {
    const result = evaluateGraphApiError(400, 4854002);
    expect(result).not.toBeNull();
    expect(result?.pageStatus).toBe('page_checkpoint');
    expect(result?.accountStatus).toBe('active');
    expect(result?.requiresManualVerification).toBe(true);
    expect(result?.requiresReauth).toBe(false);
    expect(result?.isTransient).toBe(false);
  });

  it('368/1404102 (link against Community Standards) is a permanent post failure, not rate limited', () => {
    const result = evaluateGraphApiError(368, 1404102);
    expect(result).not.toBeNull();
    expect(result?.pageStatus).toBe('active');
    expect(result?.accountStatus).toBe('active');
    expect(result?.requiresManualVerification).toBeUndefined();
    expect(result?.requiresReauth).toBe(false);
    expect(result?.isTransient).toBe(false);
    expect(result?.message).toContain('Community Standards');
  });

  it('382 and 1363040 have no classifier branch (no status flip; the publisher owns them as permanent)', () => {
    expect(evaluateGraphApiError(382)).toBeNull();
    expect(evaluateGraphApiError(1363040)).toBeNull();
  });

  it('190/2069032 (wrong token type) is active/active, non-transient, no reauth', () => {
    const result = evaluateGraphApiError(190, 2069032);
    expect(result).not.toBeNull();
    expect(result?.pageStatus).toBe('active');
    expect(result?.accountStatus).toBe('active');
    expect(result?.isTransient).toBe(false);
    expect(result?.requiresReauth).toBe(false);
  });

  it('code 3 (API Method) is active/active, non-transient, no reauth', () => {
    const result = evaluateGraphApiError(3);
    expect(result).not.toBeNull();
    expect(result?.pageStatus).toBe('active');
    expect(result?.accountStatus).toBe('active');
    expect(result?.isTransient).toBe(false);
    expect(result?.requiresReauth).toBe(false);
  });
});

describe('evaluateGraphApiError — unchanged branches stay put', () => {
  it('generic 190 is still invalid token + expired + reauth', () => {
    const result = evaluateGraphApiError(190);
    expect(result?.pageStatus).toBe('invalid_token');
    expect(result?.accountStatus).toBe('expired');
    expect(result?.requiresReauth).toBe(true);
  });

  it('190/458, 190/460, 190/463 are still invalid token + expired', () => {
    for (const subcode of [458, 460, 463]) {
      const result = evaluateGraphApiError(190, subcode);
      expect(result?.pageStatus).toBe('invalid_token');
      expect(result?.accountStatus).toBe('expired');
      expect(result?.requiresReauth).toBe(true);
    }
  });

  it('190/492 keeps the account active but still requires reauth', () => {
    const result = evaluateGraphApiError(190, 492);
    expect(result?.pageStatus).toBe('invalid_token');
    expect(result?.accountStatus).toBe('active');
    expect(result?.requiresReauth).toBe(true);
  });

  it('default 368 and 368/1390008 are still rate limited and transient', () => {
    for (const subcode of [undefined, 1390008]) {
      const result = evaluateGraphApiError(368, subcode);
      expect(result?.pageStatus).toBe('fb_rate_limited');
      expect(result?.isTransient).toBe(true);
    }
  });

  it('368/4854002 is still a page checkpoint', () => {
    const result = evaluateGraphApiError(368, 4854002);
    expect(result?.pageStatus).toBe('page_checkpoint');
    expect(result?.requiresManualVerification).toBe(true);
  });

  it('10 and 200 are still invalid token + expired + reauth', () => {
    for (const code of [10, 200]) {
      const result = evaluateGraphApiError(code);
      expect(result?.pageStatus).toBe('invalid_token');
      expect(result?.accountStatus).toBe('expired');
      expect(result?.requiresReauth).toBe(true);
    }
  });

  it('506 stays active/active and non-transient', () => {
    const result = evaluateGraphApiError(506);
    expect(result?.pageStatus).toBe('active');
    expect(result?.accountStatus).toBe('active');
    expect(result?.isTransient).toBe(false);
  });
});
