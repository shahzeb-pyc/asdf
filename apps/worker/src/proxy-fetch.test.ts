/**
 * Tests for the Worker proxy fetch (spec 150). All network is stubbed
 * via a fake `connect` — no live sockets, no real proxy, no secrets.
 * The only credentials used are fake fixtures (`user:pass` against
 * `proxy.test`); nothing here is a real proxy URL.
 */
import { describe, expect, it, vi } from 'vitest';
import { InternalError, resolveTikwmVideo } from '@fbuploadpro/contracts';
import {
  createProxyFetchFn,
  parseProxyUrl,
  type TunnelConnectFn,
  type TunnelSocket,
} from './proxy-fetch.js';

const FAKE_PROXY_URL = 'http://user:pass@proxy.test:8080';

/**
 * Sentinel proxy credential (fake fixture, never a real value) used to
 * prove no upstream error message escapes with the credential intact.
 * Every form the credential can take: raw `user:pass`, host, full URL,
 * base64(user:pass) as sent in `Proxy-Authorization`, and the
 * URL-encoded auth. The leak tests below embed ALL of them in the
 * stubbed upstream error — each test fails if the redaction is
 * removed (same pattern as the scraper's redaction tests, PR #173).
 */
const SENTINEL_PROXY_URL = 'http://sentinel-user:sentinel-pass@sentinel-proxy.test:8080';
const SENTINEL_AUTH = 'sentinel-user:sentinel-pass';
const SENTINEL_BASE64 = btoa(SENTINEL_AUTH);
const SENTINEL_ENCODED_AUTH = encodeURIComponent(SENTINEL_AUTH);
const SENTINEL_ENCODED_BASE64 = btoa(SENTINEL_ENCODED_AUTH);
const SENTINEL_MESSAGE =
  `proxy dial failed for ${SENTINEL_AUTH} at sentinel-proxy.test ` +
  `url ${SENTINEL_PROXY_URL} basic ${SENTINEL_BASE64} ` +
  `encoded ${SENTINEL_ENCODED_AUTH} ${SENTINEL_ENCODED_BASE64}`;
const SENTINEL_FORMS = [
  SENTINEL_AUTH,
  'sentinel-user',
  'sentinel-pass',
  'sentinel-proxy.test',
  SENTINEL_PROXY_URL,
  SENTINEL_BASE64,
  SENTINEL_ENCODED_AUTH,
  SENTINEL_ENCODED_BASE64,
];

/**
 * Assert a proxy fetch attempt fails loudly with an InternalError
 * whose message carries NO sentinel credential form on any path —
 * and still carries the (redacted) diagnostic, so the failure is
 * loud, not swallowed.
 */
async function expectNoSentinelLeak(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(InternalError);
  const message = (thrown as Error).message;
  for (const form of SENTINEL_FORMS) {
    expect(message).not.toContain(form);
  }
  expect(message).toContain('[proxy]');
}

/** Plain socket answering CONNECT 200, with a caller-chosen `startTls`. */
function connectWithTls(
  capture: FakeSocketCapture,
  startTls: TunnelSocket['startTls'],
): TunnelConnectFn {
  return async () => {
    capture.connectTargets.push('sentinel-proxy.test');
    const plain = makeFakeSocket(['HTTP/1.1 200 Connection Established\r\n\r\n'], capture);
    plain.startTls = startTls;
    return plain;
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface FakeSocketCapture {
  written: string[];
  connectTargets: string[];
}

function scriptedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function makeFakeSocket(
  readableChunks: string[],
  capture: FakeSocketCapture,
): TunnelSocket {
  return {
    readable: scriptedStream(readableChunks),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        // Capture eagerly: the code releases the writer without closing it.
        capture.written.push(new TextDecoder().decode(chunk));
      },
    }),
    close: async () => undefined,
    startTls: () => {
      throw new InternalError('startTls must be stubbed by makeFakeConnect');
    },
  };
}

