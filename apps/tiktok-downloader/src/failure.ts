/**
 * Machine-readable download failure, recorded on adu_reels for every
 * failed attempt — including attempts that return the reel to `pending`
 * for another retry, so the latest reason is always visible before the
 * reel ever reaches terminal `download_failed`.
 *
 * Detail values never contain URLs, captions, or credentials: only
 * statuses, codes, sizes, and truncated error messages.
 */

export type DownloadFailureStage =
  | 'tikwm_resolve'
  | 'stream_open'
  | 'stream_upload'
  | 'size_check'
  | 'audio_check'
  | 'pipeline';

export interface DownloadFailure {
  stage: DownloadFailureStage;
  reason: string;
  detail?: string;
}

/** Tick-summary key: groups attempts by stage + reason, not by detail. */
export function failureKey(failure: DownloadFailure): string {
  return `${failure.stage}:${failure.reason}`;
}

export function truncateDetail(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}...`;
}
