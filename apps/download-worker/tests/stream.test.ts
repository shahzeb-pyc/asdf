import { describe, expect, it } from 'vitest';
import { downloadAndStoreCandidate } from '../src/engine/stream.js';
import { resolveCandidates } from '../src/engine/index.js';
import { FakeStorage, MB, makeMediaFetch } from './fakes.js';
import type { MediaStreamSink } from '../src/engine/stream.js';

const BASE = 'https://media.example.test';

/** A sink that discards bytes: proves the cap logic without 500 MB of R2. */
class DiscardSink implements MediaStreamSink {
  written = 0;
  aborted = false;
  finished = false;

  async write(chunk: Uint8Array): Promise<void> {
    this.written += chunk.byteLength;
  }

  async finish(): Promise<{ key: string; byteLength: number; publicUrl: string }> {
    this.finished = true;
    return { key: 'k', byteLength: this.written, publicUrl: `${BASE}/k` };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

function candidate(streamUrl: string, extra: Record<string, unknown> = {}) {
  return {
    streamUrl,
    fileName: 'video.mp4',
    mediaTypeHint: 'video' as const,
    ...extra,
  };
}

describe('downloadAndStoreCandidate', () => {
  it('aborts mid-stream when the total crosses 500 MB', async () => {
    const sink = new DiscardSink();
    // No declared content-length: the cap must fire mid-stream,
    // not on the header.
    const fetchFn = makeMediaFetch(600 * MB, { chunkSize: 16 * MB, omitContentLength: true });
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/big.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn,
        createSink: () => sink,
      })
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(sink.aborted).toBe(true);
    expect(sink.finished).toBe(false);
    // The stream was cut off at the cap, not downloaded in full:
    // within one chunk of 500 MB (the crossing chunk is never
    // written) and far short of the 600 MB the source would serve.
    expect(sink.written).toBeLessThan(600 * MB);
    expect(sink.written).toBeGreaterThanOrEqual(500 * MB - 16 * MB);
  });

  it('fails a declared over-cap file before the sink writes anything', async () => {
    const sink = new DiscardSink();
    const fetchFn = makeMediaFetch(600 * MB, { chunkSize: MB });
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/big.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn,
        createSink: () => sink,
      })
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(sink.written).toBe(0);
    expect(sink.aborted).toBe(false);
  });

  it('rejects a zero-byte stream as unsupported media', async () => {
    const sink = new DiscardSink();
    const fetchFn = makeMediaFetch(0);
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/empty.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn,
        createSink: () => sink,
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('saves the video even when its thumbnail is over the 10 MB cap', async () => {
    const storage = new FakeStorage(BASE);
    const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('thumb')) {
        // Declared 11 MB: the bounded thumbnail reader refuses it
        // without reading the body.
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(11 * MB) },
        });
      }
      return makeMediaFetch(2 * MB)(String(input), init);
    }) as unknown as typeof fetch;
    const item = await downloadAndStoreCandidate({
      candidate: candidate('https://cdn.example.com/video.mp4', {
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      }),
      index: 0,
      userId: 'u1',
      storage,
      fetchFn,
      createSink: () => new DiscardSink(),
    });
    expect(item.fileSize).toBe(2 * MB);
    expect(item.thumbnailKey).toBeNull();
    expect(item.thumbnailUrl).toBeNull();
  });
});

