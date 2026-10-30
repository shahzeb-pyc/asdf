import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server-side product-event suite — same fake-client pattern as
 * tests/lib/server-analytics.test.ts (the fake must be a real class:
 * the module constructs it with `new PostHog(...)`). Covers the new
 * trackServerEvent helper only; the $exception paths keep their own
 * suite. No network call is made.
 */

type FakeClient = {
  capture: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  ctorArgs: unknown[];
};

const instances = vi.hoisted(() => [] as FakeClient[]);

vi.mock('posthog-node', () => ({
  PostHog: class FakePostHog {
    capture = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    ctorArgs: unknown[] = [];
    constructor(...args: unknown[]) {
      this.ctorArgs = args;
      instances.push(this);
    }
  },
}));

function lastClient(): FakeClient {
  return instances[instances.length - 1];
}

async function loadModule() {
  vi.resetModules();
  return import('@/lib/server-analytics');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('trackServerEvent', () => {
  it('captures the taxonomy event with the user distinctId and flushes', async () => {
    vi.stubEnv('POSTHOG_KEY', 'test-key');
    const { trackServerEvent } = await loadModule();
    await trackServerEvent('post_queued', 'user-123', {
      platform: 'facebook',
      post_type: 'text',
    });
    const call = lastClient().capture.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(call.distinctId).toBe('user-123');
    expect(call.event).toBe('post_queued');
    expect(call.properties).toEqual({
      platform: 'facebook',
      post_type: 'text',
    });
    expect(lastClient().flush).toHaveBeenCalled();
  });

  it('is a no-op without a key and never constructs a client', async () => {
    vi.stubEnv('POSTHOG_KEY', '');
    const { trackServerEvent } = await loadModule();
    const before = instances.length;
    await trackServerEvent('page_added', 'user-123', {
      platform: 'facebook',
      count: 2,
    });
    expect(instances.length).toBe(before);
  });

  it('normalizes a bare region host instead of sending it verbatim', async () => {
    vi.stubEnv('POSTHOG_KEY', 'test-key');
    vi.stubEnv('POSTHOG_HOST', 'US');
    const { trackServerEvent } = await loadModule();
    await trackServerEvent('mirror_created', 'user-123', {
      source_platform: 'tiktok',
      target_platform: 'facebook',
    });
    const options = lastClient().ctorArgs[1] as Record<string, unknown>;
    expect(options.host).toBe('https://us.i.posthog.com');
  });

  it('never throws when capture itself throws', async () => {
    vi.stubEnv('POSTHOG_KEY', 'test-key');
    const { trackServerEvent } = await loadModule();
    // First call constructs the client; the second throws inside capture.
    await trackServerEvent('media_uploaded', 'user-123', {
      media_type: 'image',
    });
    lastClient().capture.mockImplementationOnce(() => {
      throw new Error('posthog down');
    });
    await expect(
      trackServerEvent('media_uploaded', 'user-123', {
        media_type: 'image',
      })
    ).resolves.toBeUndefined();
  });
});
