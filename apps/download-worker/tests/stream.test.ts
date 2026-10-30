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
