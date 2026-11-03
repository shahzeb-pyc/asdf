import { describe, expect, it, vi, afterEach } from 'vitest';
import { handleSecUidRequest } from './index.js';

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

  it('rejects non-GET methods', async () => {
    const res = await handleSecUidRequest(
      new Request('https://secuid.example/?username=courtroom62', { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });
});
