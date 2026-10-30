/**
 * Download error types — the canonical location, imported by the web
 * orchestrator and the Cloudflare download consumer alike. Wire codes:
 * UNSAFE_URL, UNSUPPORTED_MEDIA, FILE_TOO_LARGE, DOWNLOAD_FAILED.
 * A cancelled job is never reported as a failure.
 */

export type DownloaderErrorCode =
  | 'UNSAFE_URL'
  | 'UNSUPPORTED_MEDIA'
  | 'FILE_TOO_LARGE'
  | 'DOWNLOAD_FAILED';

export class MediaDownloaderError extends Error {
  public readonly code: DownloaderErrorCode;
  public readonly statusCode: 400 | 502;

  constructor(code: DownloaderErrorCode, message: string, statusCode: 400 | 502 = 400) {
    super(message);
    this.name = 'MediaDownloaderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Thrown when the caller cancelled a stream (distinct from failure). */
export class DownloadAbortedError extends Error {
  constructor() {
    super('Download was cancelled.');
    this.name = 'DownloadAbortedError';
  }
}

/**
 * Thrown when a resume was requested but the source refuses Range
 * requests (answers 200 instead of 206). The caller clears the
 * checkpoint and restarts the job from byte 0 once, within the same
 * attempt — never an infinite restart loop.
 */
export class ResumeUnsupportedError extends Error {
  constructor() {
    super('Source does not support resuming; restarting from byte 0.');
    this.name = 'ResumeUnsupportedError';
  }
}

/** Thrown by the cancel check between parts when the job was cancelled. */
export class JobCancelledError extends Error {
  constructor() {
    super('Job was cancelled.');
    this.name = 'JobCancelledError';
  }
}
