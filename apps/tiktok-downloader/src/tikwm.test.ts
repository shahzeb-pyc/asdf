import { describe, expect, it, vi } from 'vitest';
import {
  resolveTikwmStream,
  openVideoStream,
  TIKWM_API_URL,
  type FetchImpl,
} from './tikwm.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const VIDEO = 'https://www.tiktok.com/@u/video/1';

describe('resolveTikwmStream', () => {
  it('reports the HTTP status on API non-200', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 })) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, fetchImpl)).toEqual({
      ok: false,
      failure: { reason: 'tikwm_api_http_status', status: 500 },
    });
  });

  it('reports the body code on code != 0', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 11001, data: { play: 'https://cdn.example/v.mp4' } })) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, fetchImpl)).toEqual({
      ok: false,
      failure: { reason: 'tikwm_api_body_code', code: '11001' },
    });
  });

  it('reports missing code as body_code missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { play: 'https://cdn.example/v.mp4' } })) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, fetchImpl)).toEqual({
      ok: false,
      failure: { reason: 'tikwm_api_body_code', code: 'missing' },
    });
  });

  it('reports missing data and missing stream URL distinctly', async () => {
    for (const [body, reason] of [
      [{ code: 0 }, 'tikwm_api_no_data'],
      [{ code: 0, data: {} }, 'tikwm_no_stream_url'],
      [{ code: 0, data: { title: 'x' } }, 'tikwm_no_stream_url'],
    ] as const) {
      const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as FetchImpl;
      expect(await resolveTikwmStream(VIDEO, fetchImpl)).toEqual({
        ok: false,
        failure: { reason },
      });
    }
  });

  it('reports an unparsable body and a non-object body distinctly', async () => {
    const badJson = vi.fn(async () => new Response('{not json', { status: 200 })) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, badJson)).toEqual({
      ok: false,
      failure: { reason: 'tikwm_api_body_unparsable' },
    });
    const stringBody = vi.fn(async () => jsonResponse('nope')) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, stringBody)).toEqual({
      ok: false,
      failure: { reason: 'tikwm_api_bad_body' },
    });
  });

  it('reports a timeout distinctly from other fetch errors', async () => {
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    const timeoutImpl = vi.fn(async () => {
      throw timeoutErr;
    }) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, timeoutImpl)).toEqual({
      ok: false,
      failure: { reason: 'tikwm_api_timeout' },
    });
    const netImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, netImpl)).toEqual({
      ok: false,
      failure: { reason: 'tikwm_api_fetch_error', detail: 'network down' },
    });
  });

  it('prefers hdplay over play and keeps the title', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { hdplay: 'https://cdn.example/hd.mp4', play: 'https://cdn.example/sd.mp4', title: 'Hi' } }),
    ) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, fetchImpl)).toEqual({
      ok: true,
      streamUrl: 'https://cdn.example/hd.mp4',
      rawTitle: 'Hi',
    });
  });

  it('falls back to play and prefixes relative URLs', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { play: '/video/abc.mp4', title: null } }),
    ) as unknown as FetchImpl;
    expect(await resolveTikwmStream(VIDEO, fetchImpl)).toEqual({
      ok: true,
      streamUrl: 'https://www.tikwm.com/video/abc.mp4',
      rawTitle: null,
    });
  });

  it('posts form data with hd=1 to the tikwm endpoint', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 0, data: { play: 'https://cdn.example/v.mp4' } }),
    );
    await resolveTikwmStream('https://www.tiktok.com/@u/video/9', fetchMock as unknown as FetchImpl);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TIKWM_API_URL);
    expect(init.method).toBe('POST');
    const params = new URLSearchParams(init.body as string);
    expect(params.get('url')).toBe('https://www.tiktok.com/@u/video/9');
    expect(params.get('hd')).toBe('1');
  });
});

