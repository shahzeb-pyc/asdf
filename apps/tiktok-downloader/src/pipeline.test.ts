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
import {
  CountikPacer,
  COUNTIK_FALLBACK_DELAY_MS,
  COUNTIK_MAX_FALLBACKS_PER_TICK,
} from './countik-pacing.js';
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
  /** Reel ids released through markDownloadFailed (failed path and
   * deferred release alike). */
  failed: string[];
  /** Reel ids whose release finalized to `download_failed` (budget
   * exhausted). */
  failedFinal: string[];
  recorded: Array<{ reelId: string; failure: unknown }>;
  /** Retry count per reel id. The fake claim increments it, modelling
   * the claim RPC's `download_retries = download_retries + 1`.
   * Tests set the pre-claim count (default 0). */
  retries: Record<string, number>;
  /** Row status per reel id. The fake claim sets `processing` (only
   * for rows that are `pending` with budget left, like the RPC);
   * markDownloadFailed applies the RPC rule (retries < 3 ->
   * `pending`, at 3 -> `download_failed`); markDownloaded sets
   * `downloaded` and resets the count to 0. */
  status: Record<string, string>;
  throwOnDownloaded?: boolean;
}

function fakeSupabase(state: FakeSupabaseState): SupabaseRpc {
  return {
    resetStaleDownloads: async () => 0,
    claimTikTokDownloads: async () => {
      const claimed: ClaimedReel[] = [];
      for (const reel of state.rows) {
        // The RPC claims only pending rows with budget left, and the
        // claim itself consumes one retry.
        if ((state.status[reel.reelId] ?? 'pending') !== 'pending') continue;
        const retries = (state.retries[reel.reelId] ?? 0) + 1;
        if (retries > 3) continue;
        state.retries[reel.reelId] = retries;
        state.status[reel.reelId] = 'processing';
        claimed.push(reel);
      }
      return claimed;
    },
    markDownloaded: async (args: MarkDownloadedArgs) => {
      if (state.throwOnDownloaded) throw new Error('db down');
      state.downloaded.push(args);
      state.status[args.reelId] = 'downloaded';
      state.retries[args.reelId] = 0;
    },
    recordDownloadFailure: async (reelId: string, failure: unknown) => {
      state.recorded.push({ reelId, failure });
    },
    markDownloadFailed: async (reelId: string) => {
      state.failed.push(reelId);
      // The RPC rule, applied exactly: retries >= 3 finalizes to
      // download_failed; anything less returns the row to pending
      // (claim-release, no failure recorded).
      if ((state.retries[reelId] ?? 0) >= 3) {
        state.status[reelId] = 'download_failed';
        state.failedFinal.push(reelId);
      } else {
        state.status[reelId] = 'pending';
      }
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
  countikPacer?: CountikPacer,
): TickDeps {
  return {
    supabase: fakeSupabase(state),
    r2,
    r2PublicUrl: 'https://pub.example',
    fetchImpl,
    ...(countikPacer ? { countikPacer } : {}),
  };
}

describe('runDownloadTick', () => {
  it('follows the failed path on API failure, without uploading', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4', title: 'TikTok' } })),
    );
    expect(state.downloaded[0].caption).toBe('❤️');
  });

  it('still moves the retry accounting when recording the reason fails', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {}, throwOnDownloaded: true };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result.settleErrors).toBe(1);
    expect(result.failed).toBe(0);
    expect(state.failed).toEqual([]);
    // The settle_downloaded path still leaves the row `processing`
    // (pre-existing: the bytes are in R2, the download succeeded, so
    // it is never marked failed — the stale reset is its way back).
    expect(state.status['reel-1']).toBe('processing');
  });

  it('handles zero claims without settling anything', async () => {
    const state: FakeSupabaseState = { rows: [], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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

/** Fetch double for the 525 re-resolve tests: tikwm is scripted, each
 * Countik info call answers from a per-call script (one fresh link
 * per resolve — a re-resolve must return a NEW URL, not the same
 * one), and each stream URL answers from its own per-call script.
 * Every 200 stream response builds a FRESH body: bodies are
 * single-use, and a 10-reel tick reads them many times. */
type InfoScriptEntry = { status: number; link?: string; desc?: string | null };
type StreamScriptEntry = { status: number; body?: Uint8Array | null };
function reresolveFetch(options: {
  tikwm?: unknown;
  info?: InfoScriptEntry[];
  streams?: Record<string, StreamScriptEntry[]>;
}): {
  fetchImpl: FetchImpl;
  counts: { tikwm: number; exist: number; info: number; stream: number };
  streamCalls: string[];
} {
  const infoScript = options.info ?? [{ status: 200, link: 'https://v16.tokcdn.com/v.mp4' }];
  const streamScripts = options.streams ?? {};
  const counts = { tikwm: 0, exist: 0, info: 0, stream: 0 };
  const streamCalls: string[] = [];
  const streamCallIndex: Record<string, number> = {};
  const fetchImpl = (async (url: string) => {
    if (url === TIKWM_API_URL) {
      counts.tikwm += 1;
      return new Response(JSON.stringify(options.tikwm ?? { code: -1, data: null }), { status: 200 });
    }
    if (url === `${COUNTIK_VIDEO_BASE_URL}/video/exist`) {
      counts.exist += 1;
      return new Response(JSON.stringify({ video_id: '740123' }), { status: 200 });
    }
    if (url.startsWith(`${COUNTIK_VIDEO_BASE_URL}/videoinfo/`)) {
      counts.info += 1;
      const entry = infoScript[Math.min(counts.info - 1, infoScript.length - 1)];
      if (entry.status !== 200) return new Response('no', { status: entry.status });
      return new Response(
        JSON.stringify({ download_link: entry.link, desc: entry.desc ?? null }),
        { status: 200 },
      );
    }
    counts.stream += 1;
    streamCalls.push(url);
    const queue = streamScripts[url] ?? [{ status: 404 }];
    const index = streamCallIndex[url] ?? 0;
    streamCallIndex[url] = index + 1;
    const entry = queue[Math.min(index, queue.length - 1)];
    if (entry.status !== 200) return new Response('no', { status: entry.status });
    const body = entry.body ?? downloadableBody();
    return new Response(streamOf(body), { status: 200, headers: { 'content-length': String(body.length) } });
  }) as unknown as FetchImpl;
  return { fetchImpl, counts, streamCalls };
}

describe('stream fixes (retry + known length + attribution)', () => {
  it('re-resolves a 525 with a fresh Countik link and then downloads', async () => {
    // Diagnosis (2026-11-06): re-trying the same URL never saves a
    // 525, but a fresh resolve sometimes does. The first URL 525s,
    // the pipeline re-resolves, and the NEW URL downloads — the retry
    // must use the new URL, never the dead one again.
    vi.useFakeTimers();
    try {
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
      const r2 = new FakeR2();
      const body = downloadableBody();
      const firstLink = 'https://v16.tokcdn.com/v-first.mp4';
      const freshLink = 'https://v16.tokcdn.com/v-fresh.mp4';
      const { fetchImpl, counts, streamCalls } = reresolveFetch({
        info: [
          { status: 200, link: firstLink, desc: 'First day' },
          { status: 200, link: freshLink, desc: 'Fresh day' },
        ],
        streams: {
          [firstLink]: [{ status: 525 }],
          [freshLink]: [{ status: 200, body }],
        },
      });
      const tick = runDownloadTick(deps(state, r2, fetchImpl));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await tick;
      expect(result.downloaded).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.streamReresolves).toBe(1);
      // The retry opened the NEW URL, not the dead one again.
      expect(streamCalls).toEqual([firstLink, freshLink]);
      expect(counts).toEqual({ tikwm: 1, exist: 2, info: 2, stream: 2 });
      expect(state.recorded).toEqual([]);
      expect(state.failed).toEqual([]);
      // The claim spent one retry; the successful download settles it
      // back to 0, exactly like a first-try download.
      expect(state.retries['reel-1']).toBe(0);
      expect(state.status['reel-1']).toBe('downloaded');
      // The fresh resolve's description is the caption.
      expect(state.downloaded[0].caption).toBe('Fresh day');
      expect(r2.objects.get('adu-buffer/cfg-1/reel-1.mp4')).toEqual(body);
      expect(r2.putStreams).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records resolver + host and the re-resolve count when a Countik stream 525 exhausts, and settles exactly once', async () => {
    vi.useFakeTimers();
    try {
      const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
      const r2 = new FakeR2();
      const firstLink = 'https://v16.tokcdn.com/v-first.mp4';
      const freshLink = 'https://v16.tokcdn.com/v-fresh.mp4';
      const { fetchImpl, counts, streamCalls } = reresolveFetch({
        info: [
          { status: 200, link: firstLink },
          { status: 200, link: freshLink },
        ],
        streams: {
          [firstLink]: [{ status: 525 }],
          [freshLink]: [{ status: 525 }],
        },
      });
      const tick = runDownloadTick(deps(state, r2, fetchImpl));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await tick;
      expect(result.failedReasons).toEqual({ 'stream_open:stream_http_status': 1 });
      expect(result.streamReresolves).toBe(1);
      expect(state.recorded).toEqual([
        { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=525; resolver=countik; host=v16.tokcdn.com; reresolves=1' } },
      ]);
      // In-attempt re-resolves never consume extra download_retries:
      // the attempt settles exactly once, and the reel returns to
      // pending with its claim's retry spent and none added.
      expect(state.failed).toEqual(['reel-1']);
      expect(state.failedFinal).toEqual([]);
      expect(state.status['reel-1']).toBe('pending');
      expect(state.retries['reel-1']).toBe(1);
      expect(counts).toEqual({ tikwm: 1, exist: 2, info: 2, stream: 2 });
      expect(streamCalls).toEqual([firstLink, freshLink]);
      expect(r2.puts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails loud without attempting a put when Content-Length is absent', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
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

/** Manual clock + recording sleep for the tick-level pacing tests:
 * the pacer is injected through TickDeps, so no real delays are ever
 * waited out and the recorded sleeps prove the spacing happened. */
function manualPacer() {
  let nowMs = 0;
  const sleeps: number[] = [];
  const pacer = new CountikPacer(
    { blockedUntilMs: 0 },
    () => nowMs,
    async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  );
  return { pacer, sleeps };
}

function reelN(n: number): ClaimedReel {
  return {
    reelId: `reel-${n}`,
    configId: 'cfg-1',
    sourcePlatform: 'tiktok',
    sourceUsername: 'someone',
    sourceReelId: `74012${n}`,
  };
}

/**
 * Fetch double for the pacing tests. Every call builds a FRESH
 * Response: bodies are single-use, and a 10-reel tick reads the tikwm
 * / exist / info / stream bodies ten times. Reusing one Response (as
 * the single-reel doubles do) would throw "body already consumed" on
 * the second reel.
 */
function pacingFetch(options: {
  existStatus?: number;
  infoStatus?: number;
  infoBody?: unknown;
}): {
  fetchImpl: FetchImpl;
  counts: { tikwm: number; exist: number; info: number; stream: number };
} {
  const counts = { tikwm: 0, exist: 0, info: 0, stream: 0 };
  const fetchImpl = (async (url: string) => {
    if (url === TIKWM_API_URL) {
      counts.tikwm += 1;
      return new Response(JSON.stringify({ code: -1, data: null }), { status: 200 });
    }
    if (url === `${COUNTIK_VIDEO_BASE_URL}/video/exist`) {
      counts.exist += 1;
      return new Response(JSON.stringify({ video_id: '740123' }), { status: options.existStatus ?? 200 });
    }
    if (url.startsWith(`${COUNTIK_VIDEO_BASE_URL}/videoinfo/`)) {
      counts.info += 1;
      return new Response(
        JSON.stringify(
          options.infoBody ?? { download_link: 'https://v16.tokcdn.com/v.mp4', desc: 'My Countik day' },
        ),
        { status: options.infoStatus ?? 200 },
      );
    }
    counts.stream += 1;
    return new Response(streamOf(downloadableBody()), {
      status: 200,
      headers: { 'content-length': '12000' },
    });
  }) as unknown as FetchImpl;
  return { fetchImpl, counts };
}

describe('Countik pacing', () => {
  it('caps fallback calls per tick and releases the rest to pending without recording failures', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => reelN(i + 1));
    const state: FakeSupabaseState = { rows, downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    const { fetchImpl, counts } = pacingFetch({});
    const { pacer, sleeps } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({
      claimed: 10,
      downloaded: COUNTIK_MAX_FALLBACKS_PER_TICK,
      deferred: 10 - COUNTIK_MAX_FALLBACKS_PER_TICK,
      failed: 0,
      countikFallbacks: COUNTIK_MAX_FALLBACKS_PER_TICK,
      countikRateLimited: 0,
    });
    // The cap is real: only the capped number of Countik calls ran,
    // and the pacing delay actually happened between them.
    expect(counts.exist).toBe(COUNTIK_MAX_FALLBACKS_PER_TICK);
    expect(counts.info).toBe(COUNTIK_MAX_FALLBACKS_PER_TICK);
    expect(counts.stream).toBe(COUNTIK_MAX_FALLBACKS_PER_TICK);
    expect(sleeps).toEqual(
      Array.from({ length: COUNTIK_MAX_FALLBACKS_PER_TICK - 1 }, () => COUNTIK_FALLBACK_DELAY_MS),
    );
    // Deferred reels were never attempted, so no failure was recorded
    // for them — but they were RELEASED through markDownloadFailed,
    // not left `processing`: each returns to `pending` with its
    // claim's retry spent and none added.
    expect(state.failed).toEqual(['reel-6', 'reel-7', 'reel-8', 'reel-9', 'reel-10']);
    expect(state.failedFinal).toEqual([]);
    expect(state.recorded).toEqual([]);
    for (let n = 6; n <= 10; n++) {
      expect(state.status[`reel-${n}`]).toBe('pending');
      expect(state.retries[`reel-${n}`]).toBe(1);
    }
    expect(state.downloaded).toHaveLength(COUNTIK_MAX_FALLBACKS_PER_TICK);
  });

  it('finalizes a deferred reel to download_failed when its claim budget is exhausted', async () => {
    // reel-6 arrives with 2 retries already spent: its claim is the
    // third, so the pacing release finalizes it instead of returning
    // it to pending. No failure is recorded for it — it was never
    // attempted — but it must be visible as download_failed, not
    // stranded in `processing`.
    const rows = Array.from({ length: 6 }, (_, i) => reelN(i + 1));
    const state: FakeSupabaseState = {
      rows,
      downloaded: [],
      failed: [],
      failedFinal: [],
      recorded: [],
      retries: { 'reel-6': 2 },
      status: {},
    };
    const r2 = new FakeR2();
    const { fetchImpl } = pacingFetch({});
    const { pacer } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({
      claimed: 6,
      downloaded: COUNTIK_MAX_FALLBACKS_PER_TICK,
      deferred: 1,
      failed: 0,
      countikFallbacks: COUNTIK_MAX_FALLBACKS_PER_TICK,
    });
    expect(state.failed).toEqual(['reel-6']);
    expect(state.failedFinal).toEqual(['reel-6']);
    expect(state.status['reel-6']).toBe('download_failed');
    expect(state.recorded).toEqual([]);
    expect(state.retries['reel-6']).toBe(3);
  });

  it('re-claims a deferred reel on the next tick: the release returns it to pending', async () => {
    // Tick 1 caps at 5, so reel-6 defers and is released to pending
    // (retries 1). Tick 2 claims it again — the only pending row —
    // and it downloads. Without the release, reel-6 would sit in
    // `processing` forever and tick 2 would claim nothing.
    const rows = Array.from({ length: 6 }, (_, i) => reelN(i + 1));
    const state: FakeSupabaseState = {
      rows,
      downloaded: [],
      failed: [],
      failedFinal: [],
      recorded: [],
      retries: {},
      status: {},
    };
    const r2 = new FakeR2();
    const { fetchImpl } = pacingFetch({});
    const first = await runDownloadTick(deps(state, r2, fetchImpl, manualPacer().pacer));
    expect(first).toMatchObject({ claimed: 6, downloaded: 5, deferred: 1 });
    expect(state.status['reel-6']).toBe('pending');
    expect(state.retries['reel-6']).toBe(1);
    const second = await runDownloadTick(deps(state, r2, fetchImpl, manualPacer().pacer));
    expect(second).toMatchObject({ claimed: 1, downloaded: 1, deferred: 0 });
    expect(state.status['reel-6']).toBe('downloaded');
    expect(state.retries['reel-6']).toBe(0);
  });

  it('stops further Countik calls for the tick on a videoinfo 429', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => reelN(i + 1));
    const state: FakeSupabaseState = { rows, downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    const { fetchImpl, counts } = pacingFetch({ infoStatus: 429, infoBody: {} });
    const { pacer } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({
      claimed: 5,
      downloaded: 0,
      deferred: 4,
      failed: 1,
      countikFallbacks: 1,
      countikRateLimited: 1,
    });
    // Exactly one Countik attempt ran; the 429 stopped the rest.
    expect(counts.exist).toBe(1);
    expect(counts.info).toBe(1);
    expect(counts.stream).toBe(0);
    // The 429 reel is a real attempt, so it settles through the failed
    // path with its failure recorded (its claim consumed one retry).
    // The deferred reels were released through markDownloadFailed with
    // no failure recorded — their claims consumed one retry each, the
    // release added none, and each returns to `pending`.
    expect(state.failed).toEqual(['reel-1', 'reel-2', 'reel-3', 'reel-4', 'reel-5']);
    expect(state.failedFinal).toEqual([]);
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: {
          stage: 'tikwm_resolve',
          reason: 'tikwm_api_body_code',
          detail: 'body_code=-1',
          fallback: { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=info; http_status=429' },
        },
      },
    ]);
    expect(result.failedReasons).toEqual({
      'tikwm_resolve:tikwm_api_body_code+countik_resolve:countik_api_http_status': 1,
    });
  });

  it('treats a 429 on the exist step the same way', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => reelN(i + 1));
    const state: FakeSupabaseState = { rows, downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    const { fetchImpl, counts } = pacingFetch({ existStatus: 429 });
    const { pacer } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({
      claimed: 3,
      deferred: 2,
      failed: 1,
      countikFallbacks: 1,
      countikRateLimited: 1,
    });
    expect(counts.exist).toBe(1);
    expect(counts.info).toBe(0);
    // The 429 reel settles through the failed path; the deferred reels
    // were released to `pending` with no failure recorded.
    expect(state.failed).toEqual(['reel-1', 'reel-2', 'reel-3']);
    expect(state.failedFinal).toEqual([]);
    for (let n = 2; n <= 3; n++) {
      expect(state.status[`reel-${n}`]).toBe('pending');
      expect(state.retries[`reel-${n}`]).toBe(1);
    }
  });

  it('reports zero pacing counts on a tick that never needs the fallback', async () => {
    const body = downloadableBody();
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    const result = await runDownloadTick(
      deps(state, r2, fakeFetch(body, { code: 0, data: { play: 'https://cdn.example/v.mp4' } })),
    );
    expect(result).toMatchObject({
      downloaded: 1,
      deferred: 0,
      failed: 0,
      countikFallbacks: 0,
      countikRateLimited: 0,
    });
  });
});

describe('525 re-resolve', () => {
  it('re-resolves a tikwm-resolved 525 through Countik and downloads', async () => {
    // The 525 path is not Countik-only: a tikwm stream that 525s
    // re-resolves through Countik too, and the fresh link downloads.
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    const cdnUrl = 'https://cdn.example/v.mp4';
    const freshLink = 'https://v16.tokcdn.com/v-fresh.mp4';
    const { fetchImpl, counts, streamCalls } = reresolveFetch({
      tikwm: { code: 0, data: { play: cdnUrl, title: 'Tikwm day' } },
      info: [{ status: 200, link: freshLink, desc: 'Fresh day' }],
      streams: {
        [cdnUrl]: [{ status: 525 }],
        [freshLink]: [{ status: 200 }],
      },
    });
    const { pacer } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({
      downloaded: 1,
      deferred: 0,
      failed: 0,
      countikFallbacks: 0,
      streamReresolves: 1,
    });
    expect(streamCalls).toEqual([cdnUrl, freshLink]);
    expect(counts).toEqual({ tikwm: 1, exist: 1, info: 1, stream: 2 });
    expect(state.recorded).toEqual([]);
    expect(state.downloaded[0].caption).toBe('Fresh day');
  });

  it('defers cleanly when the re-resolve budget is exhausted', async () => {
    // Six tikwm-resolved reels all 525; the first five re-resolve and
    // download, the sixth finds the per-tick re-resolve budget spent
    // and defers instead of failing — released to pending with no
    // failure recorded, its claim's retry spent and none added.
    const rows = Array.from({ length: 6 }, (_, i) => reelN(i + 1));
    const state: FakeSupabaseState = { rows, downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    const cdnUrl = 'https://cdn.example/v.mp4';
    const freshLinks = Array.from({ length: 5 }, (_, i) => `https://v16.tokcdn.com/v-fresh-${i + 1}.mp4`);
    const streams: Record<string, StreamScriptEntry[]> = {
      [cdnUrl]: [{ status: 525 }],
    };
    for (const link of freshLinks) streams[link] = [{ status: 200 }];
    const { fetchImpl, counts, streamCalls } = reresolveFetch({
      tikwm: { code: 0, data: { play: cdnUrl } },
      info: freshLinks.map((link) => ({ status: 200, link })),
      streams,
    });
    const { pacer, sleeps } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({
      claimed: 6,
      downloaded: 5,
      deferred: 1,
      failed: 0,
      countikFallbacks: 0,
      countikRateLimited: 0,
      streamReresolves: 5,
    });
    expect(counts).toEqual({ tikwm: 6, exist: 5, info: 5, stream: 11 });
    expect(streamCalls).toEqual([
      cdnUrl, freshLinks[0],
      cdnUrl, freshLinks[1],
      cdnUrl, freshLinks[2],
      cdnUrl, freshLinks[3],
      cdnUrl, freshLinks[4],
      cdnUrl,
    ]);
    // The spacing happened between the re-resolve calls on the shared
    // timeline; the refused sixth acquire never waited.
    expect(sleeps).toEqual(Array.from({ length: 4 }, () => COUNTIK_FALLBACK_DELAY_MS));
    expect(state.failed).toEqual(['reel-6']);
    expect(state.failedFinal).toEqual([]);
    expect(state.recorded).toEqual([]);
    expect(state.status['reel-6']).toBe('pending');
    expect(state.retries['reel-6']).toBe(1);
    expect(state.downloaded).toHaveLength(5);
  });

  it('records both attempts when the re-resolve itself is rate-limited', async () => {
    const state: FakeSupabaseState = { rows: [REEL], downloaded: [], failed: [], failedFinal: [], recorded: [], retries: {}, status: {} };
    const r2 = new FakeR2();
    const firstLink = 'https://v16.tokcdn.com/v-first.mp4';
    const { fetchImpl, counts, streamCalls } = reresolveFetch({
      info: [
        { status: 200, link: firstLink },
        { status: 429 },
      ],
      streams: {
        [firstLink]: [{ status: 525 }],
      },
    });
    const { pacer, sleeps } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({
      failed: 1,
      deferred: 0,
      countikFallbacks: 1,
      countikRateLimited: 1,
      streamReresolves: 1,
    });
    expect(result.failedReasons).toEqual({
      'stream_open:stream_http_status+countik_resolve:countik_api_http_status': 1,
    });
    expect(state.recorded).toEqual([
      {
        reelId: 'reel-1',
        failure: {
          stage: 'stream_open',
          reason: 'stream_http_status',
          detail: 'http_status=525; resolver=countik; host=v16.tokcdn.com; reresolves=1',
          fallback: { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=info; http_status=429' },
        },
      },
    ]);
    expect(state.failed).toEqual(['reel-1']);
    expect(state.failedFinal).toEqual([]);
    expect(state.status['reel-1']).toBe('pending');
    expect(state.retries['reel-1']).toBe(1);
    expect(counts).toEqual({ tikwm: 1, exist: 2, info: 2, stream: 1 });
    expect(streamCalls).toEqual([firstLink]);
    // The re-resolve waited out the spacing after the initial call.
    expect(sleeps).toEqual([COUNTIK_FALLBACK_DELAY_MS]);
  });

  it('finalizes a 525 reel to download_failed when its claim budget is exhausted', async () => {
    // reel-1 arrives with 2 retries already spent: its claim is the
    // third, so when the fresh URL 525s too, the failure finalizes it
    // instead of returning it to pending — visible and counted, never
    // stranded in `processing`.
    const state: FakeSupabaseState = {
      rows: [REEL],
      downloaded: [],
      failed: [],
      failedFinal: [],
      recorded: [],
      retries: { 'reel-1': 2 },
      status: {},
    };
    const r2 = new FakeR2();
    const firstLink = 'https://v16.tokcdn.com/v-first.mp4';
    const freshLink = 'https://v16.tokcdn.com/v-fresh.mp4';
    const { fetchImpl, counts, streamCalls } = reresolveFetch({
      info: [
        { status: 200, link: firstLink },
        { status: 200, link: freshLink },
      ],
      streams: {
        [firstLink]: [{ status: 525 }],
        [freshLink]: [{ status: 525 }],
      },
    });
    const { pacer } = manualPacer();
    const result = await runDownloadTick(deps(state, r2, fetchImpl, pacer));
    expect(result).toMatchObject({ failed: 1, deferred: 0, streamReresolves: 1 });
    expect(state.recorded).toEqual([
      { reelId: 'reel-1', failure: { stage: 'stream_open', reason: 'stream_http_status', detail: 'http_status=525; resolver=countik; host=v16.tokcdn.com; reresolves=1' } },
    ]);
    expect(state.failed).toEqual(['reel-1']);
    expect(state.failedFinal).toEqual(['reel-1']);
    expect(state.status['reel-1']).toBe('download_failed');
    expect(state.retries['reel-1']).toBe(3);
    expect(counts).toEqual({ tikwm: 1, exist: 2, info: 2, stream: 2 });
    expect(streamCalls).toEqual([firstLink, freshLink]);
  });
});
