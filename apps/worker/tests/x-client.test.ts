import { describe, expect, it, vi } from 'vitest';
import {
  parseXRateLimitHeaders,
  XApiError,
  XClient,
} from '../src/x-client.js';

// ==========================================
// Helpers
// ==========================================

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string | null;
  form: FormData | null;
}

// ==========================================
// Chunked upload: initialize → append → finalize → poll, streamed
// ==========================================

describe('XClient chunked media upload', () => {
  it('streams segments from the source — appends happen before the source is fully read, and the whole file is never buffered via arrayBuffer/text', async () => {
    const events: string[] = [];
    const appendSizes: number[] = [];
    const appendIndexes: string[] = [];

    // 260 bytes delivered in 30-byte pulls (9 pulls), segment size 100.
    const totalBytes = 260;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        events.push(`pull:${pulls}`);
        const remaining = totalBytes - (pulls - 1) * 30;
        if (remaining <= 0) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(Math.min(30, remaining)).fill(7));
      },
    });
    const sourceResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(totalBytes) }),
      body: stream,
      arrayBuffer: () => Promise.reject(new Error('arrayBuffer must not be called')),
      text: () => Promise.reject(new Error('text must not be called')),
    } as unknown as Response;

    const calls: RecordedCall[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://media.example.com/video.mp4') return sourceResponse;
      const body = init?.body;
      const form = body instanceof FormData ? body : null;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers as Record<string, string> | undefined),
        bodyText: typeof body === 'string' ? body : null,
        form,
      });
      if (url.endsWith('/media/upload/initialize')) {
        return jsonResponse({ data: { id: 'media-42' } });
      }
      if (url.includes('/media/upload/media-42/append')) {
        const media = form?.get('media') as unknown as Blob;
        appendSizes.push(media.size);
        appendIndexes.push(String(form?.get('segment_index')));
        events.push(`append:${appendSizes.length}`);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/media/upload/media-42/finalize')) {
        return jsonResponse({
          data: { id: 'media-42', processing_info: { state: 'pending', check_after_secs: 0 } },
        });
      }
      if (url.includes('/media/upload?media_id=media-42')) {
        return jsonResponse({ data: { processing_info: { state: 'succeeded' } } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const client = new XClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      segmentSizeBytes: 100,
      sleepFn: async () => {},
    });
    const result = await client.uploadMediaChunked('token-1', {
      sourceUrl: 'https://media.example.com/video.mp4',
      mediaType: 'video/mp4',
      mediaCategory: 'tweet_video',
    });

    expect(result.mediaId).toBe('media-42');
    // Segments: 100 + 100 + 60, indexed from 0.
    expect(appendSizes).toEqual([100, 100, 60]);
    expect(appendIndexes).toEqual(['0', '1', '2']);
    // Streaming proof: the first append fired before the final pull —
    // the client did not read the whole source before uploading.
    const firstAppendAt = events.indexOf('append:1');
    const lastPull = `pull:${pulls}`;
    expect(firstAppendAt).toBeGreaterThan(-1);
    expect(firstAppendAt).toBeLessThan(events.indexOf(lastPull));
    // Initialize carried the total byte count from Content-Length.
    const init = calls.find((c) => c.url.endsWith('/media/upload/initialize'));
    expect(JSON.parse(init?.bodyText ?? '{}')).toMatchObject({
      media_type: 'video/mp4',
      media_category: 'tweet_video',
      total_bytes: 260,
    });
    // Bearer auth on every API call.
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe('Bearer token-1');
    }
  });

  it('returns immediately after finalize when no processing is pending', async () => {
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === 'https://media.example.com/pic.jpg') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-length': '3' },
        });
      }
      if (url.endsWith('/media/upload/initialize')) return jsonResponse({ data: { id: 'm-1' } });
      if (url.includes('/append')) return new Response(null, { status: 204 });
      if (url.endsWith('/finalize')) return jsonResponse({ data: { id: 'm-1' } });
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new XClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
    });
    const result = await client.uploadMediaChunked('t', {
      sourceUrl: 'https://media.example.com/pic.jpg',
      mediaType: 'image/jpeg',
      mediaCategory: 'tweet_image',
    });
    expect(result.mediaId).toBe('m-1');
    // No status poll was needed.
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('media_id='))).toBe(false);
  });
});

