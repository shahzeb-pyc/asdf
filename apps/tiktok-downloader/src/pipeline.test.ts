import { describe, expect, it, vi } from 'vitest';
import {
  runDownloadTick,
  streamToR2,
  r2ObjectKey,
  resolveFailure,
  countikFailure,
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
import {
  COUNTIK_VIDEO_BASE_URL,
  type CountikResolveFailure,
} from './countik.js';
import { installFixedLengthStreamShim } from './fixed-length-stream-shim.js';

installFixedLengthStreamShim();

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
  putStreams: Array<ReadableStream<Uint8Array>> = [];
  deletes: string[] = [];
  throwOnPut = false;

  async put(key: string, value: ReadableStream<Uint8Array>): Promise<unknown> {
    this.puts.push(key);
    this.putStreams.push(value);
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
      // The CDN declares the length, and the production put requires it.
      return new Response(streamOf(videoBody), {
        status: 200,
        headers: { 'content-length': String(videoBody.length) },
      });
    }
    return new Response('no', { status: 404 });
  }) as unknown as FetchImpl;
}

function fakeFetchStream(videoStream: ReadableStream<Uint8Array>, apiBody: unknown, contentLength = 12000): FetchImpl {
  return (async (url: string) => {
    if (url === TIKWM_API_URL) {
      return new Response(JSON.stringify(apiBody), { status: 200 });
    }
    return new Response(videoStream, {
      status: 200,
      headers: { 'content-length': String(contentLength) },
    });
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
    // Tikwm failed, so the fallback ran too: the stub answers the
    // Countik exist call with 404, so the record carries BOTH attempts.
    expect(result.failedReasons).toEqual({ 'tikwm_resolve:tikwm_api_body_code+countik_resolve:countik_api_http_status': 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: {
          stage: 'tikwm_resolve',
          reason: 'tikwm_api_body_code',
          detail: 'body_code=1',
          fallback: { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=exist; http_status=404' },
        },
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
        failure: { stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=404; resolver=tikwm; host=cdn.example' },
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
        failure: { stage: 'stream_upload', reason: 'r2_put_error', detail: 'r2 down; resolver=tikwm; host=cdn.example' },
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
        failure: { stage: 'stream_upload', reason: 'stream_read_error', detail: 'read boom; resolver=tikwm; host=cdn.example' },
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
      streamToR2(streamOf(body), r2, 'k', { maxBytes: 100, expectedBytes: 200 }),
    ).rejects.toThrow(/cap/);
  });

  it('reports the cap breach as a typed error carrying the cap', async () => {
    const r2 = new FakeR2();
    const body = new Uint8Array(200);
    const err = await streamToR2(streamOf(body), r2, 'k', { maxBytes: 100, expectedBytes: 200 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FileTooLargeError);
    expect((err as FileTooLargeError).capBytes).toBe(100);
  });

  it('saves through the declared-length stream when the count matches', async () => {
    // The previously failing shape: the wrapped stream went straight to
    // put and workerd rejected it for an unknown length. Now the put
    // receives a FixedLengthStream declared with the response length,
    // so an exact-count stream saves with its hash intact.
    const r2 = new FakeR2();
    const body = new Uint8Array(100);
    const outcome = await streamToR2(streamOf(body), r2, 'k', { expectedBytes: 100 });
    expect(outcome.sizeBytes).toBe(100);
    expect(r2.putStreams).toHaveLength(1);
    expect(r2.objects.get('k')).toEqual(body);
  });

  it('fails loud instead of saving a short stream', async () => {
    const r2 = new FakeR2();
    const body = new Uint8Array(100);
    await expect(
      streamToR2(streamOf(body), r2, 'k', { expectedBytes: 200 }),
    ).rejects.toThrow(/delivered 100 bytes, expected 200/);
    expect(r2.objects.has('k')).toBe(false);
  });

  it('fails loud instead of saving an overlong stream', async () => {
    const r2 = new FakeR2();
    const body = new Uint8Array(200);
    await expect(
      streamToR2(streamOf(body), r2, 'k', { expectedBytes: 100 }),
    ).rejects.toThrow(/delivered 200 bytes, expected 100/);
    expect(r2.objects.has('k')).toBe(false);
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
          failure: { stage: 'stream_upload', reason: 'stream_stalled', detail: 'timeout_ms=30000; resolver=tikwm; host=cdn.example' },
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
    // The fallback ran after the tikwm failure; the scripted stub
    // answers the Countik exist call with 404, so the record carries
    // both attempts and the summary key names both reasons.
    const reason = (failure as { reason: string }).reason;
    expect(result.failedReasons).toEqual({ [`tikwm_resolve:${reason}+countik_resolve:countik_api_http_status`]: 1 });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([{
      reelId: 'reel-1',
      failure: {
        ...failure,
        fallback: { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=exist; http_status=404' },
      },
    }]);
    expect(state.downloaded).toEqual([]);
    expect(r2.puts).toEqual([]);
  });

  it('records stream_fetch_error when the video stream GET throws', async () => {
    // The throw is transient, so the open retries inside the attempt
    // (fake timers cover the backoff); the attempt still settles once.
    vi.useFakeTimers();
    try {
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
      const r2 = new FakeR2();
      const tick = runDownloadTick(
        deps(state, r2, scriptedFetch(goodTikwm(), new Error('stream down'))),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await tick;
      expect(result.failedReasons).toEqual({ 'stream_open:stream_fetch_error': 1 });
      expect(state.recorded).toEqual([
        { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_fetch_error', detail: 'stream down; resolver=tikwm; host=cdn.example' } },
      ]);
      expect(state.failed).toEqual(['reel-1']);
      expect(r2.puts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records stream_no_body when the video stream responds without a body', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, scriptedFetch(goodTikwm(), new Response(null, { status: 200 }))),
    );
    expect(result.failedReasons).toEqual({ 'stream_open:stream_no_body': 1 });
    expect(state.recorded).toEqual([
      { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_no_body', detail: 'resolver=tikwm; host=cdn.example' } },
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
      [{ reason: 'stream_fetch_error', detail: 'down' }, { stage: 'stream_open', reason: 'stream_fetch_error', detail: 'down; resolver=tikwm; host=cdn.example' }],
      [{ reason: 'stream_http_status', status: 404 }, { stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=404; resolver=tikwm; host=cdn.example' }],
      [{ reason: 'stream_no_body' }, { stage: 'stream_open', reason: 'stream_no_body', detail: 'resolver=tikwm; host=cdn.example' }],
    ];
    for (const [input, expected] of cases) expect(streamOpenFailure(input, 'tikwm', 'https://cdn.example/v.mp4')).toEqual(expected);
    // An unparsable URL still records the resolver, with an unknown host.
    expect(streamOpenFailure({ reason: 'stream_http_status', status: 525 }, 'countik', 'not a url')).toEqual({
      stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=525; resolver=countik; host=unknown',
    });
  });

  it('maps every upload failure, including the cap breach processOne cannot reach', () => {
    // file_too_large needs a >1 GiB stream through processOne, so it is
    // pinned here directly against the pure mapper instead.
    expect(uploadFailure(new FileTooLargeError(100), 'tikwm', 'https://cdn.example/v.mp4')).toEqual({
      stage: 'stream_upload', reason: 'file_too_large', detail: 'cap_bytes=100; resolver=tikwm; host=cdn.example',
    });
    expect(uploadFailure(new StreamStalledError('stalled'), 'tikwm', 'https://cdn.example/v.mp4')).toEqual({
      stage: 'stream_upload', reason: 'stream_stalled', detail: `timeout_ms=${STREAM_CHUNK_TIMEOUT_MS}; resolver=tikwm; host=cdn.example`,
    });
    expect(uploadFailure(new R2PutError('r2 down'), 'tikwm', 'https://cdn.example/v.mp4')).toEqual({
      stage: 'stream_upload', reason: 'r2_put_error', detail: 'r2 down; resolver=tikwm; host=cdn.example',
    });
    expect(uploadFailure(new Error('read boom'), 'tikwm', 'https://cdn.example/v.mp4')).toEqual({
      stage: 'stream_upload', reason: 'stream_read_error', detail: 'read boom; resolver=tikwm; host=cdn.example',
    });
  });
});

/** Fetch double routing tikwm / Countik exist / Countik info / stream by URL. */
function fallbackFetch(scripts: {
  tikwm: unknown;
  exist?: unknown;
  info?: unknown;
  stream?: unknown;
}): { fetchImpl: FetchImpl; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    let scripted: unknown;
    if (url === TIKWM_API_URL) scripted = scripts.tikwm;
    else if (url === `${COUNTIK_VIDEO_BASE_URL}/video/exist`) scripted = scripts.exist;
    else if (url.startsWith(`${COUNTIK_VIDEO_BASE_URL}/videoinfo/`)) scripted = scripts.info;
    else scripted = scripts.stream;
    if (scripted instanceof Error) throw scripted;
    return scripted as Response;
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

function countikSuccess(): { exist: Response; info: Response } {
  return {
    exist: new Response(JSON.stringify({ video_id: '740123' }), { status: 200 }),
    info: new Response(
      JSON.stringify({ download_link: 'https://v16.tokcdn.com/v.mp4', desc: 'My Countik day' }),
      { status: 200 },
    ),
  };
}

function downloadableBody(): Uint8Array {
  // Inconclusive-audio ftyp file, exactly like the tikwm success tests.
  return padTo(box('ftyp', new Uint8Array(8)), 12000);
}

describe('Countik fallback', () => {
  it('never calls Countik when tikwm succeeds', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const { fetchImpl, calls } = fallbackFetch({
      tikwm: tikwmJson({ code: 0, data: { play: 'https://cdn.example/v.mp4' } }),
      stream: new Response(streamOf(downloadableBody()), { status: 200, headers: { 'content-length': '12000' } }),
    });
    const result = await runDownloadTick(deps(state, r2, fetchImpl));
    expect(result.downloaded).toBe(1);
    expect(calls.some((c) => c.url.includes('countik.com'))).toBe(false);
  });

  it.each([
    ['tikwm_api_timeout', (() => { const e = new Error('timed out'); e.name = 'TimeoutError'; return e; })()],
    ['tikwm_api_fetch_error', new Error('tikwm down')],
    ['tikwm_api_http_status', new Response('err', { status: 500 })],
    ['tikwm_api_body_unparsable', new Response('not json', { status: 200 })],
    ['tikwm_api_bad_body', tikwmJson('just a string')],
    ['tikwm_api_body_code', tikwmJson({ code: -1, data: null })],
    ['tikwm_api_no_data', tikwmJson({ code: 0, data: null })],
    ['tikwm_no_stream_url', tikwmJson({ code: 0, data: {} })],
  ])('falls back to Countik when tikwm fails with %s', async (_name, tikwm) => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const { exist, info } = countikSuccess();
    const { fetchImpl } = fallbackFetch({
      tikwm,
      exist,
      info,
      stream: new Response(streamOf(downloadableBody()), { status: 200, headers: { 'content-length': '12000' } }),
    });
    const result = await runDownloadTick(deps(state, r2, fetchImpl));
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(state.failed).toEqual([]);
    expect(state.recorded).toEqual([]);
    expect(state.downloaded).toHaveLength(1);
  });

  it('downloads through the full pipeline on fallback success, with the Countik caption', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const { exist, info } = countikSuccess();
    const { fetchImpl } = fallbackFetch({
      tikwm: tikwmJson({ code: -1, data: null }),
      exist,
      info,
      stream: new Response(streamOf(downloadableBody()), { status: 200, headers: { 'content-length': '12000' } }),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runDownloadTick(deps(state, r2, fetchImpl));
      expect(result.downloaded).toBe(1);
      const row = state.downloaded[0];
      expect(row.objectKey).toBe('adu-buffer/cfg-1/reel-1.mp4');
      expect(row.mediaUrl).toBe('https://pub.example/adu-buffer/cfg-1/reel-1.mp4');
      expect(row.contentType).toBe('video/mp4');
      expect(row.sizeBytes).toBe(12000);
      // The Countik description survives as the caption, through the
      // same normalization as a tikwm title.
      expect(row.caption).toBe('My Countik day');
      expect(r2.objects.get('adu-buffer/cfg-1/reel-1.mp4')).toEqual(downloadableBody());
      // The resolver is observable in the tick log: a Countik success
      // leaves no failure row, so this is where the fallback path shows.
      const okLogs = logSpy.mock.calls
        .map(([arg]) => {
          try {
            return JSON.parse(String(arg)) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .filter((entry) => entry.event === 'download_ok');
      expect(okLogs).toEqual([{ event: 'download_ok', reelId: 'reel-1', resolver: 'countik' }]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('falls back to the default caption when Countik carries no description', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const { fetchImpl } = fallbackFetch({
      tikwm: tikwmJson({ code: -1, data: null }),
      exist: new Response(JSON.stringify({ video_id: '740123' }), { status: 200 }),
      info: new Response(JSON.stringify({ download_link: 'https://v16.tokcdn.com/v.mp4' }), { status: 200 }),
      stream: new Response(streamOf(downloadableBody()), { status: 200, headers: { 'content-length': '12000' } }),
    });
    const result = await runDownloadTick(deps(state, r2, fetchImpl));
    expect(result.downloaded).toBe(1);
    expect(state.downloaded[0].caption).toBe('❤️');
  });

  it('records both attempts when tikwm and Countik both fail', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const { fetchImpl } = fallbackFetch({
      tikwm: tikwmJson({ code: -1, data: null }),
      exist: new Response('blocked', { status: 403 }),
    });
    const result = await runDownloadTick(deps(state, r2, fetchImpl));
    expect(result.failed).toBe(1);
    expect(result.failedReasons).toEqual({
      'tikwm_resolve:tikwm_api_body_code+countik_resolve:countik_api_http_status': 1,
    });
    expect(state.failed).toEqual(['reel-1']);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: {
          stage: 'tikwm_resolve',
          reason: 'tikwm_api_body_code',
          detail: 'body_code=-1',
          fallback: { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=exist; http_status=403' },
        },
      },
    ]);
    expect(state.downloaded).toEqual([]);
    expect(r2.puts).toEqual([]);
  });

  it('opens the Countik stream without a tikwm Referer', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const { exist, info } = countikSuccess();
    const { fetchImpl, calls } = fallbackFetch({
      tikwm: tikwmJson({ code: -1, data: null }),
      exist,
      info,
      stream: new Response('no', { status: 404 }),
    });
    const result = await runDownloadTick(deps(state, r2, fetchImpl));
    expect(result.failedReasons).toEqual({ 'stream_open:stream_http_status': 1 });
    const streamCall = calls.find((c) => c.url === 'https://v16.tokcdn.com/v.mp4');
    expect(streamCall).toBeDefined();
    expect((streamCall?.init.headers as Record<string, string>).Referer).toBeUndefined();
  });

  it('maps every Countik resolve failure to its recorded reason', () => {
    const cases: Array<[CountikResolveFailure, unknown]> = [
      [{ reason: 'countik_api_timeout', step: 'exist' }, { stage: 'countik_resolve', reason: 'countik_api_timeout', detail: 'step=exist' }],
      [{ reason: 'countik_api_fetch_error', step: 'info', detail: 'boom' }, { stage: 'countik_resolve', reason: 'countik_api_fetch_error', detail: 'step=info; boom' }],
      [{ reason: 'countik_api_http_status', step: 'exist', status: 403 }, { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=exist; http_status=403' }],
      [{ reason: 'countik_api_body_unparsable', step: 'info' }, { stage: 'countik_resolve', reason: 'countik_api_body_unparsable', detail: 'step=info' }],
      [{ reason: 'countik_api_bad_body', step: 'exist' }, { stage: 'countik_resolve', reason: 'countik_api_bad_body', detail: 'step=exist' }],
      [{ reason: 'countik_no_video_id' }, { stage: 'countik_resolve', reason: 'countik_no_video_id', detail: 'step=exist' }],
      [{ reason: 'countik_no_download_link' }, { stage: 'countik_resolve', reason: 'countik_no_download_link', detail: 'step=info' }],
    ];
    for (const [input, expected] of cases) expect(countikFailure(input)).toEqual(expected);
  });
});

/** Fetch double routing the tikwm call and a scripted stream sequence
 * (one entry per stream attempt; the last entry repeats). */
function sequencedStreamFetch(
  tikwm: Response,
  streamScript: Array<Response | Error>,
): { fetchImpl: FetchImpl; streamCalls: string[] } {
  const streamCalls: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url === TIKWM_API_URL) return tikwm;
    streamCalls.push(url);
    const next = streamScript[Math.min(streamCalls.length - 1, streamScript.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as FetchImpl;
  return { fetchImpl, streamCalls };
}

describe('stream fixes (retry + known length + attribution)', () => {
  it('retries a transient 525 inside one attempt and then downloads', async () => {
    vi.useFakeTimers();
    try {
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
      const r2 = new FakeR2();
      const body = downloadableBody();
      const { fetchImpl, streamCalls } = sequencedStreamFetch(
        tikwmJson({ code: 0, data: { play: 'https://cdn.example/v.mp4' } }),
        [
          new Response('no', { status: 525 }),
          new Response('no', { status: 525 }),
          new Response(streamOf(body), { status: 200, headers: { 'content-length': '12000' } }),
        ],
      );
      const tick = runDownloadTick(deps(state, r2, fetchImpl));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await tick;
      expect(result.downloaded).toBe(1);
      expect(result.failed).toBe(0);
      expect(streamCalls).toHaveLength(3);
      expect(r2.objects.get('adu-buffer/cfg-1/reel-1.mp4')).toEqual(body);
      expect(r2.putStreams).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records resolver + host when a Countik stream 525 exhausts, and settles exactly once', async () => {
    vi.useFakeTimers();
    try {
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
      const r2 = new FakeR2();
      const { exist, info } = countikSuccess();
      const { fetchImpl, streamCalls } = sequencedStreamFetch(
        tikwmJson({ code: -1, data: null }),
        [new Response('no', { status: 525 })],
      );
      // Route the Countik calls through the sequenced double: tikwm -1
      // triggers the fallback, which needs exist/info answers.
      const routed = (async (url: string, init?: RequestInit) => {
        if (url === `${COUNTIK_VIDEO_BASE_URL}/video/exist`) return exist;
        if (url.startsWith(`${COUNTIK_VIDEO_BASE_URL}/videoinfo/`)) return info;
        return fetchImpl(url, init);
      }) as unknown as FetchImpl;
      const tick = runDownloadTick(deps(state, r2, routed));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await tick;
      expect(result.failedReasons).toEqual({ 'stream_open:stream_http_status': 1 });
      expect(state.recorded).toEqual([
        { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=525; resolver=countik; host=v16.tokcdn.com' } },
      ]);
      // In-attempt retries never consume extra download_retries: the
      // attempt settles exactly once.
      expect(state.failed).toEqual(['reel-1']);
      expect(streamCalls).toHaveLength(3);
      expect(r2.puts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails loud without attempting a put when Content-Length is absent', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], recorded: [] };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, scriptedFetch(goodTikwm(), new Response(streamOf(downloadableBody()), { status: 200 }))),
    );
    expect(result.failedReasons).toEqual({ 'stream_open:stream_no_content_length': 1 });
    expect(state.recorded).toEqual([
      { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_no_content_length', detail: 'resolver=tikwm; host=cdn.example' } },
    ]);
    expect(r2.puts).toEqual([]);
  });
});