/**
 * A scripted stream that records whether its reader was released.
 * Workerd breaks `startTls()` (TLS write hangs, or "The ReadableStream
 * has been locked to a reader") when the CONNECT reader is still locked,
 * so the fake `startTls` below throws unless the code released it.
 */
function releasableStream(chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  released: () => boolean;
} {
  const stream = scriptedStream(chunks);
  let released = false;
  const getReader = stream.getReader.bind(stream);
  (stream as unknown as { getReader: (...args: unknown[]) => ReadableStreamDefaultReader<Uint8Array> }).getReader =
    (...args: unknown[]) => {
      const reader = (getReader as (...a: unknown[]) => ReadableStreamDefaultReader<Uint8Array>)(...args);
      const releaseLock = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        released = true;
        releaseLock();
      };
      return reader;
    };
  return { stream, released: () => released };
}

/**
 * Stub `connect`: the plain socket answers the CONNECT handshake, and
 * `startTls()` returns a second socket answering the HTTP request.
 * `httpResponses` is a queue of full raw HTTP responses, one per TLS socket.
 */
function makeFakeConnect(
  capture: FakeSocketCapture,
  httpResponses: string[],
): TunnelConnectFn {
  let responseIndex = 0;
  return async ({ hostname }) => {
    capture.connectTargets.push(hostname);
    const connectResponse = releasableStream(['HTTP/1.1 200 Connection Established\r\n\r\n']);
    const plain: TunnelSocket = {
      readable: connectResponse.stream,
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          capture.written.push(new TextDecoder().decode(chunk));
        },
      }),
      close: async () => undefined,
      startTls: () => {
        if (!connectResponse.released()) {
          throw new InternalError(
            'startTls with the CONNECT reader still locked (workerd breaks here)',
          );
        }
        return makeFakeSocket(
          [httpResponses[responseIndex++] ?? 'HTTP/1.1 500 Empty\r\nContent-Length: 0\r\n\r\n'],
          capture,
        );
      },
    };
    return plain;
  };
}

