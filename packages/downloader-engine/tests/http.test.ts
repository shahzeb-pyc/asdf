import { describe, it, expect, vi } from 'vitest';
import {
  composeTimeoutSignal,
  fetchWithTimeout,
  fetchWithTimeoutToHeaders,
  readBoundedJson,
  readBoundedText,
} from '../src/index.js';

describe('composeTimeoutSignal', () => {
  it('returns the timeout signal alone when no caller signal is given', () => {
    const signal = composeTimeoutSignal(null, 1000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('aborts when the caller signal aborts', () => {
    const caller = new AbortController();
    const composed = composeTimeoutSignal(caller.signal, 60_000);
    expect(composed.aborted).toBe(false);
    caller.abort();
    expect(composed.aborted).toBe(true);
  });
});

describe('fetchWithTimeout', () => {
  it('passes a composed signal to the fetch and returns the response', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response('ok');
    });
    const res = await fetchWithTimeout('https://example.com/x', {}, 1000, fetchFn as never);
    expect(await res.text()).toBe('ok');
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects when the timeout fires before the fetch settles', async () => {
    // The fake honors the composed signal, like a real fetch: the
    // timeout abort rejects the pending request.
    const fetchFn = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), {
            once: true,
          });
        })
    );
    await expect(
      fetchWithTimeout('https://example.com/x', {}, 10, fetchFn as never)
    ).rejects.toThrow('timed out');
  });
});

describe('fetchWithTimeoutToHeaders', () => {
  it('lets a slow body stream past the header timeout once headers arrive', async () => {
    // The fake ties the body stream to the request signal, like a real
    // fetch does: if the header timer were not cleared on resolve, the
    // abort at 10 ms would error this stream before it yields at 50 ms.
    const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('slow-body'));
            controller.close();
          }, 50);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              controller.error(new Error('stream aborted'));
            },
            { once: true }
          );
        },
      });
      return new Response(stream);
    });
    const res = await fetchWithTimeoutToHeaders(
      'https://example.com/x',
      {},
      10,
      fetchFn as never
    );
    // The 10 ms header timer must already be cleared: reading the body
    // 50 ms later still succeeds instead of aborting mid-stream.
    await expect(res.text()).resolves.toBe('slow-body');
  });

  it('rejects when headers never arrive within the timeout', async () => {
    const fetchFn = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), {
            once: true,
          });
        })
    );
    await expect(
      fetchWithTimeoutToHeaders('https://example.com/x', {}, 10, fetchFn as never)
    ).rejects.toThrow('timed out');
  });

  it('rejects when the caller aborts before headers arrive', async () => {
    const caller = new AbortController();
    const fetchFn = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const pending = fetchWithTimeoutToHeaders(
      'https://example.com/x',
      { signal: caller.signal },
      5000,
      fetchFn as never
    );
    caller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('readBoundedText / readBoundedJson', () => {
  it('reads a body under the cap', async () => {
    const res = new Response('hello');
    await expect(readBoundedText(res, 100)).resolves.toBe('hello');
  });

  it('returns null when the declared length exceeds the cap without reading', async () => {
    const res = new Response('hello', {
      headers: { 'content-length': '999' },
    });
    await expect(readBoundedText(res, 100)).resolves.toBeNull();
  });

  it('returns null when the streamed body crosses the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345'));
        controller.enqueue(new TextEncoder().encode('67890'));
        controller.close();
      },
    });
    const res = new Response(stream);
    await expect(readBoundedText(res, 8)).resolves.toBeNull();
  });

  it('parses valid JSON and returns null for invalid or over-cap JSON', async () => {
    await expect(
      readBoundedJson(new Response('{"url":"https://cdn.example.com/v.mp4"}'), 1000)
    ).resolves.toEqual({ url: 'https://cdn.example.com/v.mp4' });
    await expect(readBoundedJson(new Response('not json'), 1000)).resolves.toBeNull();
    await expect(readBoundedJson(new Response('{"a":1}'), 2)).resolves.toBeNull();
  });
});