// ==========================================
// Tweets / timeline / me / refresh
// ==========================================

describe('XClient tweets + timeline + token endpoint', () => {
  it('POST /2/tweets carries text, media ids, poll, quote and reply settings', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(
        { data: { id: 'tweet-9', text: 'hi' } },
        {
          headers: {
            'x-rate-limit-limit': '100',
            'x-rate-limit-remaining': '99',
            'x-rate-limit-reset': '1893456000',
          },
        }
      );
    });
    const client = new XClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await client.createTweet('tok', {
      text: 'hi',
      mediaIds: ['m1'],
      poll: { options: ['A', 'B'], durationMinutes: 60 },
      quoteTweetId: 'q1',
      replySettings: 'mentionedUsers',
    });
    expect(result.id).toBe('tweet-9');
    expect(result.rateLimit).toEqual({
      limit: 100,
      remaining: 99,
      resetEpochSeconds: 1893456000,
    });
    expect(sentBody).toEqual({
      text: 'hi',
      media: { media_ids: ['m1'] },
      poll: { options: ['A', 'B'], duration_minutes: 60 },
      quote_tweet_id: 'q1',
      reply_settings: 'mentionedUsers',
    });
  });

  it('reads the user timeline for the D10 verification', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ data: [{ id: 't1', text: 'hello' }, { id: 't2', text: 'other' }] })
    );
    const client = new XClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const { tweets } = await client.getUserTimeline('tok', 'user-7', 10);
    expect(tweets).toEqual([
      { id: 't1', text: 'hello' },
      { id: 't2', text: 'other' },
    ]);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/users/user-7/tweets');
  });

  it('refresh exchanges the refresh token at the token endpoint with Basic auth', async () => {
    let authHeader = '';
    let bodyText = '';
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      authHeader = new Headers(init?.headers as Record<string, string>).get('authorization') ?? '';
      bodyText = String(init?.body);
      return jsonResponse({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 7200,
        token_type: 'bearer',
      });
    });
    const client = new XClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const tokens = await client.refreshAccessToken({
      clientId: 'cid',
      clientSecret: 'csecret',
      refreshToken: 'old-refresh',
    });
    expect(tokens).toEqual({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresIn: 7200,
    });
    expect(authHeader).toBe(`Basic ${btoa('cid:csecret')}`);
    const form = new URLSearchParams(bodyText);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('old-refresh');
  });

  it('maps an API failure to XApiError with status, detail and rate-limit state; duplicate detection works', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' },
        {
          status: 403,
          headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '1893456000' },
        }
      )
    );
    const client = new XClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const err = await client.createTweet('tok', { text: 'dup' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XApiError);
    const apiErr = err as XApiError;
    expect(apiErr.status).toBe(403);
    expect(apiErr.isDuplicateContent()).toBe(true);
    expect(apiErr.rateLimit?.remaining).toBe(0);
  });

  it('parseXRateLimitHeaders returns undefined when no headers are present', () => {
    expect(parseXRateLimitHeaders(new Headers())).toBeUndefined();
    expect(parseXRateLimitHeaders(null)).toBeUndefined();
  });
});

// ==========================================
// Media size caps — rejected BEFORE the initialize call
// (post-merge verification fix: validateXMedia had no enforcement
// call site; the caps now live where the byte count is known)
// ==========================================

