import { describe, expect, it } from 'vitest';
import {
  runDownloadTick,
  streamToR2,
  r2ObjectKey,
  type R2BucketLike,
  type TickDeps,
} from './pipeline.js';
import type { SupabaseRpc, ClaimedReel, MarkDownloadedArgs } from './supabase.js';
import { TIKWM_API_URL, type FetchImpl } from './tikwm.js';

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const payload = concat(...children);
  return concat(u32(8 + payload.length), new TextEncoder().encode(type), payload);
}

function hdlr(handler: string): Uint8Array {
  return box('hdlr', concat(new Uint8Array(8), new TextEncoder().encode(handler), new Uint8Array(12)));
}

function videoTrak(): Uint8Array {
  return box('trak', box('mdia', hdlr('vide')));
}

function streamOf(data: Uint8Array, chunkSize = 4096): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += chunkSize) {
        controller.enqueue(data.subarray(i, Math.min(i + chunkSize, data.length)));
      }
      controller.close();
    },
  });
}

function padTo(data: Uint8Array, total: number): Uint8Array {
  if (data.length >= total) return data;
  const out = new Uint8Array(total);
  out.set(data, 0);
  return out;
}

class FakeR2 implements R2BucketLike {
  objects = new Map<string, Uint8Array>();
  puts: string[] = [];
  deletes: string[] = [];

  async put(key: string, value: ReadableStream<Uint8Array>): Promise<unknown> {
    this.puts.push(key);
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const res = await reader.read();
      if (res.done) break;
      chunks.push(res.value);
    }
    this.objects.set(key, concat(...chunks));
    return {};
  }

  async delete(key: string): Promise<unknown> {
    this.deletes.push(key);
    this.objects.delete(key);
    return {};
  }
}

interface FakeSupabaseState {
  rows: ClaimedReel[];
  downloaded: MarkDownloadedArgs[];
  failed: string[];
  throwOnDownloaded?: boolean;
}

function fakeSupabase(state: FakeSupabaseState): SupabaseRpc {
  return {
    resetStaleDownloads: async () => 0,
    claimTikTokDownloads: async () => state.rows,
    markDownloaded: async (args: MarkDownloadedArgs) => {
      if (state.throwOnDownloaded) throw new Error('db down');
      state.downloaded.push(args);
    },
    markDownloadFailed: async (reelId: string) => {
      state.failed.push(reelId);
    },
  } as unknown as SupabaseRpc;
}

const REEL: ClaimedReel = {
  reelId: 'reel-1',
  configId: 'cfg-1',
  sourcePlatform: 'tiktok',
  sourceUsername: 'someone',
  sourceReelId: '740123',
};

function fakeFetch(videoBody: Uint8Array | null, apiBody: unknown): FetchImpl {
  return (async (url: string) => {
    if (url === TIKWM_API_URL) {
      return new Response(JSON.stringify(apiBody), { status: 200 });
    }
    if (videoBody !== null) {
      return new Response(streamOf(videoBody), { status: 200 });
    }
    return new Response('no', { status: 404 });
  }) as unknown as FetchImpl;
}

function deps(
  state: FakeSupabaseState,
  r2: FakeR2,
  fetchImpl: FetchImpl,
): TickDeps {
  return {
    supabase: fakeSupabase(state),
    r2,
    r2PublicUrl: 'https://pub.example',
    fetchImpl,
  };
}

describe('runDownloadTick', () => {
  it('follows the failed path on API failure, without uploading', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(null, { code: 1, data: null })),
    );
    expect(result.claimed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failedReasons).toEqual({ api: 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.downloaded).toEqual([]);
    expect(r2.puts).toEqual([]);
  });

  it('rejects a small file and deletes the partial object', async () => {
    const small = new Uint8Array(5000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(small, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.failedReasons).toEqual({ too_small: 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(r2.deletes).toEqual(['adu-buffer/cfg-1/reel-1.mp4']);
    expect(r2.objects.has('adu-buffer/cfg-1/reel-1.mp4')).toBe(false);
  });

  it('rejects a video-only moov and deletes the object', async () => {
    const body = padTo(concat(box('ftyp', new Uint8Array(8)), box('moov', videoTrak())), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.failedReasons).toEqual({ no_audio: 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(r2.objects.has('adu-buffer/cfg-1/reel-1.mp4')).toBe(false);
  });

  it('downloads an inconclusive-audio file with identical R2 rows', async () => {
    const body = padTo(box('ftyp', new Uint8Array(8)), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(
        state,
        r2,
        fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4', title: 'My day' } }),
      ),
    );
    expect(result.downloaded).toBe(1);
    expect(state.downloaded).toHaveLength(1);
    const row = state.downloaded[0];
    expect(row.objectKey).toBe('adu-buffer/cfg-1/reel-1.mp4');
    expect(row.mediaUrl).toBe('https://pub.example/adu-buffer/cfg-1/reel-1.mp4');
    expect(row.contentType).toBe('video/mp4');
    expect(row.sizeBytes).toBe(12000);
    expect(row.sha256).toBe('8c723d5cbca9b80f4332f18d960886811c3e02aa39b01b01c889ba29a1a737b8');
    expect(row.caption).toBe('My day');
    expect(r2.objects.get('adu-buffer/cfg-1/reel-1.mp4')).toEqual(body);
  });

  it('normalizes a generic API title to the default caption', async () => {
    const body = padTo(box('ftyp', new Uint8Array(8)), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [] };
    const r2 = new FakeR2();
    await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4', title: 'TikTok' } })),
    );
    expect(state.downloaded[0].caption).toBe('❤️');
  });

  it('leaves the row processing when settling the download fails', async () => {
    const body = padTo(box('ftyp', new Uint8Array(8)), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], throwOnDownloaded: true };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.settleErrors).toBe(1);
    expect(result.failed).toBe(0);
    expect(state.failed).toEqual([]);
  });

  it('handles zero claims without settling anything', async () => {
    const state: FakeSupabaseState = { rows: [], downloaded: [], failed: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(deps(state, r2, fakeFetch(null, {})));
    expect(result).toMatchObject({ claimed: 0, downloaded: 0, failed: 0 });
  });

  it('uses the VPS-identical key layout', () => {
    expect(r2ObjectKey('cfg-9', 'reel-9')).toBe('adu-buffer/cfg-9/reel-9.mp4');
  });
});

describe('streamToR2 cap', () => {
  it('aborts when the stream exceeds the cap', async () => {
    const r2 = new FakeR2();
    const body = new Uint8Array(200);
    await expect(
      streamToR2(streamOf(body), r2, 'k', { maxBytes: 100 }),
    ).rejects.toThrow(/cap/);
  });
});
