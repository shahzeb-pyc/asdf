import { describe, expect, it, vi } from 'vitest';
import {
  runDownloadTick,
  streamToR2,
  r2ObjectKey,
  resolveFailure,
  streamOpenFailure,
  uploadFailure,
  FileTooLargeError,
  StreamStalledError,
  R2PutError,
  type R2BucketLike,
  type TickDeps,
} from './pipeline.js';
import type { SupabaseRpc, ClaimedReel, MarkDownloadedArgs } from './supabase.js';
import {
  TIKWM_API_URL,
  STREAM_CHUNK_TIMEOUT_MS,
  type FetchImpl,
  type TikwmResolveFailure,
  type StreamOpenFailure,
} from './tikwm.js';

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
  throwOnPut = false;

  async put(key: string, value: ReadableStream<Uint8Array>): Promise<unknown> {
    this.puts.push(key);
    if (this.throwOnPut) throw new Error('r2 down');
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
  recorded: Array<{ reelId: string; failure: unknown }>;
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
    recordDownloadFailure: async (reelId: string, failure: unknown) => {
      state.recorded.push({ reelId, failure });
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

function fakeFetchStream(videoStream: ReadableStream<Uint8Array>, apiBody: unknown): FetchImpl {
  return (async (url: string) => {
    if (url === TIKWM_API_URL) {
      return new Response(JSON.stringify(apiBody), { status: 200 });
    }
    return new Response(videoStream, { status: 200 });
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(null, { code: 1, data: null })),
    );
    expect(result.claimed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failedReasons).toEqual({ 'tikwm_resolve:tikwm_api_body_code': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: { stage: 'tikwm_resolve', reason: 'tikwm_api_body_code', detail: 'body_code=1' },
      },
    ]);
    expect(state.downloaded).toEqual([]);
    expect(r2.puts).toEqual([]);
  });

  it('records the HTTP status when the video stream 404s', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(null, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.failedReasons).toEqual({ 'stream_open:stream_http_status': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: { stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=404' },
      },
    ]);
    expect(r2.puts).toEqual([]);
  });

  it('records an R2 put failure distinctly from a stream failure', async () => {
    const body = padTo(box('ftyp', new Uint8Array(8)), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    r2.throwOnPut = true;
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.failedReasons).toEqual({ 'stream_upload:r2_put_error': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: { stage: 'stream_upload', reason: 'r2_put_error', detail: 'r2 down' },
      },
    ]);
    expect(r2.deletes).toEqual(['adu-buffer/cfg-1/reel-1.mp4']);
  });

  it('records a stream read failure distinctly from an R2 failure', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const erroring = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('read boom'));
      },
    });
    const result = await runDownloadTick(
      deps(state, r2, fakeFetchStream(erroring, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.failedReasons).toEqual({ 'stream_upload:stream_read_error': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: { stage: 'stream_upload', reason: 'stream_read_error', detail: 'read boom' },
      },
    ]);
  });

  it('rejects a small file and deletes the partial object', async () => {
    const small = new Uint8Array(5000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(small, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.failedReasons).toEqual({ 'size_check:too_small': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: { stage: 'size_check', reason: 'too_small', detail: 'size_bytes=5000' },
      },
    ]);
    expect(r2.deletes).toEqual(['adu-buffer/cfg-1/reel-1.mp4']);
    expect(r2.objects.has('adu-buffer/cfg-1/reel-1.mp4')).toBe(false);
  });

  it('rejects a video-only moov and deletes the object', async () => {
    const body = padTo(concat(box('ftyp', new Uint8Array(8)), box('moov', videoTrak())), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.failedReasons).toEqual({ 'audio_check:no_audio': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: { stage: 'audio_check', reason: 'no_audio' },
      },
    ]);
    expect(r2.objects.has('adu-buffer/cfg-1/reel-1.mp4')).toBe(false);
  });

  it('downloads an inconclusive-audio file with identical R2 rows', async () => {
    const body = padTo(box('ftyp', new Uint8Array(8)), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4', title: 'TikTok' } })),
    );
    expect(state.downloaded[0].caption).toBe('❤️');
  });

  it('still moves the retry accounting when recording the reason fails', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const supabase = fakeSupabase(state);
    const failing = {
      ...supabase,
      recordDownloadFailure: async () => {
        throw new Error('record down');
      },
    } as unknown as SupabaseRpc;
    const result = await runDownloadTick({
      supabase: failing,
      r2,
      r2PublicUrl: 'https://pub.example',
      fetchImpl: fakeFetch(null, { code: 1, data: null }),
    });
    expect(result.failed).toBe(1);
    expect(result.settleErrors).toBe(1);
    expect(state.failed).toEqual(['reel-1']);
  });

  it('leaves the row processing when settling the download fails', async () => {
    const body = padTo(box('ftyp', new Uint8Array(8)), 12000);
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [], throwOnDownloaded: true };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.settleErrors).toBe(1);
    expect(result.failed).toBe(0);
    expect(state.failed).toEqual([]);
  });

  it('handles zero claims without settling anything', async () => {
    const state: FakeSupabaseState = { rows: [], downloaded: [], failed: [], recorded: [] };
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

  it('reports the cap breach as a typed error carrying the cap', async () => {
    const r2 = new FakeR2();
    const body = new Uint8Array(200);
    const err = await streamToR2(streamOf(body), r2, 'k', { maxBytes: 100 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FileTooLargeError);
    expect((err as FileTooLargeError).capBytes).toBe(100);
  });

  it('maps a stalled stream to stream_stalled', async () => {
    vi.useFakeTimers();
    try {
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
      const r2 = new FakeR2();
      const never = new ReadableStream<Uint8Array>({});
      const tick = runDownloadTick(
        deps(state, r2, fakeFetchStream(never, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
      );
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await tick;
      expect(result.failedReasons).toEqual({ 'stream_upload:stream_stalled': 1 });
      expect(state.failed).toEqual(['reel-1']);
      expect(state.recorded).toEqual([
        {
          reelId: 'reel-1',
          failure: { stage: 'stream_upload', reason: 'stream_stalled', detail: 'timeout_ms=30000' },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Fetch double where the tikwm call and the stream call are scripted
 * independently; a scripted Error is thrown, anything else is returned. */
function scriptedFetch(
  tikwm: unknown,
  stream: unknown = new Response('no', { status: 404 }),
): FetchImpl {
  return (async (url: string) => {
    const scripted = url === TIKWM_API_URL ? tikwm : stream;
    if (scripted instanceof Error) throw scripted;
    return scripted as Response;
  }) as unknown as FetchImpl;
}

function tikwmJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function goodTikwm(): Response {
  return tikwmJson({ code: 0, data: { play: 'https://cdn.example/v.mp4' } });
}

describe('runDownloadTick reason mapping (remaining stages)', () => {
  it.each([
    ['tikwm_api_timeout', (() => { const e = new Error('timed out'); e.name = 'TimeoutError'; return e; })(), { stage: 'tikwm_resolve', reason: 'tikwm_api_timeout' }],
    ['tikwm_api_fetch_error', new Error('tikwm down'), { stage: 'tikwm_resolve', reason: 'tikwm_api_fetch_error', detail: 'tikwm down' }],
    ['tikwm_api_http_status', new Response('err', { status: 500 }), { stage: 'tikwm_resolve', reason: 'tikwm_api_http_status', detail: 'http_status=500' }],
    ['tikwm_api_body_unparsable', new Response('not json', { status: 200 }), { stage: 'tikwm_resolve', reason: 'tikwm_api_body_unparsable' }],
    ['tikwm_api_bad_body', tikwmJson('just a string'), { stage: 'tikwm_resolve', reason: 'tikwm_api_bad_body' }],
    ['tikwm_api_no_data', tikwmJson({ code: 0, data: null }), { stage: 'tikwm_resolve', reason: 'tikwm_api_no_data' }],
    ['tikwm_no_stream_url', tikwmJson({ code: 0, data: {} }), { stage: 'tikwm_resolve', reason: 'tikwm_no_stream_url' }],
  ])('records %s from the tikwm resolve stage', async (_name, tikwm, failure) => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(deps(state, r2, scriptedFetch(tikwm)));
    expect(result.failed).toBe(1);
    expect(result.failedReasons).toEqual({ [`tikwm_resolve:${(failure as { reason: string }).reason}`]: 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([{ reelId: 'reel-1', failure }]);
    expect(state.downloaded).toEqual([]);
    expect(r2.puts).toEqual([]);
  });

  it('records stream_fetch_error when the video stream GET throws', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, scriptedFetch(goodTikwm(), new Error('stream down'))),
    );
    expect(result.failedReasons).toEqual({ 'stream_open:stream_fetch_error': 1 });
    expect(state.recorded).toEqual([
      { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_fetch_error', detail: 'stream down' } },
    ]);
    expect(r2.puts).toEqual([]);
  });

  it('records stream_no_body when the video stream responds without a body', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, scriptedFetch(goodTikwm(), new Response(null, { status: 200 }))),
    );
    expect(result.failedReasons).toEqual({ 'stream_open:stream_no_body': 1 });
    expect(state.recorded).toEqual([
      { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_no_body' } },
    ]);
    expect(r2.puts).toEqual([]);
  });

  it('records pipeline:unexpected_error when processOne throws outside its mapped paths', async () => {
    // A fetch impl that violates its contract (returns undefined) makes
    // resolveTikwmStream throw a TypeError reading .status — nothing in
    // processOne maps that, so the tick catch must record it loudly and
    // still run the failed path instead of stalling the tick.
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(deps(state, r2, scriptedFetch(undefined)));
    expect(result.failed).toBe(1);
    expect(result.failedReasons).toEqual({ 'pipeline:unexpected_error': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toHaveLength(1);
    expect(state.recorded[0].reelId).toBe('reel-1');
    const failure = state.recorded[0].failure as { stage: string; reason: string; detail?: string };
    expect(failure.stage).toBe('pipeline');
    expect(failure.reason).toBe('unexpected_error');
    expect(typeof failure.detail).toBe('string');
  });
});

describe('reason mappers (pure table)', () => {
  it('maps every tikwm resolve failure to its recorded reason', () => {
    const cases: Array<[TikwmResolveFailure, unknown]> = [
      [{ reason: 'tikwm_api_timeout' }, { stage: 'tikwm_resolve', reason: 'tikwm_api_timeout' }],
      [{ reason: 'tikwm_api_fetch_error', detail: 'boom' }, { stage: 'tikwm_resolve', reason: 'tikwm_api_fetch_error', detail: 'boom' }],
      [{ reason: 'tikwm_api_http_status', status: 403 }, { stage: 'tikwm_resolve', reason: 'tikwm_api_http_status', detail: 'http_status=403' }],
      [{ reason: 'tikwm_api_body_unparsable' }, { stage: 'tikwm_resolve', reason: 'tikwm_api_body_unparsable' }],
      [{ reason: 'tikwm_api_bad_body' }, { stage: 'tikwm_resolve', reason: 'tikwm_api_bad_body' }],
      [{ reason: 'tikwm_api_body_code', code: '7' }, { stage: 'tikwm_resolve', reason: 'tikwm_api_body_code', detail: 'body_code=7' }],
      [{ reason: 'tikwm_api_no_data' }, { stage: 'tikwm_resolve', reason: 'tikwm_api_no_data' }],
      [{ reason: 'tikwm_no_stream_url' }, { stage: 'tikwm_resolve', reason: 'tikwm_no_stream_url' }],
    ];
    for (const [input, expected] of cases) expect(resolveFailure(input)).toEqual(expected);
  });

  it('maps every stream open failure to its recorded reason', () => {
    const cases: Array<[StreamOpenFailure, unknown]> = [
      [{ reason: 'stream_fetch_error', detail: 'down' }, { stage: 'stream_open', reason: 'stream_fetch_error', detail: 'down' }],
      [{ reason: 'stream_http_status', status: 404 }, { stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=404' }],
      [{ reason: 'stream_no_body' }, { stage: 'stream_open', reason: 'stream_no_body' }],
    ];
    for (const [input, expected] of cases) expect(streamOpenFailure(input)).toEqual(expected);
  });

  it('maps every upload failure, including the cap breach processOne cannot reach', () => {
    // file_too_large needs a >1 GiB stream through processOne, so it is
    // pinned here directly against the pure mapper instead.
    expect(uploadFailure(new FileTooLargeError(100))).toEqual({
      stage: 'stream_upload', reason: 'file_too_large', detail: 'cap_bytes=100',
    });
    expect(uploadFailure(new StreamStalledError('stalled'))).toEqual({
      stage: 'stream_upload', reason: 'stream_stalled', detail: `timeout_ms=${STREAM_CHUNK_TIMEOUT_MS}`,
    });
    expect(uploadFailure(new R2PutError('r2 down'))).toEqual({
      stage: 'stream_upload', reason: 'r2_put_error', detail: 'r2 down',
    });
    expect(uploadFailure(new Error('read boom'))).toEqual({
      stage: 'stream_upload', reason: 'stream_read_error', detail: 'read boom',
    });
  });
});
