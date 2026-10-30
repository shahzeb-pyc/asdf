import { describe, it, expect } from 'vitest';
import {
  DownloadAbortedError,
  JobCancelledError,
  MediaDownloaderError,
  ResumeUnsupportedError,
} from '../src/index.js';

describe('download error types', () => {
  it('carries the wire code and a 400 default, or an explicit 502', () => {
    const error = new MediaDownloaderError('UNSAFE_URL', 'not public');
    expect(error.name).toBe('MediaDownloaderError');
    expect(error.code).toBe('UNSAFE_URL');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('not public');

    const upstream = new MediaDownloaderError('DOWNLOAD_FAILED', 'upstream', 502);
    expect(upstream.statusCode).toBe(502);
  });

  it('names the cancellation and resume signals distinctly', () => {
    expect(new DownloadAbortedError().name).toBe('DownloadAbortedError');
    expect(new ResumeUnsupportedError().name).toBe('ResumeUnsupportedError');
    expect(new JobCancelledError().name).toBe('JobCancelledError');
    expect(new DownloadAbortedError()).not.toBeInstanceOf(MediaDownloaderError);
  });
});
