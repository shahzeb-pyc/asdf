/**
 * TikTok-only download tick.
 *
 * Flow per claimed reel (sequential: one stream at a time, so peak memory
 * is one chunk and CPU stays predictable inside a Worker tick):
 *   resolve via tikwm, falling back to Countik on ANY tikwm resolve
 *   failure (paced — delay + per-tick cap + 429 backoff, see
 *   countik-pacing.ts; a pacing refusal defers the reel, and the
 *   deferred reel is released through mark_adu_reel_download_failed
 *   without recording a failure: the claim already consumed one
 *   retry, the release adds none, the budget is 3 claims) -> open the
 *   video stream -> stream straight to R2
 *   (hashing + 1 GiB cap + audio-probe window in the same pass) ->
 *   size/audio decision -> settle with the existing RPCs.
 *
 * A 525 on the stream open does NOT retry the same URL (diagnosis
 * 2026-11-06: same-URL retries never save a 525 — all attempts fail
 * together on the same egress IP/edge — while a later attempt with a
 * fresh resolve sometimes succeeds). Instead the pipeline re-resolves
 * through Countik (paced, own per-tick budget) and opens the FRESH
 * URL, at most STREAM_525_MAX_RERESOLVES times per claimed reel. A
 * refused re-resolve defers the reel exactly like a refused initial
 * fallback. In-attempt re-resolves consume no extra download_retries,
 * and the claim budget stays 3 (no migration): over its life a reel
 * gets up to 3 claims x (1 + 1 re-resolve) fresh-URL attempts.
 *
 * Resolver order is fixed: tikwm FIRST, exactly as before; Countik is
 * tried only when tikwm resolve fails, and a tikwm success never calls
 * Countik. A Countik success flows through the identical downstream
 * path (same size/audio/cap/hash/R2 key/caption/settle). Any failure
 * settles the reel through `mark_adu_reel_download_failed`, which
 * applies the existing retry rules (retries < 3 -> pending, at 3 ->
 * download_failed, > 50 lifetime failures -> config creator_suspended)
 * — and is preceded by a `record_adu_reel_download_failure` call that
 * records the exact failure on the reel row. When both resolvers fail,
 * the record carries BOTH attempts (primary tikwm + fallback Countik),
 * so the next failure is diagnosable instead of just counted.
 *
 * Exclusivity: this file only ever claims through
 * `claim_tiktok_buffer_downloads` (see supabase.ts) and refuses any
 * non-TikTok row. The VPS downloader claims everything else.
 */

import { normalizeReelCaption, DEFAULT_REEL_CAPTION } from './caption.js';
import { Sha256 } from './sha256.js';
import { probeMp4Audio } from './mp4-audio.js';
import type { SupabaseRpc, ClaimedReel } from './supabase.js';
import { stripTrailingSlashes } from './supabase.js';
import {
  failureKey,
  truncateDetail,
  type DownloadFailure,
} from './failure.js';
import {
  resolveTikwmStream,
  openVideoStream,
  TIKWM_ORIGIN,
  MIN_FILE_BYTES,
  MAX_FILE_BYTES,
  PROBE_WINDOW_BYTES,
  STREAM_CHUNK_TIMEOUT_MS,
  type FetchImpl,
  type StreamOpenFailure,
  type TikwmResolveFailure,
} from './tikwm.js';
import {
  resolveCountikStream,
  type CountikResolveFailure,
} from './countik.js';
import {
  CountikPacer,
  countikPacingState,
} from './countik-pacing.js';

/** Structural subset of the Cloudflare R2 binding used here (testable). */
export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export const CLAIM_LIMIT = 10;
export const STALE_MINUTES = 40;
/** Fresh Countik re-resolves after a 525, per claimed reel. One is
 * enough per the diagnosis: the only thing proven to turn a 525 into
 * a success is a later attempt with a fresh resolve, and one fresh
 * resolve per claim (up to 6 fresh-URL attempts over the reel's
 * 3-claim life) is the even distribution — a second in-attempt
 * re-resolve would starve other reels of the shared per-tick
 * re-resolve budget for a smaller marginal gain. */
export const STREAM_525_MAX_RERESOLVES = 1;
export const CONTENT_TYPE_MP4 = 'video/mp4';