function httpJsonResponse(body: unknown, headers: Record<string, string> = {}): string {
  const raw = JSON.stringify(body);
  const lines = ['HTTP/1.1 200 OK', 'Content-Type: application/json', `Content-Length: ${raw.length}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join('\r\n')}\r\n\r\n${raw}`;
}

describe('parseProxyUrl', () => {
  it('parses host, port, and credentials', () => {
    expect(parseProxyUrl(FAKE_PROXY_URL)).toEqual({
      host: 'proxy.test',
      port: 8080,
      auth: 'user:pass',
    });
  });

  it('defaults the port and allows no credentials', () => {
    expect(parseProxyUrl('http://proxy.test')).toEqual({
      host: 'proxy.test',
      port: 80,
      auth: null,
    });
  });

  it('rejects https proxy URLs and garbage', () => {
    expect(parseProxyUrl('https://proxy.test:8080')).toBeNull();
    expect(parseProxyUrl('not a url')).toBeNull();
    expect(parseProxyUrl('')).toBeNull();
  });
});

describe('createProxyFetchFn', () => {
  it('throws at factory time for an invalid proxy URL', () => {
    expect(() => createProxyFetchFn({ proxyUrl: 'https://proxy.test' })).toThrow(
      /not a valid http proxy URL/,
    );
  });

  it('refuses non-https targets without opening a tunnel', async () => {
    const connect = vi.fn(async () => {
      throw new InternalError('must not connect');
    });
    const fetchFn = createProxyFetchFn({ proxyUrl: FAKE_PROXY_URL, connect });
    await expect(fetchFn('http://example.com/video.mp4')).rejects.toThrow(
      /only supports https targets/,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not call connect when the signal is already aborted', async () => {
    const connect = vi.fn(async () => {
      throw new InternalError('must not connect');
    });
    const fetchFn = createProxyFetchFn({ proxyUrl: FAKE_PROXY_URL, connect });
    await expect(
      fetchFn('https://www.tikwm.com/api/', {
        signal: AbortSignal.abort(new Error('cancelled')),
      }),
    ).rejects.toThrow('cancelled');
    expect(connect).not.toHaveBeenCalled();
  });

  it('sends CONNECT with Basic auth, then the HTTP request through the tunnel', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(
        capture,
        [httpJsonResponse({ code: 0, data: { hdplay: 'https://example.com/v.mp4', title: 'T' } })],
      ),
    });
    const res = await fetchFn('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=https%3A%2F%2Fexample.com%2Fv&hd=1',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 0,
      data: { hdplay: 'https://example.com/v.mp4', title: 'T' },
    });
    expect(capture.connectTargets).toEqual(['proxy.test']);
    const written = capture.written.join('');
    expect(written).toContain('CONNECT www.tikwm.com:443 HTTP/1.1');
    // Fake fixture credentials only — `user:pass` base64.
    expect(written).toContain('Proxy-Authorization: Basic dXNlcjpwYXNz');
    expect(written).toContain('POST /api/ HTTP/1.1');
    expect(written).toContain('Host: www.tikwm.com');
    // The proxy URL itself must never appear in the bytes sent.
    expect(written).not.toContain('proxy.test:8080');
  });

  it('parses chunked responses', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const payload = JSON.stringify({
      code: 0,
      data: { video_id: 'vid-1', download_link: 'https://ex.com/v.mp4' },
    });
    const parts = [payload.slice(0, 7), payload.slice(7, 15), payload.slice(15)];
    const chunked =
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' +
      parts.map((part) => `${part.length.toString(16)}\r\n${part}\r\n`).join('') +
      '0\r\n\r\n';
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [chunked]),
    });
    const res = await fetchFn('https://countik.com/api/videoinfo/vid-1');
    expect(await res.json()).toEqual({
      code: 0,
      data: { video_id: 'vid-1', download_link: 'https://ex.com/v.mp4' },
    });
  });

  it('completes when response lines arrive split across segments', async () => {
    // Regression: the pre-fix reader spun forever here — fill() returned
    // true without reading whenever any bytes were buffered, so a status
    // line split across TCP segments looped without ever awaiting the
    // socket, starving the event loop so even the abort timer could not
    // fire. Live symptom: a real-video tikwm resolve wedged after TLS.
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const response = httpJsonResponse({
      code: 0,
      data: { hdplay: 'https://example.com/v.mp4', title: 'Split' },
    });
    const segments = response.match(/.{1,3}/gs) ?? [];
    const connect: TunnelConnectFn = async () => {
      capture.connectTargets.push('proxy.test');
      // CONNECT response split mid-status-line too.
      const plain = makeFakeSocket(['HTTP/1.1 2', '00 Connection Established\r\n\r\n'], capture);
      const tls = makeFakeSocket(segments, capture);
      plain.startTls = () => tls;
      return plain;
    };
    const fetchFn = createProxyFetchFn({ proxyUrl: FAKE_PROXY_URL, connect });
    const res = await fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 0,
      data: { hdplay: 'https://example.com/v.mp4', title: 'Split' },
    });
  });

  it('parses a chunked response with no terminal zero-chunk', async () => {
    // Regression: tikwm closes a chunked response after the last chunk
    // without sending the terminal 0-chunk (live: mindsetbuildupp video
    // 7705157454006357256). EOF at a chunk boundary after a complete
    // chunk is end-of-body, not a truncation.
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const payload = JSON.stringify({
      code: 0,
      data: { hdplay: 'https://example.com/v.mp4', title: 'No terminator' },
    });
    const chunked =
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' +
      `${payload.length.toString(16)}\r\n${payload}\r\n`;
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [chunked]),
    });
    const res = await fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' });
    expect(await res.json()).toEqual({
      code: 0,
      data: { hdplay: 'https://example.com/v.mp4', title: 'No terminator' },
    });
  });

  it('still fails loud on a chunked body truncated mid-chunk', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const chunked =
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '10\r\nabc';
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [chunked]),
    });
    await expect(
      fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }),
    ).rejects.toThrow('proxy response ended early');
  });

  it('still fails loud on a chunked body closed before any chunk', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const chunked = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n';
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [chunked]),
    });
    await expect(
      fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }),
    ).rejects.toThrow('proxy response ended early');
  });

  it('parses chunked responses split across segments', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const payload = JSON.stringify({
      code: 0,
      data: { video_id: 'vid-2', download_link: 'https://ex.com/v.mp4' },
    });
    const chunked =
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' +
      `${payload.length.toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
    const segments = chunked.match(/.{1,3}/gs) ?? [];
    // Split delivery, built directly: the chunk-size line and the body
    // both arrive in pieces.
    const splitConnect: TunnelConnectFn = async () => {
      capture.connectTargets.push('proxy.test');
      const plain = makeFakeSocket(['HTTP/1.1 200 Connection Established\r\n\r\n'], capture);
      const tls = makeFakeSocket(segments, capture);
      plain.startTls = () => tls;
      return plain;
    };
    const splitFetch = createProxyFetchFn({ proxyUrl: FAKE_PROXY_URL, connect: splitConnect });
    const res = await splitFetch('https://countik.com/api/videoinfo/vid-2');
    expect(await res.json()).toEqual({
      code: 0,
      data: { video_id: 'vid-2', download_link: 'https://ex.com/v.mp4' },
    });
  });

  it('fails loud on a non-200 CONNECT, naming the phase and target only', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const connect: TunnelConnectFn = async () => {
      capture.connectTargets.push('proxy.test');
      const plain = makeFakeSocket(
        ['HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'],
        capture,
      );
      plain.startTls = () => {
        throw new InternalError('startTls must not run after a failed CONNECT');
      };
      return plain;
    };
    const fetchFn = createProxyFetchFn({ proxyUrl: FAKE_PROXY_URL, connect });
    await expect(fetchFn('https://countik.com/api/video/exist', { method: 'POST' })).rejects.toThrow(
      'proxy connect to countik.com failed: HTTP 407',
    );
    // No credential or proxy URL leaks into the thrown message.
    await expect(fetchFn('https://countik.com/api/video/exist', { method: 'POST' })).rejects.not.toThrow(
      /proxy\.test|user:pass|dXNlcjpwYXNz/,
    );
  });

  it('redacts the proxy credential when connect() itself throws', async () => {
    // Verifier proof (round 1): connect() throwing an error embedding
    // the credential propagated it verbatim — the thrown message is
    // stored in the DB by the mirror tick and logged by the resolve
    // caller. Fails if the redaction is removed.
    const connect: TunnelConnectFn = async () => {
      throw new InternalError(SENTINEL_MESSAGE);
    };
    const fetchFn = createProxyFetchFn({ proxyUrl: SENTINEL_PROXY_URL, connect });
    await expectNoSentinelLeak(fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }));
  });

  it('redacts the proxy credential when startTls() throws', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const connect = connectWithTls(capture, () => {
      throw new InternalError(SENTINEL_MESSAGE);
    });
    const fetchFn = createProxyFetchFn({ proxyUrl: SENTINEL_PROXY_URL, connect });
    await expectNoSentinelLeak(fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }));
  });

  it('redacts the proxy credential when the TLS writer throws', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const connect = connectWithTls(capture, () => {
      const tls = makeFakeSocket([], capture);
      tls.writable = new WritableStream<Uint8Array>({
        write() {
          throw new InternalError(SENTINEL_MESSAGE);
        },
      });
      return tls;
    });
    const fetchFn = createProxyFetchFn({ proxyUrl: SENTINEL_PROXY_URL, connect });
    await expectNoSentinelLeak(fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }));
  });

  it('redacts the proxy credential when the TLS reader throws', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const connect = connectWithTls(capture, () => {
      const tls = makeFakeSocket([], capture);
      tls.readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(SENTINEL_MESSAGE));
        },
      });
      return tls;
    });
    const fetchFn = createProxyFetchFn({ proxyUrl: SENTINEL_PROXY_URL, connect });
    await expectNoSentinelLeak(fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }));
  });

  it('redacts the proxy credential when the reader throws mid-chunked-body', async () => {
    // Verifier proof (round 1): a mutated malformed-chunk-size error —
    // the reader failing while the chunked body is being read — passed
    // all 16 tests, because only the CONNECT path had a leak assertion.
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const encoder = new TextEncoder();
    const connect = connectWithTls(capture, () => {
      const tls = makeFakeSocket([], capture);
      tls.readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
            ),
          );
          controller.enqueue(encoder.encode('5\r\nhello\r\n'));
          controller.error(new Error(SENTINEL_MESSAGE));
        },
      });
      return tls;
    });
    const fetchFn = createProxyFetchFn({ proxyUrl: SENTINEL_PROXY_URL, connect });
    await expectNoSentinelLeak(fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }));
  });

  it('fails loud on a malformed Content-Length instead of returning an empty 200', async () => {
    // Regression: `Number('abc')` is NaN, `readExact(NaN)` returns an
    // empty body, and proxyFetch returned HTTP 200 with an empty body —
    // fail-silent. Now a malformed length throws.
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n{}',
      ]),
    });
    await expect(
      fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' }),
    ).rejects.toThrow('proxy response has a malformed content-length');
  });

  it('fails loud on a negative Content-Length with an InternalError, not a bare RangeError', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: -5\r\n\r\n{}',
      ]),
    });
    let thrown: unknown;
    try {
      await fetchFn('https://www.tikwm.com/api/', { method: 'POST', body: 'url=x' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternalError);
    expect((thrown as Error).message).toBe('proxy response has a malformed content-length');
  });

  it('routes both resolve steps through the proxy (free, then Countik fallback)', async () => {    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [
        // Free tikwm answers with the throttle message.
        httpJsonResponse({ code: -1, msg: 'Free Api Limit: 1 request/second.' }),
        // Countik exist.
        httpJsonResponse({ data: { video_id: 'vid-9' } }),
        // Countik videoinfo.
        httpJsonResponse({
          data: { download_link: 'https://cdn.example.com/vid-9.mp4', desc: 'Fallback caption' },
        }),
      ]),
    });
    const resolved = await resolveTikwmVideo('https://www.tiktok.com/@someone/video/123', {
      fetchFn: fetchFn as typeof fetch,
    });
    expect(resolved).toEqual({
      playUrl: 'https://cdn.example.com/vid-9.mp4',
      title: 'Fallback caption',
    });
    // Three tunnels: tikwm, Countik exist, Countik videoinfo — all to the proxy.
    expect(capture.connectTargets).toEqual(['proxy.test', 'proxy.test', 'proxy.test']);
    const written = capture.written.join('');
    expect(written).toContain('CONNECT www.tikwm.com:443 HTTP/1.1');
    expect(written).toContain('CONNECT countik.com:443 HTTP/1.1');
    expect(written).toContain('POST /api/video/exist HTTP/1.1');
    expect(written).toContain('GET /api/videoinfo/vid-9 HTTP/1.1');
  });

  it('does not open a tunnel when the free resolve succeeds', async () => {
    const capture: FakeSocketCapture = { written: [], connectTargets: [] };
    const fetchFn = createProxyFetchFn({
      proxyUrl: FAKE_PROXY_URL,
      connect: makeFakeConnect(capture, [
        httpJsonResponse({ code: 0, data: { hdplay: 'https://example.com/v.mp4', title: 'OK' } }),
      ]),
    });
    const resolved = await resolveTikwmVideo('https://www.tiktok.com/@someone/video/123', {
      fetchFn: fetchFn as typeof fetch,
    });
    expect(resolved.playUrl).toBe('https://example.com/v.mp4');
    expect(capture.connectTargets).toEqual(['proxy.test']);
  });
});
