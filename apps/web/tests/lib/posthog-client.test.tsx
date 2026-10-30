import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Browser PostHog client suite (jsdom project — initPostHog requires
 * window). posthog-js is mocked at the module boundary; the real
 * lib/posthog.ts code runs, including host normalization, the
 * load-promise queueing, and the no-op-until-init guards.
 *
 * The bug pinned here: init used to pass POSTHOG_HOST verbatim, so
 * "US" became request host `US`. The first test fails on the old
 * code (api_host would be "US") and passes on the new code.
 */

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
    lib.initPostHog('test-key', 'US');
    await flush();
    expect(instance.init).toHaveBeenCalledWith(
      'test-key',
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
    lib.initPostHog(undefined, 'US');
    await flush();
    expect(instance.init).not.toHaveBeenCalled();
  });

  it('is a no-op on repeat calls', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog('test-key', 'US');
    lib.initPostHog('other-key', 'EU');
    await flush();
    expect(instance.init).toHaveBeenCalledTimes(1);
  });
});

describe('identifyUser', () => {
  it('identifies with the user id and tenant subdomain only', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog('test-key', 'US');
    lib.identifyUser('user-123', 'acme');
    await flush();
    expect(instance.identify).toHaveBeenCalledWith('user-123', {
      tenant_id: 'acme',
    });
    // No PII: the call carries ids only — no email, no name.
    const props = instance.identify.mock.calls[0][1] as Record<string, unknown>;
    expect(props).not.toHaveProperty('email');
    expect(props).not.toHaveProperty('name');
  });

  it('is a no-op without a user id, and before init', async () => {
    const { lib, instance } = await loadClient();
    lib.identifyUser(undefined, 'acme');
    lib.identifyUser('user-123', 'acme');
    await flush();
    expect(instance.identify).not.toHaveBeenCalled();
  });
});

describe('capturePageview', () => {
  it('captures $pageview with a full $current_url on navigation', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog('test-key', 'US');
    lib.capturePageview('/pages?tab=queue');
    await flush();
    expect(instance.capture).toHaveBeenCalledWith('$pageview', {
      $current_url: 'http://localhost:3000/pages?tab=queue',
    });
  });

  it('is a no-op before init and never throws', async () => {
    const { lib, instance } = await loadClient();
    expect(() => lib.capturePageview('/pages')).not.toThrow();
    await flush();
    expect(instance.capture).not.toHaveBeenCalled();
  });
});

describe('trackEvent', () => {
  it('captures taxonomy events with their properties', async () => {
    const { lib, instance } = await loadClient();
    lib.initPostHog('test-key', 'US');
    lib.trackEvent('page_added', { platform: 'facebook', count: 3 });
    lib.trackEvent('mirror_created', {
      source_platform: 'tiktok',
      target_platform: 'facebook',
    });
    await flush();
    expect(instance.capture).toHaveBeenCalledWith('page_added', {
      platform: 'facebook',
      count: 3,
    });
    expect(instance.capture).toHaveBeenCalledWith('mirror_created', {
      source_platform: 'tiktok',
      target_platform: 'facebook',
    });
  });

  it('drops events issued before init (no-op, never throws)', async () => {
    const { lib, instance } = await loadClient();
    lib.trackEvent('page_added', { platform: 'facebook', count: 1 });
    lib.initPostHog('test-key', 'US');
    await flush();
    // trackEvent before init is a deliberate no-op (no load promise
    // yet) — it must not throw and must not crash the page. Events
    // are only captured once init has started.
    expect(instance.capture).not.toHaveBeenCalled();
  });
});
