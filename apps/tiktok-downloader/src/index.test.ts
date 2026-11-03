import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function rpcMock(url: string): Promise<Response> {
  if (url.includes('reset_stale_adu_reel_downloads')) {
    return Promise.resolve(new Response(JSON.stringify(0), { status: 200 }));
  }
  if (url.includes('claim_tiktok_buffer_downloads')) {
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

const FULL_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  R2_PUBLIC_URL: 'https://media.example.test',
  ADU_BUFFER: {},
} as unknown as Env;

describe('tiktok-downloader worker entry', () => {
  it('runs an empty tick through the scheduled handler', async () => {
    vi.stubGlobal('fetch', vi.fn(rpcMock));
    const waitUntil = vi.fn();
    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        FULL_ENV,
        { waitUntil } as unknown as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('runs without waitUntil when the context lacks it', async () => {
    vi.stubGlobal('fetch', vi.fn(rpcMock));
    await expect(
      worker.scheduled({} as ScheduledEvent, FULL_ENV, {} as unknown as ExecutionContext),
    ).resolves.toBeUndefined();
  });

  it('runs the scheduled tick through a workerd-brand-checked fetch', async () => {
    // Same brand check as supabase.test.ts, exercised through the
    // production scheduled wiring: the SupabaseRpc default and the
    // pipeline injection must both call fetch without a client
    // receiver, or the tick dies with "Illegal invocation" in workerd.
    const brandCheckedRpcMock = function (this: unknown, url: string): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new Error('Illegal invocation: function called with incorrect `this` reference');
      }
      return rpcMock(url);
    };
    vi.stubGlobal('fetch', brandCheckedRpcMock);
    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        FULL_ENV,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails loudly when required secrets are missing', async () => {
    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        {} as Env,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    ).rejects.toThrow('missing required secrets');
  });

  it('answers non-cron requests with 404', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/'),
      FULL_ENV,
      {} as unknown as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });
});
