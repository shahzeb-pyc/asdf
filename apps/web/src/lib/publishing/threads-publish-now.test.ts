import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  postThreadsReply,
  publishOneThreadsContainer,
  threadsFriendlyReason,
  threadsMediaImageTooLarge,
  threadsMediaUrlReachable,
  toThreadsGraphFailure,
} from '@/lib/publishing/threads-publish-now';

afterEach(() => {
  vi.unstubAllGlobals();
});

type FetchStub = (url: string, init?: Record<string, unknown>) => Promise<unknown>;

function jsonResponse(body: unknown, ok = true, status = 200): unknown {
  return {
    ok,
    status,
    json: async () => body,
    headers: { get: () => null },
  };
}

function stubFetch(impl: FetchStub): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

/** Scripted Graph responses in call order. */
function graphScript(responses: Array<unknown>): FetchStub {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('Unexpected extra Threads API call');
    return next;
  };
}

const TEXT_SUCCESS = [
  jsonResponse({ id: 'container-1' }),
  jsonResponse({ status: 'FINISHED' }),
  jsonResponse({ id: 'media-1' }),
];

describe('publishOneThreadsContainer', () => {
  it('publishes a text post only after FINISHED, and returns the media id', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const queue = [...TEXT_SUCCESS];
    stubFetch(async (url, init) => {
      const body = (init as { body?: string } | undefined)?.body;
      calls.push({ url, body: body ? (JSON.parse(body) as unknown) : undefined });
      const next = queue.shift();
      if (next === undefined) throw new Error('Unexpected extra Threads API call');
      return next;
    });
    await expect(
      publishOneThreadsContainer({
        threadsUserId: '123',
        accessToken: 'token',
        mediaType: 'TEXT',
        text: 'hello',
        poll: { intervalMs: 0, maxAttempts: 3 },
      })
    ).resolves.toBe('media-1');
    expect(calls[0]?.body).toEqual({ media_type: 'TEXT', text: 'hello' });
    expect(calls[2]?.url).toContain('/123/threads_publish');
  });

  it('publishes image and video posts with the right media url field', async () => {
    const imageQueue = [
      jsonResponse({ id: 'container-img' }),
      jsonResponse({ status: 'FINISHED' }),
      jsonResponse({ id: 'media-img' }),
    ];
    stubFetch(async () => imageQueue.shift() as unknown);
    await expect(
      publishOneThreadsContainer({
        threadsUserId: '123',
        accessToken: 'token',
        mediaType: 'IMAGE',
        text: 'pic',
        imageUrl: 'https://example.com/pic.jpg',
        poll: { intervalMs: 0, maxAttempts: 3 },
      })
    ).resolves.toBe('media-img');

    const videoBodies: Array<unknown> = [];
    const videoQueue = [
      jsonResponse({ id: 'container-vid' }),
      jsonResponse({ status: 'FINISHED' }),
      jsonResponse({ id: 'media-vid' }),
    ];
    stubFetch(async (_url, init) => {
      const body = (init as { body?: string } | undefined)?.body;
      if (body) videoBodies.push(JSON.parse(body) as unknown);
      return videoQueue.shift() as unknown;
    });
    await expect(
      publishOneThreadsContainer({
        threadsUserId: '123',
        accessToken: 'token',
        mediaType: 'VIDEO',
        text: 'clip',
        videoUrl: 'https://example.com/clip.mp4',
        poll: { intervalMs: 0, maxAttempts: 3 },
      })
    ).resolves.toBe('media-vid');
    expect(videoBodies[0]).toEqual({
      media_type: 'VIDEO',
      text: 'clip',
      video_url: 'https://example.com/clip.mp4',
    });
  });

  it('fails fast on a container ERROR, never as a success', async () => {
    stubFetch(
      graphScript([
        jsonResponse({ id: 'container-err' }),
        jsonResponse({ status: 'ERROR', error_message: 'bad media' }),
      ])
    );
    const error = await publishOneThreadsContainer({
      threadsUserId: '123',
      accessToken: 'token',
      mediaType: 'IMAGE',
      imageUrl: 'https://example.com/pic.jpg',
      poll: { intervalMs: 0, maxAttempts: 3 },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('could not prepare');
    expect((error as unknown as Record<string, unknown>).step).toBe('container-status');
  });

  it('surfaces auth 190 so the caller can give the reconnect reason', async () => {
    stubFetch(
      graphScript([
        jsonResponse(
          {
            error: {
              message: 'Session expired',
              code: 190,
              error_subcode: 463,
              fbtrace_id: 'trace-1',
            },
          },
          false,
          400
        ),
      ])
    );
    const error = await publishOneThreadsContainer({
      threadsUserId: '123',
      accessToken: 'token',
      mediaType: 'TEXT',
      text: 'hello',
      poll: { intervalMs: 0, maxAttempts: 3 },
    }).catch((err: unknown) => err);
    expect(toThreadsGraphFailure(error).code).toBe(190);
    expect(threadsFriendlyReason(error)).toContain('expired');
  });

  it('fails with the still-preparing reason after the poll budget, without publishing', async () => {
    let publishCalls = 0;
    stubFetch(async (url) => {
      if (url.includes('threads_publish')) publishCalls += 1;
      if (url.includes('/threads') && !url.includes('threads_publish')) {
        return jsonResponse({ id: 'container-slow' });
      }
      return jsonResponse({ status: 'IN_PROGRESS' });
    });
    const error = await publishOneThreadsContainer({
      threadsUserId: '123',
      accessToken: 'token',
      mediaType: 'TEXT',
      text: 'hello',
      poll: { intervalMs: 0, maxAttempts: 3 },
    }).catch((err: unknown) => err);
    expect((error as Error).message).toContain('still preparing');
    expect(publishCalls).toBe(0);
  });

  it('does not blindly re-publish on the 24/4279009 trap: a PUBLISHED recheck wins', async () => {
    stubFetch(
      graphScript([
        jsonResponse({ id: 'container-trap' }),
        jsonResponse({ status: 'FINISHED' }),
        jsonResponse(
          {
            error: {
              message: 'propagating',
              code: 24,
              error_subcode: 4279009,
            },
          },
          false,
          404
        ),
        jsonResponse({ status: 'PUBLISHED' }),
      ])
    );
    await expect(
      publishOneThreadsContainer({
        threadsUserId: '123',
        accessToken: 'token',
        mediaType: 'TEXT',
        text: 'hello',
        poll: { intervalMs: 0, maxAttempts: 3 },
      })
    ).resolves.toBe('container-trap');
  });

  it('posts a reply as a TEXT container with reply_to_id', async () => {
    const bodies: Array<unknown> = [];
    const queue = [
      jsonResponse({ id: 'container-reply' }),
      jsonResponse({ status: 'FINISHED' }),
      jsonResponse({ id: 'media-reply' }),
    ];
    stubFetch(async (_url, init) => {
      const body = (init as { body?: string } | undefined)?.body;
      if (body) bodies.push(JSON.parse(body) as unknown);
      return queue.shift() as unknown;
    });
    await postThreadsReply({
      threadsUserId: '123',
      accessToken: 'token',
      postId: 'media-1',
      message: 'first reply',
      poll: { intervalMs: 0, maxAttempts: 3 },
    });
    expect(bodies[0]).toEqual({
      media_type: 'TEXT',
      text: 'first reply',
      reply_to_id: 'media-1',
    });
  });
});

describe('threadsMediaUrlReachable / threadsMediaImageTooLarge', () => {
  it('accepts a HEAD-ok url, a 405 with a ranged-GET fallback, and rejects the rest', async () => {
    stubFetch(async (url, init) => {
      const method = (init as { method?: string } | undefined)?.method;
      if (url === 'https://example.com/ok.jpg') return { ok: true, status: 200, headers: { get: () => null } };
      if (url === 'https://example.com/nohead.jpg' && method === 'HEAD') {
        return { ok: false, status: 405, headers: { get: () => null } };
      }
      if (url === 'https://example.com/nohead.jpg') return { ok: true, status: 206, headers: { get: () => null } };
      if (url === 'https://example.com/gone.jpg') return { ok: false, status: 404, headers: { get: () => null } };
      throw new Error('network down');
    });
    await expect(threadsMediaUrlReachable('https://example.com/ok.jpg')).resolves.toBe(true);
    await expect(threadsMediaUrlReachable('https://example.com/nohead.jpg')).resolves.toBe(true);
    await expect(threadsMediaUrlReachable('https://example.com/gone.jpg')).resolves.toBe(false);
    await expect(threadsMediaUrlReachable('https://example.com/down.jpg')).resolves.toBe(false);
  });

  it('flags images over 8 MB only when a size is known', async () => {
    stubFetch(async (url) => ({
      ok: true,
      status: 200,
      headers: {
        get: () =>
          url === 'https://example.com/big.jpg'
            ? String(9 * 1024 * 1024)
            : url === 'https://example.com/small.jpg'
              ? String(1024)
              : null,
      },
    }));
    await expect(threadsMediaImageTooLarge('https://example.com/big.jpg')).resolves.toBe(true);
    await expect(threadsMediaImageTooLarge('https://example.com/small.jpg')).resolves.toBe(false);
    await expect(threadsMediaImageTooLarge('https://example.com/unknown.jpg')).resolves.toBe(false);
  });
});
