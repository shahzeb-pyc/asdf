import { describe, it, expect, vi } from 'vitest';
import {
  tryResolveFromFxTwitter,
  tryResolveViaExternalExtractor,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('tryResolveFromFxTwitter', () => {
  it('returns [] when the URL has no status id', async () => {
    const fetchFn = vi.fn();
    await expect(
      tryResolveFromFxTwitter(new URL('https://x.com/user'), fetchFn as never)
    ).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('resolves a status id through the FxTwitter API', async () => {
    const fetchFn = vi.fn(async (input: unknown) => {
      expect(String(input)).toBe('https://api.fxtwitter.com/status/123456789');
      return jsonResponse({ url: 'https://cdn.example.com/fx.mp4' });
    });
    const out = await tryResolveFromFxTwitter(
      new URL('https://x.com/user/status/123456789'),
      fetchFn as never
    );
    expect(out.map((c) => c.streamUrl)).toEqual(['https://cdn.example.com/fx.mp4']);
  });

  it('returns [] on a non-ok, invalid, or failing FxTwitter response', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      tryResolveFromFxTwitter(new URL('https://x.com/u/status/1'), fetchFn as never)
    ).resolves.toEqual([]);

    const badJson = vi.fn(async () => jsonResponse('not json'));
    await expect(
      tryResolveFromFxTwitter(new URL('https://x.com/u/status/1'), badJson as never)
    ).resolves.toEqual([]);

    const failing = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(
      tryResolveFromFxTwitter(new URL('https://x.com/u/status/1'), failing as never)
    ).resolves.toEqual([]);
  });
});

describe('tryResolveViaExternalExtractor', () => {
  it('returns [] when no extractor is configured', async () => {
    const fetchFn = vi.fn();
    await expect(
      tryResolveViaExternalExtractor(null, 'https://example.com/p', fetchFn as never)
    ).resolves.toEqual([]);
    await expect(
      tryResolveViaExternalExtractor('   ', 'https://example.com/p', fetchFn as never)
    ).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs the canonical URL and returns its candidates', async () => {
    let capturedBody: unknown;
    const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({ url: 'https://cdn.example.com/ext.mp4' });
    });
    const out = await tryResolveViaExternalExtractor(
      'https://extractor.example.com/resolve',
      'https://example.com/post/3',
      fetchFn as never
    );
    expect(out.map((c) => c.streamUrl)).toEqual(['https://cdn.example.com/ext.mp4']);
    expect(capturedBody).toEqual({ url: 'https://example.com/post/3' });
  });

  it('returns [] on a non-ok, over-cap, or failing extractor response', async () => {
    const nonOk = vi.fn(async () => jsonResponse({}, 502));
    await expect(
      tryResolveViaExternalExtractor('https://ext.example.com', 'https://example.com/p', nonOk as never)
    ).resolves.toEqual([]);

    const overCap = vi.fn(async () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '999999999' },
      })
    );
    await expect(
      tryResolveViaExternalExtractor(
        'https://ext.example.com',
        'https://example.com/p',
        overCap as never
      )
    ).resolves.toEqual([]);

    const failing = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(
      tryResolveViaExternalExtractor(
        'https://ext.example.com',
        'https://example.com/p',
        failing as never
      )
    ).resolves.toEqual([]);
  });
});
