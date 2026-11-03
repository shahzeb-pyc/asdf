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
 * > 50 lifetime failures -> config creator_suspended).
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
  resolveTikwmStream,
  openVideoStream,
  MIN_FILE_BYTES,
  MAX_FILE_BYTES,
  PROBE_WINDOW_BYTES,
  STREAM_CHUNK_TIMEOUT_MS,
  type FetchImpl,
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

export type FailReason =
  | 'api'
  | 'stream'
  | 'upload'
  | 'too_small'
  | 'no_audio'
  | 'settle_downloaded';

export interface TickResult {
  resetCount: number;
  claimed: number;
  downloaded: number;
  failed: number;
  failedReasons: Partial<Record<FailReason, number>>;
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

class StreamAbortedError extends Error {}

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
          void reader.cancel().catch(() => undefined);
          reject(new StreamAbortedError(`no chunk within ${timeoutMs} ms`));
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
        controller.error(
          new StreamAbortedError(`file exceeds the ${cap} byte cap`),
        );
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

  await r2.put(key, uploadStream, { httpMetadata: { contentType: CONTENT_TYPE_MP4 } });
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

async function processOne(deps: TickDeps, reel: ClaimedReel): Promise<'downloaded' | FailReason> {
  const { supabase, r2, r2PublicUrl, fetchImpl } = deps;
  const videoUrl = tiktokVideoUrl(reel.sourceUsername, reel.sourceReelId);
  const resolved = await resolveTikwmStream(videoUrl, fetchImpl);
  if (!resolved) {
    return 'api';
  }
  const body = await openVideoStream(resolved.streamUrl, fetchImpl);
  if (!body) {
    return 'stream';
  }
  const key = r2ObjectKey(reel.configId, reel.reelId);
  let outcome: StreamOutcome;
  try {
    outcome = await streamToR2(body, r2, key);
  } catch (err) {
    log('download_stream_failed', {
      reelId: reel.reelId,
      error: err instanceof Error ? err.message : String(err),
    });
    await deleteBestEffort(r2, key, reel.reelId);
    return 'upload';
  }
  if (outcome.sizeBytes <= MIN_FILE_BYTES) {
    log('download_rejected', { reelId: reel.reelId, reason: 'too_small', sizeBytes: outcome.sizeBytes });
    await deleteBestEffort(r2, key, reel.reelId);
    return 'too_small';
  }
  const audio = probeMp4Audio(outcome.probeWindow);
  if (audio === 'no-audio') {
    log('download_rejected', { reelId: reel.reelId, reason: 'no_audio' });
    await deleteBestEffort(r2, key, reel.reelId);
    return 'no_audio';
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
    return 'settle_downloaded';
  }
  return 'downloaded';
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
    let outcome: 'downloaded' | FailReason;
    try {
      outcome = await processOne(deps, reel);
    } catch (err) {
      // processOne is not expected to throw (all known failures map to a
      // reason), so an unexpected throw is logged loudly and the reel
      // follows the failed path rather than stalling the tick.
      log('download_unexpected_error', {
        reelId: reel.reelId,
        error: err instanceof Error ? err.message : String(err),
      });
      outcome = 'upload';
    }
    if (outcome === 'downloaded') {
      result.downloaded += 1;
      log('download_ok', { reelId: reel.reelId });
    } else if (outcome === 'settle_downloaded') {
      result.settleErrors += 1;
    } else {
      result.failed += 1;
      result.failedReasons[outcome] = (result.failedReasons[outcome] ?? 0) + 1;
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
  log('tick_done', { ...result });
  return result;
}
