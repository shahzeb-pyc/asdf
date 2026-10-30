import { describe, it, expect, vi } from 'vitest';
import {
  MediaDownloaderError,
  fetchCandidateResponse,
  resolveCandidatesBuiltIn,
  validateAndNormalizeStreamUrl,
} from '../src/index.js';

function response(
  body: string | null,
  options: { status?: number; headers?: Record<string, string>; url?: string } = {}
): Response {
  const res = new Response(body, {
    status: options.status ?? 200,
    headers: options.headers,
  });
  if (options.url) {
    Object.defineProperty(res, 'url', { value: options.url });
  }
  return res;
}

describe('validateAndNormalizeStreamUrl', () => {
  it('accepts a public URL and rejects private/unsafe ones', () => {
    expect(validateAndNormalizeStreamUrl('https://cdn.example.com/v.mp4')).toBe(
      'https://cdn.example.com/v.mp4'
    );
    expect(() => validateAndNormalizeStreamUrl('http://127.0.0.1/v.mp4')).toThrow(
      MediaDownloaderError
    );
    expect(() => validateAndNormalizeStreamUrl('not a url')).toThrow(MediaDownloaderError);
    try {
      validateAndNormalizeStreamUrl('http://127.0.0.1/v.mp4');
      expect.unreachable();
    } catch (error) {
      expect((error as MediaDownloaderError).code).toBe('UNSAFE_URL');
    }
  });
});

