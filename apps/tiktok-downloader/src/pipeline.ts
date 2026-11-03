/**
 * TikTok-only download tick.
 *
 * Flow per claimed reel (sequential: one stream at a time, so peak memory
 * is one chunk and CPU stays predictable inside a Worker tick):
 *   resolve via tikwm -> open the video stream -> stream straight to R2
 *   (hashing + 1 GiB cap + audio-probe window in the same pass) ->
 *   size/audio decision -> settle with the existing RPCs.
 *
 * There is NO fallback anywhere in this file. Any failure settles the
 * reel through `mark_adu_reel_download_failed`, which applies the
 * existing retry rules (retries < 3 -> pending, at 3 -> download_failed,
 * > 50 lifetime failures -> config creator_suspended) — and now records
 * the exact failure (stage + reason + detail) on the reel row, so the
 * next failure is diagnosable instead of just counted. Download
 * semantics are unchanged; only observability was added.
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
  MIN_FILE_BYTES,
  MAX_FILE_BYTES,
  PROBE_WINDOW_BYTES,
  STREAM_CHUNK_TIMEOUT_MS,
  type FetchImpl,
  type StreamOpenFailure,
  type TikwmResolveFailure,
} from './tikwm.js';

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
export const CONTENT_TYPE_MP4 = 'video/mp4';

export interface TickResult {
  resetCount: number;
  claimed: number;
  downloaded: number;
  failed: number;
  /** Counts keyed by `stage:reason` (detail varies per reel, so it is not a key). */
  failedReasons: Record<string, number>;
  settleErrors: number;
}

export interface TickDeps {
  supabase: SupabaseRpc;
  r2: R2BucketLike;
  r2PublicUrl: string;
  fetchImpl: FetchImpl;
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
 */
export async function streamToR2(
  body: ReadableStream<Uint8Array>,
  r2: R2BucketLike,
  key: string,
  opts?: { maxBytes?: number },
): Promise<StreamOutcome> {
  const cap = opts?.maxBytes ?? MAX_FILE_BYTES;
  const reader = body.getReader();
  const hasher = new Sha256();
  const probeChunks: Uint8Array[] = [];
  let probeBytes = 0;
  let totalBytes = 0;
  let done = false;
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

  try {
    await r2.put(key, uploadStream, { httpMetadata: { contentType: CONTENT_TYPE_MP4 } });
  } catch (err) {
    if (streamError !== undefined) throw streamError;
    throw new R2PutError(err instanceof Error ? err.message : String(err));
  }
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
  | { kind: 'downloaded' }
  | { kind: 'settle_downloaded' }
  | { kind: 'failed'; failure: DownloadFailure };

function resolveFailure(failure: TikwmResolveFailure): DownloadFailure {
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

function streamOpenFailure(failure: StreamOpenFailure): DownloadFailure {
  switch (failure.reason) {
    case 'stream_fetch_error':
      return { stage: 'stream_open', reason: 'stream_fetch_error', detail: truncateDetail(failure.detail) };
    case 'stream_http_status':
      return { stage: 'stream_open', reason: 'stream_http_status', detail: `http_status=${failure.status}` };
    case 'stream_no_body':
      return { stage: 'stream_open', reason: 'stream_no_body' };
  }
}

function uploadFailure(err: unknown): DownloadFailure {
  if (err instanceof FileTooLargeError) {
    return { stage: 'stream_upload', reason: 'file_too_large', detail: `cap_bytes=${err.capBytes}` };
  }
  if (err instanceof StreamStalledError) {
    return { stage: 'stream_upload', reason: 'stream_stalled', detail: `timeout_ms=${STREAM_CHUNK_TIMEOUT_MS}` };
  }
  if (err instanceof R2PutError) {
    return { stage: 'stream_upload', reason: 'r2_put_error', detail: truncateDetail(err.message) };
  }
  return {
    stage: 'stream_upload',
    reason: 'stream_read_error',
    detail: truncateDetail(err instanceof Error ? err.message : String(err)),
  };
}

async function processOne(deps: TickDeps, reel: ClaimedReel): Promise<ProcessOutcome> {
  const { supabase, r2, r2PublicUrl, fetchImpl } = deps;
  const videoUrl = tiktokVideoUrl(reel.sourceUsername, reel.sourceReelId);
  const resolved = await resolveTikwmStream(videoUrl, fetchImpl);
  if (!resolved.ok) {
    return { kind: 'failed', failure: resolveFailure(resolved.failure) };
  }
  const opened = await openVideoStream(resolved.streamUrl, fetchImpl);
  if (!opened.ok) {
    return { kind: 'failed', failure: streamOpenFailure(opened.failure) };
  }
  const key = r2ObjectKey(reel.configId, reel.reelId);
  let outcome: StreamOutcome;
  try {
    outcome = await streamToR2(opened.body, r2, key);
  } catch (err) {
    await deleteBestEffort(r2, key, reel.reelId);
    return { kind: 'failed', failure: uploadFailure(err) };
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
  const caption = normalizeReelCaption(resolved.rawTitle ?? DEFAULT_REEL_CAPTION, reel.sourceReelId);
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
  return { kind: 'downloaded' };
}

export async function runDownloadTick(deps: TickDeps): Promise<TickResult> {
  const result: TickResult = {
    resetCount: 0,
    claimed: 0,
    downloaded: 0,
    failed: 0,
    failedReasons: {},
    settleErrors: 0,
  };
  // Fail loud: a reset/claim error aborts the tick and surfaces in the
  // Worker's logs; the next minute's tick retries.
  result.resetCount = await deps.supabase.resetStaleDownloads(STALE_MINUTES);
  const claimed = await deps.supabase.claimTikTokDownloads(CLAIM_LIMIT);
  result.claimed = claimed.length;
  for (const reel of claimed) {
    let outcome: ProcessOutcome;
    try {
      outcome = await processOne(deps, reel);
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
      log('download_ok', { reelId: reel.reelId });
    } else if (outcome.kind === 'settle_downloaded') {
      result.settleErrors += 1;
    } else {
      result.failed += 1;
      const key = failureKey(outcome.failure);
      result.failedReasons[key] = (result.failedReasons[key] ?? 0) + 1;
      log('download_failed', { reelId: reel.reelId, ...outcome.failure });
      try {
        await deps.supabase.markDownloadFailed(reel.reelId, outcome.failure);
      } catch (err) {
        log('settle_failed_failed', {
          reelId: reel.reelId,
          error: err instanceof Error ? err.message : String(err),
        });
        result.settleErrors += 1;
      }
    }
  }
  log('tick_done', { ...result });
  return result;
}