export interface TickResult {
  resetCount: number;
  claimed: number;
  downloaded: number;
  failed: number;
  /** Reels deferred by Countik pacing (cap or 429 block): never
   * attempted through the fallback, so no failure was recorded. The
   * claim already consumed one retry; the release adds none, so the
   * budget is 3 claims — a deferred reel is released through
   * mark_adu_reel_download_failed (retries < 3 -> `pending`, at 3 ->
   * `download_failed`). */
  deferred: number;
  /** Countik fallback calls actually made this tick (cap is 5). */
  countikFallbacks: number;
  /** 429 responses observed from Countik this tick. */
  countikRateLimited: number;
  /** Fresh Countik re-resolves after a 525 this tick (own budget of
   * 5 — see countik-pacing.ts). Together with countikFallbacks this
   * is every Countik call the tick made, so the tick log shows
   * whether the re-resolve path is running. */
  streamReresolves: number;
  /** Counts keyed by `stage:reason` (detail varies per reel, so it is not a key). */
  failedReasons: Record<string, number>;
  settleErrors: number;
}

export interface TickDeps {
  supabase: SupabaseRpc;
  r2: R2BucketLike;
  r2PublicUrl: string;
  fetchImpl: FetchImpl;
  /** Test seam: production runs the default pacer (module-level
   * cross-tick state); tests pass one with a fake clock. */
  countikPacer?: CountikPacer;
}

export function tiktokVideoUrl(sourceUsername: string, sourceReelId: string): string {
  // Same builder as apps/adu-downloader/sources.py for tiktok.
  return `https://www.tiktok.com/@${sourceUsername}/video/${sourceReelId}`;
}

export function r2ObjectKey(configId: string, reelId: string): string {
  // Same layout as apps/adu-downloader/r2_upload.py.
  return `adu-buffer/${configId}/${reelId}.mp4`;
}

function log(event: string, fields: Record<string, unknown>): void {
  // Never log URLs, captions, or credentials: ids and reasons only.
  console.log(JSON.stringify({ event, ...fields }));
}

/** The video stream stalled: no chunk within the per-chunk budget. */
export class StreamStalledError extends Error {}

/** The video stream breached the 1 GiB cap. */
export class FileTooLargeError extends Error {
  constructor(readonly capBytes: number) {
    super(`file exceeds the ${capBytes} byte cap`);
  }
}