describe('fetchCandidateResponse', () => {
  it('returns a prefetched response untouched', async () => {
    const pre = response('bytes', { headers: { 'content-type': 'video/mp4' } });
    const out = await fetchCandidateResponse('https://cdn.example.com/v.mp4', fetch, pre);
    expect(out).toBe(pre);
  });

  it('fetches, then rejects an unsafe redirect target', async () => {
    const fetchFn = vi.fn(async () =>
      response('bytes', { url: 'http://169.254.169.254/latest' })
    );
    await expect(
      fetchCandidateResponse('https://cdn.example.com/v.mp4', fetchFn as never)
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('rejects a non-ok response and wraps a fetch failure as DOWNLOAD_FAILED', async () => {
    const notOk = vi.fn(async () => response('nope', { status: 404 }));
    await expect(
      fetchCandidateResponse('https://cdn.example.com/v.mp4', notOk as never)
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', statusCode: 502 });

    const failing = vi.fn(async () => {
      throw new Error('conn refused');
    });
    await expect(
      fetchCandidateResponse('https://cdn.example.com/v.mp4', failing as never)
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });
});

describe('resolveCandidatesBuiltIn', () => {
  it('returns the prefetched response for a direct media content-type', async () => {
    const fetchFn = vi.fn(async () =>
      response('bytes', {
        headers: { 'content-type': 'video/mp4' },
        url: 'https://cdn.example.com/clip.mp4',
      })
    );
    const out = await resolveCandidatesBuiltIn(
      new URL('https://cdn.example.com/clip.mp4'),
      'direct',
      fetchFn as never
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]?.streamUrl).toBe('https://cdn.example.com/clip.mp4');
    expect(out.prefetchedBinaryResponse).toBeDefined();
  });

  it('uses the content-disposition filename for a direct download', async () => {
    const fetchFn = vi.fn(async () =>
      response('bytes', {
        headers: {
          'content-type': 'video/mp4',
          'content-disposition': 'attachment; filename="showreel.mp4"',
        },
        url: 'https://cdn.example.com/dl?id=7',
      })
    );
    const out = await resolveCandidatesBuiltIn(
      new URL('https://cdn.example.com/dl?id=7'),
      'direct',
      fetchFn as never
    );
    expect(out.candidates[0]?.fileName).toBe('showreel.mp4');
  });

  it('parses og:video from an HTML page, preferring video over its poster', async () => {
    const html =
      '<html><head>' +
      '<meta property="og:video" content="https://cdn.example.com/v.mp4">' +
      '<meta property="og:image" content="https://cdn.example.com/i.jpg">' +
      '</head></html>';
    const fetchFn = vi.fn(async () =>
      response(html, {
        headers: { 'content-type': 'text/html' },
        url: 'https://example.com/post/1',
      })
    );
    const out = await resolveCandidatesBuiltIn(
      new URL('https://example.com/post/1'),
      'generic',
      fetchFn as never
    );
    expect(out.candidates.map((c) => c.streamUrl)).toContain('https://cdn.example.com/v.mp4');
    expect(out.prefetchedBinaryResponse).toBeUndefined();
  });

  it('parses og:image from an image-only HTML page', async () => {
    const html =
      '<html><head>' +
      '<meta property="og:image" content="https://cdn.example.com/i.jpg">' +
      '</head></html>';
    const fetchFn = vi.fn(async () =>
      response(html, {
        headers: { 'content-type': 'text/html' },
        url: 'https://example.com/post/2',
      })
    );
    const out = await resolveCandidatesBuiltIn(
      new URL('https://example.com/post/2'),
      'generic',
      fetchFn as never
    );
    expect(out.candidates.map((c) => c.streamUrl)).toContain('https://cdn.example.com/i.jpg');
  });

  it('parses a JSON payload body into candidates', async () => {
    const fetchFn = vi.fn(async () =>
      response(JSON.stringify({ url: 'https://cdn.example.com/v.mp4', caption: 'hi' }), {
        headers: { 'content-type': 'application/json' },
        url: 'https://api.example.com/resolve',
      })
    );
    const out = await resolveCandidatesBuiltIn(
      new URL('https://api.example.com/resolve'),
      'generic',
      fetchFn as never
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]?.streamUrl).toBe('https://cdn.example.com/v.mp4');
    expect(out.candidates[0]?.caption).toBe('hi');
  });

  it('returns no candidates when a page body exceeds the resolve cap', async () => {
    const big = 'x'.repeat(100);
    const fetchFn = vi.fn(async () =>
      response(big, {
        headers: { 'content-type': 'text/html', 'content-length': '999999999' },
        url: 'https://example.com/big',
      })
    );
    const out = await resolveCandidatesBuiltIn(
      new URL('https://example.com/big'),
      'generic',
      fetchFn as never
    );
    expect(out.candidates).toEqual([]);
  });

  it('falls back to FxTwitter for an X link with no HTML candidates', async () => {
    const fetchFn = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.fxtwitter.com')) {
        return response(JSON.stringify({ url: 'https://cdn.example.com/tweet.mp4' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return response('<html><head></head><body>no media</body></html>', {
        headers: { 'content-type': 'text/html' },
        url: 'https://x.com/user/status/123456789',
      });
    });
    const out = await resolveCandidatesBuiltIn(
      new URL('https://x.com/user/status/123456789'),
      'x',
      fetchFn as never
    );
    expect(out.candidates.map((c) => c.streamUrl)).toContain('https://cdn.example.com/tweet.mp4');
  });

  it('falls back to FxTwitter when the X page itself fails to load', async () => {
    const fetchFn = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.fxtwitter.com')) {
        return response(JSON.stringify({ url: 'https://cdn.example.com/tweet2.mp4' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return response('gone', { status: 404 });
    });
    const out = await resolveCandidatesBuiltIn(
      new URL('https://x.com/user/status/987654321'),
      'x',
      fetchFn as never
    );
    expect(out.candidates.map((c) => c.streamUrl)).toContain('https://cdn.example.com/tweet2.mp4');
  });

  it('throws DOWNLOAD_FAILED for a non-ok page on a non-X platform', async () => {
    const fetchFn = vi.fn(async () => response('gone', { status: 404 }));
    await expect(
      resolveCandidatesBuiltIn(new URL('https://example.com/post/9'), 'generic', fetchFn as never)
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('throws DOWNLOAD_FAILED when the initial fetch itself fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('dns fail');
    });
    await expect(
      resolveCandidatesBuiltIn(new URL('https://example.com/post/9'), 'generic', fetchFn as never)
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', statusCode: 502 });
  });

  it('rejects an unsafe redirect target on the initial response', async () => {
    const fetchFn = vi.fn(async () =>
      response('bytes', { url: 'http://10.0.0.5/v.mp4' })
    );
    await expect(
      resolveCandidatesBuiltIn(new URL('https://cdn.example.com/v.mp4'), 'direct', fetchFn as never)
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });
});
