import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Browser PostHog client suite (jsdom project — initPostHog requires
 * window). posthog-js is mocked at the module boundary; the real
 * lib/posthog.ts code runs, including host normalization, the
 * load-promise queueing, pre-init buffering, and the never-throw guards.
 *
 * The bug pinned here: init used to pass POSTHOG_HOST verbatim, so
 * "US" became request host `US`. The first test fails on the old
 * code (api_host would be "US") and passes on the new code.
 */

const TEST_KEY = 'test-key';
const USER_ID = 'user-123';
const TENANT_ID = 'acme';
const PLATFORM = 'facebook';
const HOST_REGION = 'US';
const PAGE_ADDED_EVENT = 'page_added';

type FakeInstance = {
  init: ReturnType<typeof vi.fn>;
  identify: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
};

const fake = vi.hoisted(() => ({
  instance: null as FakeInstance | null,
}));

vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    identify: vi.fn(),
    capture: vi.fn(),
  },
}));

async function loadClient() {
  vi.resetModules();
  const posthogModule = await import('posthog-js');
  fake.instance = posthogModule.default as unknown as FakeInstance;
  // The vi.mock factory is NOT re-evaluated by resetModules, so the
  // fake's call history leaks across tests in this file — clear it
  // here so each test asserts only its own calls. The lib module
  // itself IS reset (fresh loadStarted/loadPromise per test).
  fake.instance.init.mockClear();
  fake.instance.identify.mockClear();
  fake.instance.capture.mockClear();
  const lib = await import('@/lib/posthog');
  return { lib, instance: fake.instance };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('initPostHog', () => {
  it('normalizes a bare region host and keeps analytics explicit-only', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog(TEST_KEY, HOST_REGION);
    await flush();
    expect(instance.init).toHaveBeenCalledWith(
      TEST_KEY,
      expect.objectContaining({
        api_host: 'https://us.i.posthog.com',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
      })
    );
  });

  it('is a no-op without an API key', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog(undefined, HOST_REGION);
    await flush();
    expect(instance.init).not.toHaveBeenCalled();
  });

  it('is a no-op on repeat calls', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog(TEST_KEY, HOST_REGION);
    lib.initPostHog('other-key', 'EU');
    await flush();
    expect(instance.init).toHaveBeenCalledTimes(1);
  });
});

describe('identifyUser', () => {
  it('identifies with the user id and tenant subdomain only', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog(TEST_KEY, HOST_REGION);
    lib.identifyUser(USER_ID, TENANT_ID);
    await flush();
    expect(instance.identify).toHaveBeenCalledWith(USER_ID, {
      tenant_id: TENANT_ID,
    });
    // No PII: the call carries ids only — no email, no name.
    const props = instance.identify.mock.calls[0][1] as Record<string, unknown>;
    expect(props).not.toHaveProperty('email');
    expect(props).not.toHaveProperty('name');
  });

  it('is a no-op without a user id, and when init never runs', async () => {
    const { lib, instance } = await loadClient();
    lib.identifyUser(undefined, TENANT_ID);
    lib.identifyUser(USER_ID, TENANT_ID);
    await flush();
    // No init ever runs, so the buffered identify is never delivered.
    expect(instance.identify).not.toHaveBeenCalled();
  });
});

describe('capturePageview', () => {
  it('captures $pageview with a full $current_url on navigation', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog(TEST_KEY, HOST_REGION);
    lib.capturePageview('/pages?tab=queue');
    await flush();
    expect(instance.capture).toHaveBeenCalledWith('$pageview', {
      $current_url: 'http://localhost:3000/pages?tab=queue',
    });
  });

  it('never throws before init, and is dropped when init never runs', async () => {
    const { lib, instance } = await loadClient();
    expect(() => lib.capturePageview('/pages')).not.toThrow();
    await flush();
    // No init ever runs, so the buffered pageview is never delivered.
    expect(instance.capture).not.toHaveBeenCalled();
  });
});

describe('trackEvent', () => {
  it('captures taxonomy events with their properties', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog(TEST_KEY, HOST_REGION);
    lib.trackEvent(PAGE_ADDED_EVENT, { platform: PLATFORM, count: 3 });
    lib.trackEvent('mirror_created', {
      source_platform: 'tiktok',
      target_platform: PLATFORM,
    });
    await flush();
    expect(instance.capture).toHaveBeenCalledWith(PAGE_ADDED_EVENT, {
      platform: PLATFORM,
      count: 3,
    });
    expect(instance.capture).toHaveBeenCalledWith('mirror_created', {
      source_platform: 'tiktok',
      target_platform: PLATFORM,
    });
  });

  it('buffers events issued before init and delivers them once init succeeds', async () => {
    const { lib, instance } = await loadClient();
    // Issued before init starts — the mount-order case: child
    // effects (tracker, identify) run before the provider's init
    // effect. These must LAND once init succeeds, not be dropped.
    lib.trackEvent(PAGE_ADDED_EVENT, { platform: PLATFORM, count: 1 });
    lib.initPostHog(TEST_KEY, HOST_REGION);
    await flush();
    expect(instance.capture).toHaveBeenCalledWith(PAGE_ADDED_EVENT, {
      platform: PLATFORM,
      count: 1,
    });
  });
});
