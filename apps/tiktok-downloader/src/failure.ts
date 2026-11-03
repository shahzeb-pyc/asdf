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
  | 'countik_resolve'
  | 'stream_open'
  | 'stream_upload'
  | 'size_check'
  | 'audio_check'
  | 'pipeline';

/** One recorded attempt: stage + reason + optional detail. */
export interface DownloadFailureAttempt {
  stage: DownloadFailureStage;
  reason: string;
  detail?: string;
}

export interface DownloadFailure extends DownloadFailureAttempt {
  /**
   * The fallback attempt, when the primary resolver failed and the
   * fallback also failed. Only one level deep: the primary failure
   * stays the record's stage/reason, and the fallback attempt rides
   * along so the next diagnosis never hides one attempt. A success
   * on either resolver records nothing.
   */
  fallback?: DownloadFailureAttempt;
}

/** Tick-summary key: groups attempts by stage + reason, not by detail.
 * A both-fail record keys on both attempts, so the fallback reason
 * stays visible in the summary instead of collapsing into the primary. */
export function failureKey(failure: DownloadFailure): string {
  const primary = `${failure.stage}:${failure.reason}`;
  return failure.fallback
    ? `${primary}+${failure.fallback.stage}:${failure.fallback.reason}`
    : primary;
}

export function truncateDetail(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}...`;
}