describe('XClient media size caps', () => {
  function makeCappedFetch(sourceResponse: Response, apiCalls: string[]) {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.startsWith('https://media.example.com/')) return sourceResponse;
      apiCalls.push(url);
      if (url.endsWith('/media/upload/initialize')) return jsonResponse({ data: { id: 'm-cap' } });
      if (url.includes('/append')) return new Response(null, { status: 204 });
      if (url.endsWith('/finalize')) return jsonResponse({ data: { id: 'm-cap' } });
      throw new Error(`Unexpected URL ${url}`);
    });
  }

  function makeClient(fetchFn: ReturnType<typeof makeCappedFetch>) {
    return new XClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
    });
  }

  it('rejects an oversize image (Content-Length path) with 413 media_too_large and NO initialize call', async () => {
    const apiCalls: string[] = [];
    const source = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
    });
    const err = await makeClient(makeCappedFetch(source, apiCalls))
      .uploadMediaChunked('t', {
        sourceUrl: 'https://media.example.com/big.jpg',
        mediaType: 'image/jpeg',
        mediaCategory: 'tweet_image',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect((err as XApiError).status).toBe(413);
    expect((err as XApiError).errorCode).toBe('media_too_large');
    expect(apiCalls).toEqual([]);
  });

  it('rejects an oversize video (Content-Length path) before any upload traffic', async () => {
    const apiCalls: string[] = [];
    const source = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-length': String(512 * 1024 * 1024 + 1) },
    });
    const err = await makeClient(makeCappedFetch(source, apiCalls))
      .uploadMediaChunked('t', {
        sourceUrl: 'https://media.example.com/big.mp4',
        mediaType: 'video/mp4',
        mediaCategory: 'tweet_video',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect((err as XApiError).errorCode).toBe('media_too_large');
    expect(apiCalls).toEqual([]);
  });

  it('rejects an oversize GIF on the counted (no Content-Length) path, still before initialize', async () => {
    const apiCalls: string[] = [];
    // 17 MiB streamed in 1 MiB chunks, no Content-Length header.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const source = new Response(stream, { status: 200 });
    const err = await makeClient(makeCappedFetch(source, apiCalls))
      .uploadMediaChunked('t', {
        sourceUrl: 'https://media.example.com/big.gif',
        mediaType: 'image/gif',
        mediaCategory: 'tweet_gif',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect((err as XApiError).errorCode).toBe('media_too_large');
    expect(apiCalls).toEqual([]);
  });

  it('allows a file exactly AT the cap (boundary) — initialize proceeds', async () => {
    const apiCalls: string[] = [];
    const source = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    });
    const result = await makeClient(makeCappedFetch(source, apiCalls)).uploadMediaChunked('t', {
      sourceUrl: 'https://media.example.com/exact.jpg',
      mediaType: 'image/jpeg',
      mediaCategory: 'tweet_image',
    });
    expect(result.mediaId).toBe('m-cap');
    expect(apiCalls.some((u) => u.endsWith('/media/upload/initialize'))).toBe(true);
  });
});

describe('XClient default fetch binding (workerd receiver check)', () => {
  it('publishes through the default fetch even when the runtime brand-checks fetch', async () => {
    const originalFetch = globalThis.fetch;
    const seenReceivers: unknown[] = [];
    function workerdLikeFetch(
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      seenReceivers.push(this);
      // Mimic workerd: native fetch rejects any receiver that is
      // neither a bare call (undefined under strict mode) nor
      // globalThis. Pre-fix code calls the stored fetch as a method
      // on the client, so this test fails on pre-fix code.
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          'Illegal invocation: function called with incorrect `this` reference.',
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: 'tweet_999', text: 'hello' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    globalThis.fetch = workerdLikeFetch as unknown as typeof fetch;
    try {
      // No fetchFn injected: the client must use the default fetch path.
      const client = new XClient();
      const result = await client.createTweet('x-access-token', { text: 'hello' });
      expect(result.id).toBe('tweet_999');
      expect(seenReceivers.length).toBeGreaterThan(0);
      for (const receiver of seenReceivers) {
        expect(receiver === undefined || receiver === globalThis).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