/** The R2 binding itself rejected the put (distinct from a stream error). */
export class R2PutError extends Error {}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject FIRST, then cancel: cancelling resolves the pending
          // read as done=true, and promise reactions queue in order, so
          // a cancel-then-reject would let the done=true win the race
          // and a stalled stream would silently look complete (partial
          // bytes "downloaded", or a misleading too_small). Rejecting
          // first guarantees the stall surfaces as an error.
          reject(new StreamStalledError(`no chunk within ${timeoutMs} ms`));
          void reader.cancel().catch(() => undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface StreamOutcome {
  sizeBytes: number;
  sha256Hex: string;
  probeWindow: Uint8Array;
}

/**
 * Stream the video body into R2 in a single pass: each chunk updates the
 * SHA-256, enforces the 1 GiB cap, and feeds the audio-probe window.
 * Throws on cap breach, stream stall, or any read error; the caller then
 * deletes the partial object (best effort) and follows the failed path.
 *
 * The put goes through a FixedLengthStream declared with the response's
 * Content-Length: workerd's R2 binding rejects a plain stream ("Provided
 * readable stream must have a known length"), which is what the wrapped
 * upload stream used to be. The declared length also makes a short
 * stream fail loud instead of silently saving a truncated file — the
 * pipe rejects when fewer (or more) bytes arrive than declared. The
 * caller must pass the length it read from the response; there is no
 * unknown-length fallback here by design.
 */
export async function streamToR2(
  body: ReadableStream<Uint8Array>,
  r2: R2BucketLike,
  key: string,
  opts: { maxBytes?: number; expectedBytes: number },
): Promise<StreamOutcome> {
  const cap = opts.maxBytes ?? MAX_FILE_BYTES;
  const reader = body.getReader();
  const hasher = new Sha256();
  const probeChunks: Uint8Array[] = [];
  let probeBytes = 0;
  let totalBytes = 0;
  let done = false;
  // Set when the upload stream ends cleanly (used below to tell a
  // genuinely short stream from a pipe aborted mid-stream by a put
  // failure: only an ended stream with the wrong count is a length
  // mismatch). A holder object, not a plain flag: assignments inside
  // the pull closure must stay visible to the check below, and a
  // narrowed literal flag would not.
  const streamState = { ended: false };
  // Set when the upload stream itself errors (read failure, stall, cap
  // breach): r2.put then rejects with that same error, so the caller
  // must not misread it as an R2 failure. Only a put throw with no
  // stream error is an R2 failure.
  let streamError: unknown;

  const uploadStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await readWithTimeout(reader, STREAM_CHUNK_TIMEOUT_MS);
      } catch (err) {
        streamError = err;
        controller.error(err);
        return;
      }
      if (result.done) {
        done = true;
        streamState.ended = true;
        controller.close();
        return;
      }
      const chunk = result.value;
      totalBytes += chunk.length;
      if (totalBytes > cap) {
        const err = new FileTooLargeError(cap);
        streamError = err;
        controller.error(err);
        return;
      }
      hasher.update(chunk);
      if (probeBytes < PROBE_WINDOW_BYTES) {
        const take = Math.min(chunk.length, PROBE_WINDOW_BYTES - probeBytes);
        probeChunks.push(chunk.subarray(0, take));
        probeBytes += take;
      }
      controller.enqueue(chunk);
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  });

  // The upload stream feeds a FixedLengthStream, so the put always
  // carries a known length. Drain both sides before deciding, with a
  // fixed precedence that is race-free: a stream error (stall, cap,
  // read failure) beats everything; a cleanly ended stream with the
  // wrong count — or any overrun — is a length mismatch even if the
  // put also rejected as a consequence; only then is a put throw an
  // R2 failure. The put handler attaches immediately (and aborts the
  // pipe on put failure, so a dead put does not buffer the whole file)
  // so the put rejection is never unhandled while the pipe drains.
  const fixed = new FixedLengthStream(opts.expectedBytes);
  const putPromise = r2.put(key, fixed.readable, { httpMetadata: { contentType: CONTENT_TYPE_MP4 } });
  const aborter = new AbortController();
  void putPromise.then(
    () => undefined,
    () => aborter.abort(),
  );
  let pipeError: unknown;
  let pipeFailed = false;
  try {
    await uploadStream.pipeTo(fixed.writable, { signal: aborter.signal });
  } catch (err) {
    pipeFailed = true;
    pipeError = err;
  }
  let putError: unknown;
  let putFailed = false;
  try {
    await putPromise;
  } catch (err) {
    putFailed = true;
    putError = err;
  }
  if (streamError !== undefined) throw streamError;
  if ((streamState.ended || totalBytes > opts.expectedBytes) && totalBytes !== opts.expectedBytes) {
    throw new Error(`stream delivered ${totalBytes} bytes, expected ${opts.expectedBytes}`);
  }
  if (putFailed) {
    throw new R2PutError(putError instanceof Error ? putError.message : String(putError));
  }
  if (pipeFailed) throw pipeError;
  const digest = hasher.digest();
  const probeWindow = new Uint8Array(probeBytes);
  let offset = 0;
  for (const chunk of probeChunks) {
    probeWindow.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    sizeBytes: totalBytes,
    sha256Hex: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
    probeWindow,
  };
}

