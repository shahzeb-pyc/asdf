import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server-side product-event suite — same fake-client pattern as
 * tests/lib/server-analytics.test.ts (the fake must be a real class:
 * the module constructs it with `new PostHog(...)`). Covers the new
 * trackServerEvent helper only; the $exception paths keep their own
 * suite. No network call is made.
 */

const TEST_KEY = 'test-key';
const USER_ID = 'user-123';
const PLATFORM = 'facebook';
const ENV_KEY = 'POSTHOG_KEY';

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
    vi.stubEnv(ENV_KEY, TEST_KEY);
    const { trackServerEvent } = await loadModule();
    await trackServerEvent('post_queued', USER_ID, {
      platform: PLATFORM,
      post_type: 'text',
    });
    const call = lastClient().capture.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(call.distinctId).toBe(USER_ID);
    expect(call.event).toBe('post_queued');
    expect(call.properties).toEqual({
      platform: PLATFORM,
      post_type: 'text',
    });
    expect(lastClient().flush).toHaveBeenCalled();
  });

  it('is a no-op without a key and never constructs a client', async () => {
    vi.stubEnv(ENV_KEY, '');
    const { trackServerEvent } = await loadModule();
    const before = instances.length;
    await trackServerEvent('page_added', USER_ID, {
      platform: PLATFORM,
      count: 2,
    });
    expect(instances.length).toBe(before);
  });

  it('normalizes a bare region host instead of sending it verbatim', async () => {
    vi.stubEnv(ENV_KEY, TEST_KEY);
    vi.stubEnv('POSTHOG_HOST', 'US');
    const { trackServerEvent } = await loadModule();
    await trackServerEvent('mirror_created', USER_ID, {
      source_platform: 'tiktok',
      target_platform: PLATFORM,
    });
    const options = lastClient().ctorArgs[1] as Record<string, unknown>;
    expect(options.host).toBe('https://us.i.posthog.com');
  });

  it('never throws when capture itself throws', async () => {
    vi.stubEnv(ENV_KEY, TEST_KEY);
    const { trackServerEvent } = await loadModule();
    // First call constructs the client; the second throws inside capture.
    await trackServerEvent('media_uploaded', USER_ID, {
      media_type: 'image',
    });
    lastClient().capture.mockImplementationOnce(() => {
      throw new Error('posthog down');
    });
    await expect(
      trackServerEvent('media_uploaded', USER_ID, {
        media_type: 'image',
      })
    ).resolves.toBeUndefined();
  });
});