describe('openVideoStream', () => {
  it('reports the HTTP status on non-200 and the body on 200', async () => {
    const bad = vi.fn(async () => new Response('no', { status: 404 })) as unknown as FetchImpl;
    expect(await openVideoStream('https://cdn.example/v.mp4', bad)).toEqual({
      ok: false,
      failure: { reason: 'stream_http_status', status: 404 },
    });
    expect(bad).toHaveBeenCalledTimes(1);
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
    const good = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': '2' } })) as unknown as FetchImpl;
    const opened = await openVideoStream('https://cdn.example/v.mp4', good);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.body).toBe(body);
      expect(opened.contentLength).toBe(2);
    }
  });

  it('reports a fetch throw with its message after retries exhaust', async () => {
    vi.useFakeTimers();
    try {
      const throwing = vi.fn(async () => {
        throw new Error('conn reset');
      }) as unknown as FetchImpl;
      const pending = openVideoStream('https://cdn.example/v.mp4', throwing);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({
        ok: false,
        failure: { reason: 'stream_fetch_error', detail: 'conn reset' },
      });
      // In-attempt retries: the same open tried 3 times, not 3 attempts.
      expect(throwing).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a 200 with no body', async () => {
    // A Response constructed without a body has a null body in Node.
    const noBody = vi.fn(async () => new Response(null, { status: 200 })) as unknown as FetchImpl;
    expect(await openVideoStream('https://cdn.example/v.mp4', noBody)).toEqual({
      ok: false,
      failure: { reason: 'stream_no_body' },
    });
    expect(noBody).toHaveBeenCalledTimes(1);
  });

  it('retries transient statuses and succeeds when the edge recovers', async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
      const flaky = vi.fn()
        .mockResolvedValueOnce(new Response('no', { status: 525 }))
        .mockResolvedValueOnce(new Response('no', { status: 429 }))
        .mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-length': '2' } })) as unknown as FetchImpl;
      const pending = openVideoStream('https://cdn.example/v.mp4', flaky);
      await vi.advanceTimersByTimeAsync(10_000);
      const opened = await pending;
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(opened.contentLength).toBe(2);
      expect(flaky).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the last failure when transient statuses never recover', async () => {
    vi.useFakeTimers();
    try {
      const failing = vi.fn(async () => new Response('no', { status: 525 })) as unknown as FetchImpl;
      const pending = openVideoStream('https://cdn.example/v.mp4', failing);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({
        ok: false,
        failure: { reason: 'stream_http_status', status: 525 },
      });
      expect(failing).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a deterministic 404', async () => {
    const bad = vi.fn(async () => new Response('no', { status: 404 })) as unknown as FetchImpl;
    expect(await openVideoStream('https://cdn.example/v.mp4', bad)).toEqual({
      ok: false,
      failure: { reason: 'stream_http_status', status: 404 },
    });
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('parses Content-Length only when it is a positive integer', async () => {
    const cases: Array<[string | null, number | null]> = [
      ['123', 123],
      [null, null],
      ['abc', null],
      ['0', null],
      ['-5', null],
      ['12.5', null],
    ];
    for (const [header, expected] of cases) {
      const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: header === null ? {} : { 'content-length': header },
      })) as unknown as FetchImpl;
      const opened = await openVideoStream('https://cdn.example/v.mp4', fetchMock);
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(opened.contentLength).toBe(expected);
    }
  });

  it('sends the tikwm Referer by default and omits it when null', async () => {
    const seen: Array<RequestInit> = [];
    const capture = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }), { status: 200 });
    }) as unknown as FetchImpl;
    await openVideoStream('https://cdn.example/v.mp4', capture);
    expect((seen[0].headers as Record<string, string>).Referer).toBe('https://www.tikwm.com/');
    await openVideoStream('https://v16.tokcdn.com/v.mp4', capture, null);
    expect((seen[1].headers as Record<string, string>).Referer).toBeUndefined();
  });
});

describe('workerd fetch binding defaults', () => {
  // These defaults are only invoked when the caller omits fetchImpl —
  // production always passes one explicitly, so without these tests the
  // default arrows stay uncovered (which is what failed the SonarCloud
  // new-code coverage gate). They also pin the wrapper shape: a bare
  // global fetch read at call time, never a stored reference.
  it('resolveTikwmStream uses the default wrapper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ code: 0, data: { play: 'https://cdn.example/v.mp4', title: 'Hi' } }),
      ),
    );
    try {
      await expect(resolveTikwmStream(VIDEO)).resolves.toEqual({
        ok: true,
        streamUrl: 'https://cdn.example/v.mp4',
        rawTitle: 'Hi',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openVideoStream uses the default wrapper', async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    try {
      const opened = await openVideoStream('https://cdn.example/v.mp4');
      expect(opened.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
