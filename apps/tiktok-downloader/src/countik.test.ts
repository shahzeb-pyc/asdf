import { describe, expect, it, vi } from 'vitest';
import {
  resolveCountikStream,
  COUNTIK_VIDEO_BASE_URL,
} from './countik.js';
import type { FetchImpl } from './tikwm.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const VIDEO = 'https://www.tiktok.com/@u/video/740123';

/** Fetch double routing exist/info by URL, capturing inits for assertions. */
function routingFetch(scripts: {
  exist: Response | Error;
  info: Response | Error;
}): { fetchImpl: FetchImpl; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const scripted = url === `${COUNTIK_VIDEO_BASE_URL}/video/exist`
      ? scripts.exist
      : scripts.info;
    if (scripted instanceof Error) throw scripted;
    return scripted;
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

function goodExist(): Response {
  return jsonResponse({ video_id: '740123' });
}

function goodInfo(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    download_link: 'https://v16.tokcdn.com/v.mp4',
    desc: 'My Countik day',
    ...overrides,
  });
}

describe('resolveCountikStream', () => {
  it('resolves exist then info and keeps the description as the title', async () => {
    const { fetchImpl, calls } = routingFetch({ exist: goodExist(), info: goodInfo() });
    await expect(resolveCountikStream(VIDEO, fetchImpl)).resolves.toEqual({
      ok: true,
      streamUrl: 'https://v16.tokcdn.com/v.mp4',
      rawTitle: 'My Countik day',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${COUNTIK_VIDEO_BASE_URL}/video/exist`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ url: VIDEO });
    expect(calls[1].url).toBe(`${COUNTIK_VIDEO_BASE_URL}/videoinfo/740123`);
    // No key, no cookie, no secret header on either call.
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['User-Agent']).toContain('Chrome/120');
    }
  });

  it('accepts the alternate field names and the {data} wrapper', async () => {
    const { fetchImpl } = routingFetch({
      exist: jsonResponse({ data: { videoId: '740123' } }),
      info: jsonResponse({ data: { downloadUrl: 'https://v16.tokcdn.com/v2.mp4', description: 'Alt fields' } }),
    });
    await expect(resolveCountikStream(VIDEO, fetchImpl)).resolves.toEqual({
      ok: true,
      streamUrl: 'https://v16.tokcdn.com/v2.mp4',
      rawTitle: 'Alt fields',
    });
  });

  it('accepts download_url and title, and nulls a missing title', async () => {
    const { fetchImpl } = routingFetch({
      exist: jsonResponse({ aweme_id: '740123' }),
      info: jsonResponse({ download_url: 'https://v16.tokcdn.com/v3.mp4', title: 'Titled' }),
    });
    await expect(resolveCountikStream(VIDEO, fetchImpl)).resolves.toEqual({
      ok: true,
      streamUrl: 'https://v16.tokcdn.com/v3.mp4',
      rawTitle: 'Titled',
    });
    const { fetchImpl: noTitle } = routingFetch({
      exist: jsonResponse({ id: '740123' }),
      info: jsonResponse({ download_link: 'https://v16.tokcdn.com/v4.mp4' }),
    });
    await expect(resolveCountikStream(VIDEO, noTitle)).resolves.toEqual({
      ok: true,
      streamUrl: 'https://v16.tokcdn.com/v4.mp4',
      rawTitle: null,
    });
  });

  it('prefixes a relative download link', async () => {
    const { fetchImpl } = routingFetch({
      exist: goodExist(),
      info: goodInfo({ download_link: '/v/rel.mp4' }),
    });
    await expect(resolveCountikStream(VIDEO, fetchImpl)).resolves.toEqual({
      ok: true,
      streamUrl: 'https://countik.com/v/rel.mp4',
      rawTitle: 'My Countik day',
    });
  });

  it('reports a timeout distinctly from other fetch errors, per step', async () => {
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    const { fetchImpl: existTimeout } = routingFetch({ exist: timeoutErr, info: goodInfo() });
    await expect(resolveCountikStream(VIDEO, existTimeout)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_api_timeout', step: 'exist' },
    });
    const { fetchImpl: infoThrow } = routingFetch({
      exist: goodExist(),
      info: new Error('conn reset'),
    });
    await expect(resolveCountikStream(VIDEO, infoThrow)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_api_fetch_error', step: 'info', detail: 'conn reset' },
    });
  });

  it('reports HTTP status per step before parsing the body', async () => {
    const { fetchImpl: exist403 } = routingFetch({
      exist: new Response('blocked', { status: 403 }),
      info: goodInfo(),
    });
    await expect(resolveCountikStream(VIDEO, exist403)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_api_http_status', step: 'exist', status: 403 },
    });
    const { fetchImpl: info500 } = routingFetch({
      exist: goodExist(),
      info: new Response('err', { status: 500 }),
    });
    await expect(resolveCountikStream(VIDEO, info500)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_api_http_status', step: 'info', status: 500 },
    });
  });

  it('reports unparsable and non-object bodies per step', async () => {
    const { fetchImpl: existBadJson } = routingFetch({
      exist: new Response('{not json', { status: 200 }),
      info: goodInfo(),
    });
    await expect(resolveCountikStream(VIDEO, existBadJson)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_api_body_unparsable', step: 'exist' },
    });
    const { fetchImpl: infoArray } = routingFetch({
      exist: goodExist(),
      info: jsonResponse(['not', 'an', 'object']),
    });
    await expect(resolveCountikStream(VIDEO, infoArray)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_api_bad_body', step: 'info' },
    });
  });

  it('reports a missing video id and a missing download link distinctly', async () => {
    const { fetchImpl: noId } = routingFetch({
      exist: jsonResponse({ status: 'success' }),
      info: goodInfo(),
    });
    await expect(resolveCountikStream(VIDEO, noId)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_no_video_id' },
    });
    const { fetchImpl: noLink } = routingFetch({
      exist: goodExist(),
      info: jsonResponse({ desc: 'no link here' }),
    });
    await expect(resolveCountikStream(VIDEO, noLink)).resolves.toEqual({
      ok: false,
      failure: { reason: 'countik_no_download_link' },
    });
  });

  it('uses the default wrapper', async () => {
    // Same shape as the tikwm default-wrapper tests: the default arrow
    // must stay covered, or the SonarCloud new-code gate fails it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/video/exist')) return jsonResponse({ video_id: '740123' });
        return jsonResponse({ download_link: 'https://v16.tokcdn.com/v.mp4', desc: 'Wrapped' });
      }),
    );
    try {
      await expect(resolveCountikStream(VIDEO)).resolves.toEqual({
        ok: true,
        streamUrl: 'https://v16.tokcdn.com/v.mp4',
        rawTitle: 'Wrapped',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
