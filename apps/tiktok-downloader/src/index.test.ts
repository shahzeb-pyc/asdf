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

  it('invokes the scheduled fetch wrapper on a full one-reel tick', async () => {
    // The index.ts wrapper line is only covered when the tick actually
    // downloads: the empty-tick tests create the wrapper but never
    // invoke it. This routes a whole tick through the production
    // wiring (Supabase RPCs + tikwm + video stream + R2 + settle).
    const ftyp = new Uint8Array(16);
    new DataView(ftyp.buffer).setUint32(0, 16);
    new TextEncoder().encodeInto('ftyp', ftyp.subarray(4, 8));
    const videoBody = new Uint8Array(12000);
    videoBody.set(ftyp, 0);
    const markDownloadedHits: string[] = [];
    const fullMock = async (url: string): Promise<Response> => {
      if (url.includes('reset_stale_adu_reel_downloads')) {
        return new Response(JSON.stringify(0), { status: 200 });
      }
      if (url.includes('claim_tiktok_buffer_downloads')) {
        return new Response(
          JSON.stringify([
            {
              reel_id: 'r1',
              config_id: 'c1',
              source_platform: 'tiktok',
              source_username: 'someone',
              source_reel_id: '740123',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('mark_adu_reel_downloaded')) {
        markDownloadedHits.push(url);
        return new Response(null, { status: 204 });
      }
      if (url.includes('mark_adu_reel_download_failed')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('tikwm.com/api')) {
        return new Response(
          JSON.stringify({ code: 0, data: { play: 'https://cdn.example/v.mp4', title: 'My day' } }),
          { status: 200 },
        );
      }
      return new Response(videoBody as unknown as BodyInit, { status: 200 });
    };
    vi.stubGlobal('fetch', vi.fn(fullMock));
    // The pipeline only counts bytes the R2 put actually drains from
    // the upload stream, so this fake must read it to completion like
    // the real R2 put does — a no-op put would report size 0.
    const r2put = vi.fn(async (_key: string, value: ReadableStream<Uint8Array>) => {
      const reader = value.getReader();
      for (;;) {
        const res = await reader.read();
        if (res.done) break;
      }
      return {};
    });
    const env = { ...FULL_ENV, ADU_BUFFER: { put: r2put, delete: vi.fn(async () => ({})) } } as unknown as Env;
    await expect(
      worker.scheduled({} as ScheduledEvent, env, { waitUntil: () => {} } as unknown as ExecutionContext),
    ).resolves.toBeUndefined();
    expect(r2put).toHaveBeenCalledOnce();
    expect(r2put.mock.calls[0][0]).toBe('adu-buffer/c1/r1.mp4');
    expect(markDownloadedHits).toHaveLength(1);
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
