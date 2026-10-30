import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokeFacebookAuthorization } from '@/lib/connect/facebook-revoke';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('revokeFacebookAuthorization (BG10)', () => {
  it('returns true when Graph accepts the revocation', async () => {
    let capturedInit: { headers?: Record<string, string> } | undefined;
    const fetchMock = vi.fn(
      async (_url: string, init?: { headers?: Record<string, string> }) => {
        capturedInit = init;
        return { ok: true } as Response;
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(revokeFacebookAuthorization('user-token')).resolves.toBe(
      true
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v26.0/me/permissions',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(capturedInit?.headers?.Authorization).toBe('Bearer user-token');
  });

  it('returns false (never throws) on a Graph error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    await expect(revokeFacebookAuthorization('user-token')).resolves.toBe(
      false
    );
  });

  it('returns false (never throws) on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    await expect(revokeFacebookAuthorization('user-token')).resolves.toBe(
      false
    );
  });
});
