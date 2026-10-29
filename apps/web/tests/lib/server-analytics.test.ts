import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server-side analytics structured-error test (PR #33).
 *
 * The Publish Now logging fix records Facebook Graph diagnostics
 * (code, subcode, step, HTTP status, trace id) as structured PostHog
 * properties instead of collapsing a thrown plain object to
 * "[object Object]". This suite exercises the real module — not a
 * mock of it — including the PostHog capture path, with a fake
 * PostHog client so no network call is made.
 *
 */

type FakeClient = {
  capture: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
};

// The fake must be a real class: the module constructs it with
// `new PostHog(...)`, and an arrow-function mockImplementation is not
// a constructor (the construction then throws inside the fire-and-
// forget capture call and no properties are ever recorded).
const instances = vi.hoisted(() => [] as FakeClient[]);

vi.mock('posthog-node', () => ({
  PostHog: class FakePostHog {
    capture = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    constructor() {
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('logServerError structured diagnostics', () => {
  it('captures Graph fields from an Error with attached diagnostics', async () => {
    vi.stubEnv('POSTHOG_KEY', 'test-key');
    const { logServerError } = await loadModule();
    const error = new Error('feed failed') as Error & {
      code: number;
      subcode: number;
      step: string;
      httpStatus: number;
      fbtraceId: string;
    };
    error.code = 1;
    error.subcode = 2424009;
    error.step = 'feed';
    error.httpStatus = 400;
    error.fbtraceId = 'trace-9';
    const clientsBefore = instances.length;
    logServerError('publish failed', error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(instances.length).toBe(clientsBefore + 1);
    const properties = lastClient().capture.mock.calls[0][0]
      .properties as Record<string, unknown>;
    expect(properties.$exception_message).toBe('feed failed');
    expect(properties.graph_code).toBe(1);
    expect(properties.graph_subcode).toBe(2424009);
    expect(properties.publish_step).toBe('feed');
    expect(properties.http_status).toBe(400);
    expect(properties.fbtrace_id).toBe('trace-9');
  });

  it('falls back to status, drops invalid values, and omits absent fields', async () => {
    vi.stubEnv('POSTHOG_KEY', 'test-key');
    const { logServerError } = await loadModule();
    logServerError('publish failed', {
      code: Number.NaN,
      subcode: Number.POSITIVE_INFINITY,
      step: '',
      status: 503,
      fbtraceId: '',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const properties = lastClient().capture.mock.calls[0][0]
      .properties as Record<string, unknown>;
    expect(properties.http_status).toBe(503);
    expect(properties).not.toHaveProperty('graph_code');
    expect(properties).not.toHaveProperty('graph_subcode');
    expect(properties).not.toHaveProperty('publish_step');
    expect(properties).not.toHaveProperty('fbtrace_id');
  });

  it('uses "Unknown error" for a plain object without a message', async () => {
    vi.stubEnv('POSTHOG_KEY', 'test-key');
    const { logServerError } = await loadModule();
    logServerError('publish failed', { code: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const properties = lastClient().capture.mock.calls[0][0]
      .properties as Record<string, unknown>;
    expect(properties.$exception_message).toBe('Unknown error');
    expect(properties.graph_code).toBe(1);
  });

  it('stringifies a non-object thrown value', async () => {
    vi.stubEnv('POSTHOG_KEY', 'test-key');
    const { logServerError } = await loadModule();
    logServerError('publish failed', 'boom');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const properties = lastClient().capture.mock.calls[0][0]
      .properties as Record<string, unknown>;
    expect(properties.$exception_message).toBe('boom');
    expect(properties).not.toHaveProperty('graph_code');
  });

  it('is a no-op for PostHog when no key is configured', async () => {
    vi.stubEnv('POSTHOG_KEY', '');
    const { logServerError } = await loadModule();
    const clientsBefore = instances.length;
    expect(() =>
      logServerError('publish failed', { code: 1, step: 'feed' })
    ).not.toThrow();
    expect(instances.length).toBe(clientsBefore);
    expect(console.error).toHaveBeenCalledWith(
      'publish failed',
      expect.anything()
    );
  });
});
