import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { type Env } from '../src/index.js';

/**
 * Dual-read gateway behaviour (spec 259). The origin fetch is stubbed
 * at the global — no live B2 or R2 is ever touched.
 */

function gatewayEnv(overrides: Partial<Env> = {}): Env {
  return {
    B2_FRIENDLY_HOST: 'f003.backblazeb2.com',
    B2_MEDIA_BUCKET: 'fbuploadpro-media-prod',
    B2_BUFFER_BUCKET: 'fbuploadpro-adu-buffer',
    R2_MEDIA_DEV_URL: 'https://pub-media123.r2.dev',
    R2_BUFFER_DEV_URL: 'https://pub-buffer456.r2.dev',
    ...overrides,
  };
}

const ctx = {} as ExecutionContext;

function fetchCalls(fetchMock: ReturnType<typeof vi.fn>): Array<{
  url: string;
  init: RequestInit | undefined;
}> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    init: init as RequestInit | undefined,
  }));
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  if (!headers) return null;
  return headers[name] ?? null;
}

describe('Media gateway dual-read (spec 259)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('B2 hit → 200, body + headers passed through, x-fbup-origin: b2', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('video-bytes', {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '11',
          etag: '"abc123"',
          'cache-control': 'max-age=3600',
        },
      })
    );

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/a.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('video-bytes');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe('11');
    expect(response.headers.get('etag')).toBe('"abc123"');
    expect(response.headers.get('cache-control')).toBe('max-age=3600');
    expect(response.headers.get('x-fbup-origin')).toBe('b2');
    expect(fetchCalls(fetchMock)).toEqual([
      {
        url: 'https://f003.backblazeb2.com/file/fbuploadpro-media-prod/users/u1/media/a.mp4',
        init: expect.objectContaining({ method: 'GET' }),
      },
    ]);
  });

  it('B2 404 → R2 hit → 200, x-fbup-origin: r2', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response('r2-bytes', {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        })
      );

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/old.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('r2-bytes');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('x-fbup-origin')).toBe('r2');
    expect(fetchCalls(fetchMock).map((call) => call.url)).toEqual([
      'https://f003.backblazeb2.com/file/fbuploadpro-media-prod/users/u1/media/old.mp4',
      'https://pub-media123.r2.dev/users/u1/media/old.mp4',
    ]);
  });

  it('B2 410 → R2 fallback, same as 404', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('gone', { status: 410 }))
      .mockResolvedValueOnce(new Response('r2-bytes', { status: 200 }));

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/old.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-fbup-origin')).toBe('r2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('B2 404 → R2 404 → 404 (not 200, not 502)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/gone.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('x-fbup-origin')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('B2 500 → 502, no R2 fetch attempted', async () => {
    fetchMock.mockResolvedValueOnce(new Response('b2 down', { status: 500 }));

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/a.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCalls(fetchMock)[0]?.url).toContain('f003.backblazeb2.com');
  });

  it('B2 fetch throwing (timeout) → 502, no R2 fetch attempted', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/a.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('B2 404 → R2 500 → 502 (fallback failure fails loud)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('r2 down', { status: 500 }));

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/a.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Range header is forwarded to the origin; Content-Range passed through', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('partial-bytes', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 10-19/100',
          'accept-ranges': 'bytes',
          'content-length': '10',
        },
      })
    );

    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/a.mp4', {
        headers: { range: 'bytes=10-19' },
      }),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('partial-bytes');
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('x-fbup-origin')).toBe('b2');
    expect(fetchCalls(fetchMock)).toHaveLength(1);
    expect(header(fetchCalls(fetchMock)[0]?.init, 'range')).toBe('bytes=10-19');
  });

  it('fallback var missing → request needing fallback fails loud (500); B2 hits still work', async () => {
    const env = gatewayEnv({ R2_MEDIA_DEV_URL: undefined });
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const fallbackResponse = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/old.mp4'),
      env,
      ctx
    );

    expect(fallbackResponse.status).toBe(500);
    expect(await fallbackResponse.text()).toMatch(/not configured for fallback reads/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response('video-bytes', { status: 200 }));
    const hitResponse = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/new.mp4'),
      env,
      ctx
    );
    expect(hitResponse.status).toBe(200);
    expect(hitResponse.headers.get('x-fbup-origin')).toBe('b2');
  });

  it('adu host reads the buffer bucket and its R2 fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('buffer-bytes', { status: 200 }));

    const response = await worker.fetch(
      new Request('https://adu.vinsmokemedia.online/adu-buffer/uuid/clip.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('buffer-bytes');
    expect(response.headers.get('x-fbup-origin')).toBe('r2');
    expect(fetchCalls(fetchMock).map((call) => call.url)).toEqual([
      'https://f003.backblazeb2.com/file/fbuploadpro-adu-buffer/adu-buffer/uuid/clip.mp4',
      'https://pub-buffer456.r2.dev/adu-buffer/uuid/clip.mp4',
    ]);
  });

  it('unknown host → 404, no origin fetch', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/users/u1/media/a.mp4'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-GET method → 405, no origin fetch', async () => {
    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/users/u1/media/a.mp4', {
        method: 'POST',
      }),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bare domain (no key) → 404, no origin fetch', async () => {
    const response = await worker.fetch(
      new Request('https://media.vinsmokemedia.online/'),
      gatewayEnv(),
      ctx
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
