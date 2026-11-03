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

describe('resolveTikwmStream', () => {
  it('returns null on API non-200', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 })) as unknown as FetchImpl;
    expect(await resolveTikwmStream('https://www.tiktok.com/@u/video/1', fetchImpl)).toBeNull();
  });

  it('returns null on bad code, missing data, or no stream URL', async () => {
    for (const body of [
      { code: 1, data: { play: 'https://cdn.example/v.mp4' } },
      { code: 0 },
      { code: 0, data: {} },
      { code: 0, data: { title: 'x' } },
    ]) {
      const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as FetchImpl;
      expect(await resolveTikwmStream('https://www.tiktok.com/@u/video/1', fetchImpl)).toBeNull();
    }
  });

  it('prefers hdplay over play and keeps the title', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { hdplay: 'https://cdn.example/hd.mp4', play: 'https://cdn.example/sd.mp4', title: 'Hi' } }),
    ) as unknown as FetchImpl;
    const res = await resolveTikwmStream('https://www.tiktok.com/@u/video/1', fetchImpl);
    expect(res).toEqual({ streamUrl: 'https://cdn.example/hd.mp4', rawTitle: 'Hi' });
  });

  it('falls back to play and prefixes relative URLs', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { play: '/video/abc.mp4', title: null } }),
    ) as unknown as FetchImpl;
    const res = await resolveTikwmStream('https://www.tiktok.com/@u/video/1', fetchImpl);
    expect(res).toEqual({ streamUrl: 'https://www.tikwm.com/video/abc.mp4', rawTitle: null });
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

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as FetchImpl;
    expect(await resolveTikwmStream('https://www.tiktok.com/@u/video/1', fetchImpl)).toBeNull();
  });
});

describe('openVideoStream', () => {
  it('returns null on non-200 and the body on 200', async () => {
    const bad = vi.fn(async () => new Response('no', { status: 404 })) as unknown as FetchImpl;
    expect(await openVideoStream('https://cdn.example/v.mp4', bad)).toBeNull();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
    const good = vi.fn(async () => new Response(body, { status: 200 })) as unknown as FetchImpl;
    const stream = await openVideoStream('https://cdn.example/v.mp4', good);
    expect(stream).not.toBeNull();
  });
});