describe('resolveCandidates bounds', () => {
  it('aborts an over-10 MB resolve body without buffering it', async () => {
    const fetchFn = (async (): Promise<Response> => {
      // Declared 11 MB body; the bounded reader refuses it on the
      // header alone, so no 11 MB buffer is ever built.
      return new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': String(11 * MB) },
      });
    }) as unknown as typeof fetch;
    await expect(
      resolveCandidates('https://example.com/page', fetchFn, null)
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('a direct media link resolves without reading a page body', async () => {
    const fetchFn = makeMediaFetch(2 * MB);
    const resolved = await resolveCandidates(
      'https://cdn.example.com/video.mp4',
      fetchFn,
      null
    );
    expect(resolved.candidates).toHaveLength(1);
    expect(resolved.candidates[0]?.streamUrl).toBe('https://cdn.example.com/video.mp4');
  });
});

describe('downloadAndStoreCandidate thumbnails and resume edges', () => {
  function thumbFetch(
    thumb: Response | 'throw' | null,
    mediaBytes: number = 2 * MB
  ): typeof fetch {
    const mediaFetch = makeMediaFetch(mediaBytes);
    return (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('thumb')) {
        if (thumb === 'throw') throw new Error('thumb down');
        if (thumb === null) return new Response('not found', { status: 404 });
        return thumb;
      }
      return mediaFetch(url, init);
    }) as unknown as typeof fetch;
  }

  function videoItem(thumbnailUrl: string | null) {
    return {
      candidate: candidate('https://cdn.example.com/video.mp4', { thumbnailUrl }),
      index: 0,
      userId: 'u1',
      storage: new FakeStorage(BASE),
      createSink: () => new DiscardSink(),
    };
  }

  it('saves a webp thumbnail and a jpeg thumbnail with the right extension', async () => {
    const storage = new FakeStorage(BASE);
    const webp = await downloadAndStoreCandidate({
      ...videoItem('https://cdn.example.com/thumb.webp'),
      storage,
      fetchFn: thumbFetch(
        new Response(new Uint8Array(100), { headers: { 'content-type': 'image/webp' } })
      ),
    });
    expect(webp.thumbnailKey).toMatch(/\.webp$/);
    expect(webp.thumbnailUrl).toContain(webp.thumbnailKey as string);
    expect(storage.putKeys).toContain(webp.thumbnailKey as string);

    const jpeg = await downloadAndStoreCandidate({
      ...videoItem('https://cdn.example.com/thumb.jpg'),
      storage,
      fetchFn: thumbFetch(
        new Response(new Uint8Array(50), { headers: { 'content-type': 'image/jpeg' } })
      ),
    });
    expect(jpeg.thumbnailKey).toMatch(/\.jpeg$/);
  });

  it('drops the thumbnail on non-ok, unsafe, unclassifiable, empty, or failing fetches', async () => {
    const cases: Array<{ thumb: Response | 'throw' | null; thumbnailUrl: string | null }> = [
      { thumb: null, thumbnailUrl: 'https://cdn.example.com/thumb.jpg' },
      { thumb: null, thumbnailUrl: 'http://127.0.0.1/thumb.jpg' },
      {
        thumb: new Response(new Uint8Array(10), { headers: { 'content-type': 'image/gif' } }),
        thumbnailUrl: 'https://cdn.example.com/thumb.gif',
      },
      {
        thumb: new Response('', { headers: { 'content-type': 'image/jpeg' } }),
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      },
      { thumb: 'throw', thumbnailUrl: 'https://cdn.example.com/thumb.jpg' },
    ];
    for (const c of cases) {
      const item = await downloadAndStoreCandidate({
        ...videoItem(c.thumbnailUrl),
        fetchFn: thumbFetch(c.thumb),
      });
      expect(item.fileSize).toBe(2 * MB);
      expect(item.thumbnailKey).toBeNull();
      expect(item.thumbnailUrl).toBeNull();
    }
  });

  it('rejects a null-body media response as an empty stream', async () => {
    const fetchFn = (async () =>
      new Response(null, { headers: { 'content-type': 'video/mp4' } })) as unknown as typeof fetch;
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/video.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn,
        createSink: () => new DiscardSink(),
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('fails a resume whose source cannot be reached, and one that redirects unsafe', async () => {
    const failing = (async () => {
      throw new Error('conn refused');
    }) as unknown as typeof fetch;
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/video.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn: failing,
        createSink: () => new DiscardSink(),
        resume: { streamUrl: 'https://cdn.example.com/video.mp4', bytes: MB },
      })
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });

    const redirecting = (async () => {
      const res = new Response(new Uint8Array(10), {
        status: 206,
        headers: { 'content-type': 'video/mp4' },
      });
      Object.defineProperty(res, 'url', { value: 'http://10.0.0.5/video.mp4' });
      return res;
    }) as unknown as typeof fetch;
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/video.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn: redirecting,
        createSink: () => new DiscardSink(),
        resume: { streamUrl: 'https://cdn.example.com/video.mp4', bytes: MB },
      })
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('rejects a candidate whose mime cannot be resolved', async () => {
    const fetchFn = (async () =>
      new Response(new Uint8Array(10), { headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch;
    await expect(
      downloadAndStoreCandidate({
        candidate: { streamUrl: 'https://cdn.example.com/dl', fileName: 'dl' },
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn,
        createSink: () => new DiscardSink(),
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });
});

describe('downloadAndStoreCandidate sink and thumbnail edges', () => {
  class RejectingAbortSink extends DiscardSink {
    override async abort(): Promise<void> {
      throw new Error('abort failed');
    }
  }

  it('drops a thumbnail that redirects to an unsafe address', async () => {
    const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('thumb')) {
        const res = new Response(new Uint8Array(10), {
          headers: { 'content-type': 'image/jpeg' },
        });
        Object.defineProperty(res, 'url', { value: 'http://10.0.0.5/thumb.jpg' });
        return res;
      }
      return makeMediaFetch(2 * MB)(url, init);
    }) as unknown as typeof fetch;
    const item = await downloadAndStoreCandidate({
      candidate: candidate('https://cdn.example.com/video.mp4', {
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      }),
      index: 0,
      userId: 'u1',
      storage: new FakeStorage(BASE),
      fetchFn,
      createSink: () => new DiscardSink(),
    });
    expect(item.thumbnailKey).toBeNull();
    expect(item.thumbnailUrl).toBeNull();
  });

  it('drops a null-body thumbnail and a streamed over-10 MB thumbnail', async () => {
    const nullBody = await downloadAndStoreCandidate({
      candidate: candidate('https://cdn.example.com/video.mp4', {
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      }),
      index: 0,
      userId: 'u1',
      storage: new FakeStorage(BASE),
      fetchFn: (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes('thumb')) {
          return new Response(null, { headers: { 'content-type': 'image/jpeg' } });
        }
        return makeMediaFetch(2 * MB)(url, init);
      }) as unknown as typeof fetch,
      createSink: () => new DiscardSink(),
    });
    expect(nullBody.thumbnailKey).toBeNull();

    let yielded = 0;
    const bigStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (yielded >= 2) {
          controller.close();
          return;
        }
        yielded += 1;
        controller.enqueue(new Uint8Array(6 * MB));
      },
    });
    const overCap = await downloadAndStoreCandidate({
      candidate: candidate('https://cdn.example.com/video.mp4', {
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      }),
      index: 0,
      userId: 'u1',
      storage: new FakeStorage(BASE),
      fetchFn: (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes('thumb')) {
          return new Response(bigStream, { headers: { 'content-type': 'image/jpeg' } });
        }
        return makeMediaFetch(2 * MB)(url, init);
      }) as unknown as typeof fetch,
      createSink: () => new DiscardSink(),
    });
    expect(overCap.thumbnailKey).toBeNull();
  });

  it('still reports the empty stream when the abort itself rejects', async () => {
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/empty.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn: makeMediaFetch(0, { omitContentLength: true }),
        createSink: () => new RejectingAbortSink(),
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('surfaces a failing finish even when the abort also rejects', async () => {
    class FailingFinishSink extends RejectingAbortSink {
      override async finish(): Promise<{ key: string; byteLength: number; publicUrl: string }> {
        throw new Error('finish boom');
      }
    }
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/video.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn: makeMediaFetch(MB),
        createSink: () => new FailingFinishSink(),
      })
    ).rejects.toThrow('finish boom');
  });

  it('surfaces a failing write even when the abort also rejects', async () => {
    class FailingWriteSink extends RejectingAbortSink {
      override async write(): Promise<void> {
        throw new Error('write boom');
      }
    }
    await expect(
      downloadAndStoreCandidate({
        candidate: candidate('https://cdn.example.com/video.mp4'),
        index: 0,
        userId: 'u1',
        storage: new FakeStorage(BASE),
        fetchFn: makeMediaFetch(MB),
        createSink: () => new FailingWriteSink(),
      })
    ).rejects.toThrow('write boom');
  });
});
