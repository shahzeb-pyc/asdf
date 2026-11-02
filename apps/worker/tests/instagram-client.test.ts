import { describe, expect, it } from 'vitest';
import { InstagramPublishClient } from '../src/instagram-client.js';

describe('InstagramPublishClient default fetch binding (workerd receiver check)', () => {
  it('publishes through the default fetch even when the runtime brand-checks fetch', async () => {
    const originalFetch = globalThis.fetch;
    const seenReceivers: unknown[] = [];
    function workerdLikeFetch(
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      seenReceivers.push(this);
      // Mimic workerd: native fetch rejects any receiver that is
      // neither a bare call (undefined under strict mode) nor
      // globalThis. Pre-fix code calls the stored fetch as a method
      // on the client, so this test fails on pre-fix code.
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          'Illegal invocation: function called with incorrect `this` reference.',
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'ig_media_999' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    globalThis.fetch = workerdLikeFetch as unknown as typeof fetch;
    try {
      // No fetchFn injected: the client must use the default fetch path.
      const client = new InstagramPublishClient();
      const result = await client.publishContainer({
        igUserId: 'ig-user-123',
        accessToken: 'ig-access-token',
        containerId: 'container_123',
      });
      expect(result.mediaId).toBe('ig_media_999');
      expect(seenReceivers.length).toBeGreaterThan(0);
      for (const receiver of seenReceivers) {
        expect(receiver === undefined || receiver === globalThis).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
