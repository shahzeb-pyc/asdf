import { describe, expect, it, vi, afterEach } from 'vitest';
import { handleProxyRequest, handleSecUidRequest } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(impl: (url: string, init?: RequestInit) => unknown): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('secuid worker', () => {
  it('returns sec_uid on a Countik success', async () => {
    mockFetch(async (url) => {
      expect(url).toBe('https://countik.com/api/exist/courtroom62');
      return jsonResponse({ status: 'success', sec_uid: 'MS4wLjABAAAA123' }, 200);
    });
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sec_uid: 'MS4wLjABAAAA123' });
  });

  it('accepts a path-segment username and strips a leading @', async () => {
    mockFetch(async (url) => {
      expect(url).toBe('https://countik.com/api/exist/courtroom62');
      return jsonResponse({ status: 'success', sec_uid: 'abc' }, 200);
    });
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/@courtroom62'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sec_uid: 'abc' });
  });

  it('rejects empty, malformed, and over-long usernames with 400', async () => {
    mockFetch(async () => {
      throw new Error('must not fetch on invalid input');
    });
    for (const raw of ['', '@@@', 'bad!name', 'a'.repeat(25)]) {
      const res = await handleSecUidRequest(
        new Request(`https://secuid.example/?username=${encodeURIComponent(raw)}`),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'INVALID_USERNAME' });
    }
    const missing = await handleSecUidRequest(new Request('https://secuid.example/'));
    expect(missing.status).toBe(400);
  });

  it('fails loud on a Countik 403 — no fabricated id, no challenge body', async () => {
    mockFetch(async () => {
      return new Response('<html>Just a moment...</html>', { status: 403 });
    });
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62'),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('UPSTREAM_ERROR');
    expect(body.upstreamStatus).toBe(403);
    expect(body).not.toHaveProperty('sec_uid');
    expect(JSON.stringify(body)).not.toContain('Just a moment');
  });

  it('fails loud when Countik answers 200 without a sec_uid', async () => {
    mockFetch(async () => jsonResponse({ status: 'error' }, 200));
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62'),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty('sec_uid');
  });

  it('reports a timeout distinctly when the upstream hangs', async () => {
    mockFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62'),
      { timeoutMs: 50 },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'UPSTREAM_TIMEOUT' });
  });

  it('reports a generic fetch failure as an upstream error', async () => {
    mockFetch(async () => {
      throw new Error('network down');
    });
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62'),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'UPSTREAM_ERROR' });
  });

  it('fails loud when Countik answers 200 with an unparseable body', async () => {
    mockFetch(async () => new Response('not json{', { status: 200 }));
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62'),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'UPSTREAM_ERROR' });
  });

  it('rejects non-GET methods', async () => {
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62', { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });
});

describe('countik proxy routes', () => {
  const SECRET = 'test-proxy-secret';
  const auth = { 'x-countik-proxy-secret': SECRET };

  it('fails closed with 503 when no secret is configured', async () => {
    mockFetch(async () => {
      throw new Error('must not fetch without a secret configured');
    });
    const res = await handleProxyRequest(
      new Request('https://proxy.example/proxy/exist/alice', { headers: auth }),
      {},
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'PROXY_NOT_CONFIGURED' });
  });

  it('rejects proxy calls without the secret with 401 and no upstream call', async () => {
    mockFetch(async () => {
      throw new Error('must not fetch unauthenticated');
    });
    const res = await handleProxyRequest(
      new Request('https://proxy.example/proxy/exist/alice'),
      { proxySecret: SECRET },
    );
    expect(res.status).toBe(401);
  });

  it('forwards exist through the proxy and returns upstream JSON unchanged', async () => {
    let seenUrl = '';
    let seenUa = '';
    mockFetch(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenUa = (init?.headers as Record<string, string>)['User-Agent'] ?? '';
      return jsonResponse({ status: 'success', sec_uid: 'SEC123' }, 200);
    });
    const res = await handleProxyRequest(
      new Request('https://proxy.example/proxy/exist/alice', { headers: auth }),
      { proxySecret: SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success', sec_uid: 'SEC123' });
    expect(seenUrl).toBe('https://countik.com/api/exist/alice');
    expect(seenUa).toContain('Chrome/');
  });

  it('forwards analyze with validated params', async () => {
    let seenUrl = '';
    mockFetch(async (url: string) => {
      seenUrl = url;
      return jsonResponse({ author: { verified: true } }, 200);
    });
    const res = await handleProxyRequest(
      new Request(
        'https://proxy.example/proxy/analyze?sec_user_id=SEC123&username=alice',
        { headers: auth },
      ),
      { proxySecret: SECRET },
    );
    expect(res.status).toBe(200);
    expect(seenUrl).toBe(
      'https://countik.com/api/analyze/?sec_user_id=SEC123&username=alice',
    );
    const bad = await handleProxyRequest(
      new Request('https://proxy.example/proxy/analyze?username=alice', {
        headers: auth,
      }),
      { proxySecret: SECRET },
    );
    expect(bad.status).toBe(400);
  });

  it('forwards video/exist and videoinfo, rejecting non-TikTok URLs and bad ids', async () => {
    const urls: string[] = [];
    mockFetch(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/video/exist')) {
        return jsonResponse({ video_id: '7417197815434169631' }, 200);
      }
      return jsonResponse({ plays: 100 }, 200);
    });
    const existRes = await handleProxyRequest(
      new Request('https://proxy.example/proxy/video/exist', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.tiktok.com/@alice/video/123' }),
      }),
      { proxySecret: SECRET },
    );
    expect(existRes.status).toBe(200);
    expect(urls[0]).toBe('https://countik.com/api/video/exist');
    const infoRes = await handleProxyRequest(
      new Request('https://proxy.example/proxy/videoinfo/7417197815434169631', {
        headers: auth,
      }),
      { proxySecret: SECRET },
    );
    expect(infoRes.status).toBe(200);
    const badUrl = await handleProxyRequest(
      new Request('https://proxy.example/proxy/video/exist', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/video/123' }),
      }),
      { proxySecret: SECRET },
    );
    expect(badUrl.status).toBe(400);
    const badId = await handleProxyRequest(
      new Request('https://proxy.example/proxy/videoinfo/abc', { headers: auth }),
      { proxySecret: SECRET },
    );
    expect(badId.status).toBe(400);
  });

  it('forwards generateHashtags and never leaks an upstream challenge body on non-200', async () => {
    mockFetch(async () => jsonResponse({ hashtags: ['viral'] }, 200));
    const ok = await handleProxyRequest(
      new Request('https://proxy.example/proxy/generateHashtags', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'viral' }),
      }),
      { proxySecret: SECRET },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ hashtags: ['viral'] });

    mockFetch(async () => new Response('<html>challenge page</html>', { status: 403 }));
    const blocked = await handleProxyRequest(
      new Request('https://proxy.example/proxy/generateHashtags', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'viral' }),
      }),
      { proxySecret: SECRET },
    );
    expect(blocked.status).toBe(502);
    const blockedBody = (await blocked.json()) as Record<string, unknown>;
    expect(blockedBody.error).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(blockedBody)).not.toContain('challenge page');
  });

  it('rejects unknown proxy routes with 404', async () => {
    mockFetch(async () => {
      throw new Error('must not fetch unknown routes');
    });
    const res = await handleProxyRequest(
      new Request('https://proxy.example/proxy/anything-else', { headers: auth }),
      { proxySecret: SECRET },
    );
    expect(res.status).toBe(404);
  });
});