async function deleteBestEffort(r2: R2BucketLike, key: string, reelId: string): Promise<void> {
  try {
    await r2.delete(key);
  } catch (err) {
    log('r2_cleanup_failed', {
      reelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type ProcessOutcome =
  | { kind: 'downloaded'; resolver: 'tikwm' | 'countik' }
  | { kind: 'settle_downloaded' }
  | { kind: 'deferred'; reason: 'cap' | 'rate_limited' }
  | { kind: 'failed'; failure: DownloadFailure };

/** A Countik failure is a rate limit exactly when the API answered
 * 429, on either step (exist or info — the observed 429s are on
 * info, but the signal is the same). */
function isCountikRateLimit(failure: CountikResolveFailure): boolean {
  return failure.reason === 'countik_api_http_status' && failure.status === 429;
}

/** Pure reason mappers, exported as a test seam (like streamToR2): the
 * tick-level tests drive most of them end to end, but file_too_large
 * cannot be driven through processOne without a >1 GiB stream, and the
 * unexpected-error path needs a contract-violating dependency, so those
 * are pinned here directly. */
export function resolveFailure(failure: TikwmResolveFailure): DownloadFailure {
  switch (failure.reason) {
    case 'tikwm_api_timeout':
      return { stage: 'tikwm_resolve', reason: 'tikwm_api_timeout' };
    case 'tikwm_api_fetch_error':
      return { stage: 'tikwm_resolve', reason: 'tikwm_api_fetch_error', detail: truncateDetail(failure.detail) };
    case 'tikwm_api_http_status':
      return { stage: 'tikwm_resolve', reason: 'tikwm_api_http_status', detail: `http_status=${failure.status}` };
    case 'tikwm_api_body_unparsable':
      return { stage: 'tikwm_resolve', reason: 'tikwm_api_body_unparsable' };
    case 'tikwm_api_bad_body':
      return { stage: 'tikwm_resolve', reason: 'tikwm_api_bad_body' };
    case 'tikwm_api_body_code':
      return { stage: 'tikwm_resolve', reason: 'tikwm_api_body_code', detail: `body_code=${failure.code}` };
    case 'tikwm_api_no_data':
      return { stage: 'tikwm_resolve', reason: 'tikwm_api_no_data' };
    case 'tikwm_no_stream_url':
      return { stage: 'tikwm_resolve', reason: 'tikwm_no_stream_url' };
  }
}

/** Pure Countik reason mapper, same test-seam pattern as resolveFailure.
 * Every Countik failure names the step it failed on (exist/info), so a
 * both-fail record shows which Countik call broke, not just that
 * Countik broke. */
export function countikFailure(failure: CountikResolveFailure): DownloadFailure {
  switch (failure.reason) {
    case 'countik_api_timeout':
      return { stage: 'countik_resolve', reason: 'countik_api_timeout', detail: `step=${failure.step}` };
    case 'countik_api_fetch_error':
      return { stage: 'countik_resolve', reason: 'countik_api_fetch_error', detail: `step=${failure.step}; ${truncateDetail(failure.detail)}` };
    case 'countik_api_http_status':
      return { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: `step=${failure.step}; http_status=${failure.status}` };
    case 'countik_api_body_unparsable':
      return { stage: 'countik_resolve', reason: 'countik_api_body_unparsable', detail: `step=${failure.step}` };
    case 'countik_api_bad_body':
      return { stage: 'countik_resolve', reason: 'countik_api_bad_body', detail: `step=${failure.step}` };
    case 'countik_no_video_id':
      return { stage: 'countik_resolve', reason: 'countik_no_video_id', detail: 'step=exist' };
    case 'countik_no_download_link':
      return { stage: 'countik_resolve', reason: 'countik_no_download_link', detail: 'step=info' };
  }
}

/** Hostname only — never the full stream URL, which may carry a
 * signature. An unparsable URL records as 'unknown' rather than
 * dropping the attribution. */
function streamHost(streamUrl: string): string {
  try {
    return new URL(streamUrl).hostname;
  } catch {
    return 'unknown';
  }
}

/** Resolver + host attribution for stream-stage reasons: without it a
 * 525 row cannot say whether tikwm or Countik resolved it or which
 * host failed, and the next diagnosis starts from inference again. */
function streamAttribution(resolver: 'tikwm' | 'countik', streamUrl: string): string {
  return `resolver=${resolver}; host=${streamHost(streamUrl)}`;
}

function withAttribution(
  base: string | undefined,
  resolver: 'tikwm' | 'countik',
  streamUrl: string,
  extra?: string,
): string {
  return [base, streamAttribution(resolver, streamUrl), extra].filter(Boolean).join('; ');
}

export function streamOpenFailure(
  failure: StreamOpenFailure,
  resolver: 'tikwm' | 'countik',
  streamUrl: string,
  /** Fresh re-resolves performed before this failure was recorded (0
   * when the first URL failed): the record shows the retry path was
   * exercised instead of just counting one more 525. */
  reresolves = 0,
): DownloadFailure {
  const reresolveDetail = reresolves > 0 ? `reresolves=${reresolves}` : undefined;
  switch (failure.reason) {
    case 'stream_fetch_error':
      return { stage: 'stream_open', reason: 'stream_fetch_error', detail: withAttribution(truncateDetail(failure.detail), resolver, streamUrl, reresolveDetail) };
    case 'stream_http_status':
      return { stage: 'stream_open', reason: 'stream_http_status', detail: withAttribution(`http_status=${failure.status}`, resolver, streamUrl, reresolveDetail) };
    case 'stream_no_body':
      return { stage: 'stream_open', reason: 'stream_no_body', detail: withAttribution(undefined, resolver, streamUrl, reresolveDetail) };
  }
}

export function uploadFailure(
  err: unknown,
  resolver: 'tikwm' | 'countik',
  streamUrl: string,
): DownloadFailure {
  if (err instanceof FileTooLargeError) {
    return { stage: 'stream_upload', reason: 'file_too_large', detail: withAttribution(`cap_bytes=${err.capBytes}`, resolver, streamUrl) };
  }
  if (err instanceof StreamStalledError) {
    return { stage: 'stream_upload', reason: 'stream_stalled', detail: withAttribution(`timeout_ms=${STREAM_CHUNK_TIMEOUT_MS}`, resolver, streamUrl) };
  }
  if (err instanceof R2PutError) {
    return { stage: 'stream_upload', reason: 'r2_put_error', detail: withAttribution(truncateDetail(err.message), resolver, streamUrl) };
  }
  return {
    stage: 'stream_upload',
    reason: 'stream_read_error',
    detail: withAttribution(truncateDetail(err instanceof Error ? err.message : String(err)), resolver, streamUrl),
  };
}

async function processOne(deps: TickDeps, reel: ClaimedReel, pacer: CountikPacer): Promise<ProcessOutcome> {
  const { supabase, r2, r2PublicUrl, fetchImpl } = deps;
  const videoUrl = tiktokVideoUrl(reel.sourceUsername, reel.sourceReelId);
  // Tikwm first, exactly as before. Countik runs ONLY when tikwm
  // resolve fails — any tikwm_resolve reason — and a tikwm success
  // never touches Countik. Production evidence for the fallback:
  // tikwm answers this Worker's requests with body_code=-1 while
  // answering the identical request from elsewhere with code 0.
  const tikwm = await resolveTikwmStream(videoUrl, fetchImpl);
  let streamUrl: string;
  let rawTitle: string | null;
  let resolver: 'tikwm' | 'countik';
  if (tikwm.ok) {
    streamUrl = tikwm.streamUrl;
    rawTitle = tikwm.rawTitle;
    resolver = 'tikwm';
  } else {
    // Pacing gate: the fallback is rate-limited (see
    // countik-pacing.ts). A refused reel is DEFERRED, not failed: it
    // was never attempted through Countik, so no failure is recorded
    // for it. The claim already consumed one retry; the release in
    // runDownloadTick adds none (retries < 3 -> `pending`, at 3 ->
    // `download_failed`), so the budget is 3 claims and a deferred
    // reel can never strand in `processing`.
    const acquired = await pacer.acquire();
    if (!acquired.allowed) {
      return { kind: 'deferred', reason: acquired.reason };
    }
    const countik = await resolveCountikStream(videoUrl, fetchImpl);
    if (!countik.ok) {
      // A 429 is a real attempt, so this reel follows the failed
      // path — but it stops every later Countik call this tick.
      if (isCountikRateLimit(countik.failure)) pacer.noteRateLimited();
      // Both resolvers failed: record both attempts, primary first.
      return {
        kind: 'failed',
        failure: { ...resolveFailure(tikwm.failure), fallback: countikFailure(countik.failure) },
      };
    }
    streamUrl = countik.streamUrl;
    rawTitle = countik.rawTitle;
    resolver = 'countik';
  }
  // A Countik-resolved stream is a direct CDN link: no tikwm Referer.
  // On a 525, the URL itself is the problem, not the attempt: the
  // TLS handshake fails per request from this egress, and re-trying
  // the same URL never recovers (diagnosis 2026-11-06 — openVideoStream
  // returns a 525 on the first attempt for exactly this reason).
  // Re-resolve through Countik and open the FRESH URL instead, at most
  // STREAM_525_MAX_RERESOLVES times per claim. Each re-resolve is a
  // paced Countik call (own per-tick budget — see countik-pacing.ts),
  // so it cannot weaken pacing; a refused re-resolve defers the reel,
  // released through mark_adu_reel_download_failed with no failure
  // recorded, exactly like a refused initial fallback. The loop
  // settles exactly once downstream, so in-attempt re-resolves consume
  // no extra download_retries (the claim already consumed one).
  let reresolves = 0;
  let opened = await openVideoStream(streamUrl, fetchImpl, resolver === 'tikwm' ? TIKWM_ORIGIN : null);
  while (
    !opened.ok &&
    opened.failure.reason === 'stream_http_status' &&
    opened.failure.status === 525 &&
    reresolves < STREAM_525_MAX_RERESOLVES
  ) {
    const acquired = await pacer.acquireReresolve();
    if (!acquired.allowed) {
      return { kind: 'deferred', reason: acquired.reason };
    }
    reresolves += 1;
    const fresh = await resolveCountikStream(videoUrl, fetchImpl);
    if (!fresh.ok) {
      // A 429 is a real attempt, so it stops every later Countik call
      // this tick — and the reel follows the failed path with BOTH
      // attempts recorded: the 525 that triggered the re-resolve, plus
      // the re-resolve failure.
      if (isCountikRateLimit(fresh.failure)) pacer.noteRateLimited();
      return {
        kind: 'failed',
        failure: {
          ...streamOpenFailure(opened.failure, resolver, streamUrl, reresolves),
          fallback: countikFailure(fresh.failure),
        },
      };
    }
    streamUrl = fresh.streamUrl;
    rawTitle = fresh.rawTitle;
    resolver = 'countik';
    // A re-resolved stream is always a Countik direct CDN link: no
    // tikwm Referer, exactly like the initial Countik path.
    opened = await openVideoStream(streamUrl, fetchImpl, null);
  }
  if (!opened.ok) {
    return { kind: 'failed', failure: streamOpenFailure(opened.failure, resolver, streamUrl, reresolves) };
  }
  if (opened.contentLength === null) {
    // Fail loud: without a declared length the R2 put would be
    // rejected for an unknown-length stream, so never attempt it.
    return {
      kind: 'failed',
      failure: { stage: 'stream_open', reason: 'stream_no_content_length', detail: streamAttribution(resolver, streamUrl) },
    };
  }
  const key = r2ObjectKey(reel.configId, reel.reelId);
  let outcome: StreamOutcome;
  try {
    outcome = await streamToR2(opened.body, r2, key, { expectedBytes: opened.contentLength });
  } catch (err) {
    await deleteBestEffort(r2, key, reel.reelId);
    return { kind: 'failed', failure: uploadFailure(err, resolver, streamUrl) };
  }
  if (outcome.sizeBytes <= MIN_FILE_BYTES) {
    await deleteBestEffort(r2, key, reel.reelId);
    return {
      kind: 'failed',
      failure: { stage: 'size_check', reason: 'too_small', detail: `size_bytes=${outcome.sizeBytes}` },
    };
  }
  const audio = probeMp4Audio(outcome.probeWindow);
  if (audio === 'no-audio') {
    await deleteBestEffort(r2, key, reel.reelId);
    return { kind: 'failed', failure: { stage: 'audio_check', reason: 'no_audio' } };
  }
  const caption = normalizeReelCaption(rawTitle ?? DEFAULT_REEL_CAPTION, reel.sourceReelId);
  try {
    await supabase.markDownloaded({
      reelId: reel.reelId,
      objectKey: key,
      sizeBytes: outcome.sizeBytes,
      contentType: CONTENT_TYPE_MP4,
      sha256: outcome.sha256Hex,
      caption,
      mediaUrl: `${stripTrailingSlashes(r2PublicUrl)}/${key}`,
    });
  } catch (err) {
    // The bytes are already in R2 under a deterministic key, so a later
    // re-download overwrites them; leave the row `processing` and let the
    // stale reset return it to `pending`. Never mark it failed here: the
    // download itself succeeded.
    log('settle_downloaded_failed', {
      reelId: reel.reelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'settle_downloaded' };
  }
  return { kind: 'downloaded', resolver };
}

export async function runDownloadTick(deps: TickDeps): Promise<TickResult> {
  const result: TickResult = {
    resetCount: 0,
    claimed: 0,
    downloaded: 0,
    failed: 0,
    deferred: 0,
    countikFallbacks: 0,
    countikRateLimited: 0,
    streamReresolves: 0,
    failedReasons: {},
    settleErrors: 0,
  };
  // One pacer per tick: the cap and the 429 block reset with the tick,
  // while a 429 backoff carries across ticks through the shared
  // module-level state (warm isolates only — see countik-pacing.ts).
  const pacer = deps.countikPacer ?? new CountikPacer(countikPacingState);
  // Fail loud: a reset/claim error aborts the tick and surfaces in the
  // Worker's logs; the next minute's tick retries.
  result.resetCount = await deps.supabase.resetStaleDownloads(STALE_MINUTES);
  const claimed = await deps.supabase.claimTikTokDownloads(CLAIM_LIMIT);
  result.claimed = claimed.length;
  for (const reel of claimed) {
    let outcome: ProcessOutcome;
    try {
      outcome = await processOne(deps, reel, pacer);
    } catch (err) {
      // processOne is not expected to throw (all known failures map to a
      // reason), so an unexpected throw is logged loudly and the reel
      // follows the failed path — with the throw recorded — rather than
      // stalling the tick.
      log('download_unexpected_error', {
        reelId: reel.reelId,
        error: err instanceof Error ? err.message : String(err),
      });
      outcome = {
        kind: 'failed',
        failure: {
          stage: 'pipeline',
          reason: 'unexpected_error',
          detail: truncateDetail(err instanceof Error ? err.message : String(err)),
        },
      };
    }
    if (outcome.kind === 'downloaded') {
      result.downloaded += 1;
      // The resolver is observable in the tick log: a Countik success
      // leaves no failure row, so this is where the fallback path shows.
      log('download_ok', { reelId: reel.reelId, resolver: outcome.resolver });
    } else if (outcome.kind === 'settle_downloaded') {
      result.settleErrors += 1;
    } else if (outcome.kind === 'deferred') {
      // Pacing refused the fallback: no failure is recorded — but the
      // row must not stay `processing`. The claim already consumed
      // one retry, so leaving it claimed would strand it after 3
      // deferrals (retries = 3, still `processing`: the stale reset
      // only touches retries < 3 and no future claim ever sees it).
      // Release it through mark_adu_reel_download_failed WITHOUT a
      // recordDownloadFailure call: the RPC itself is the
      // claim-release (retries < 3 -> `pending`, immediately
      // re-claimable; at 3 -> `download_failed`, visible and
      // rescuable by the failed reset). The release adds no retry.
      result.deferred += 1;
      log('download_deferred', { reelId: reel.reelId, reason: outcome.reason });
      try {
        await deps.supabase.markDownloadFailed(reel.reelId);
      } catch (err) {
        log('release_deferred_failed', {
          reelId: reel.reelId,
          error: err instanceof Error ? err.message : String(err),
        });
        result.settleErrors += 1;
      }
    } else {
      result.failed += 1;
      const key = failureKey(outcome.failure);
      result.failedReasons[key] = (result.failedReasons[key] ?? 0) + 1;
      log('download_failed', { reelId: reel.reelId, ...outcome.failure });
      // Record first: the reason must survive even if the retry
      // accounting below fails. A record failure is loud (settle error)
      // but never blocks the status transition.
      try {
        await deps.supabase.recordDownloadFailure(reel.reelId, outcome.failure);
      } catch (err) {
        log('record_failure_failed', {
          reelId: reel.reelId,
          error: err instanceof Error ? err.message : String(err),
        });
        result.settleErrors += 1;
      }
      try {
        await deps.supabase.markDownloadFailed(reel.reelId);
      } catch (err) {
        log('settle_failed_failed', {
          reelId: reel.reelId,
          error: err instanceof Error ? err.message : String(err),
        });
        result.settleErrors += 1;
      }
    }
  }
  // Pacing observability: the tick log carries how many Countik calls
  // were made and how many 429s were seen, so a later check can tell
  // whether pacing reduced the 429 rate. The per-reel 429 is already
  // in the reel's failure detail (step=info; http_status=429).
  // streamReresolves shows whether the 525 re-resolve path is running
  // at all — together with countikFallbacks it is every Countik call
  // the tick made.
  result.countikFallbacks = pacer.callsMade;
  result.countikRateLimited = pacer.rateLimitedCount;
  result.streamReresolves = pacer.reresolvesMade;
  log('tick_done', { ...result });
  return result;
}
