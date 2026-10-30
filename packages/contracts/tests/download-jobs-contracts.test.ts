import { describe, expect, it } from 'vitest';

import {
  CancelDownloadJobRequestSchema,
  DownloadJobSchema,
  DownloadJobStatusSchema,
  DownloadJobStatusValues,
  DownloadJobsStatusResponseSchema,
  parseDownloadJobRow,
  RetryDownloadJobRequestSchema,
  SubmitDownloadJobsRequestSchema,
  SubmitDownloadJobsResponseSchema,
  toWireDownloadJobStatus,
} from '../src/index.js';

const JOB_ID = '11111111-1111-4111-a111-111111111111';
const USER_ID = '22222222-2222-4222-a222-222222222222';

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    user_id: USER_ID,
    source_url: 'https://www.tiktok.com/@creator/video/1234567890',
    source_platform: 'tiktok',
    target_folder_id: null,
    status: 'downloading',
    progress_percent: 42,
    total_bytes: 104857600,
    downloaded_bytes: 44040192,
    media_id: null,
    error_code: null,
    error_message: null,
    attempts: 1,
    claimed_at: '2026-10-25T00:00:00.000Z',
    claimed_by: 'worker-1',
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T00:01:00.000Z',
    ...overrides,
  };
}

describe('Download job statuses (spec 149)', () => {
  it('uses exactly the spec statuses', () => {
    expect(DownloadJobStatusValues).toEqual([
      'queued',
      'resolving',
      'downloading',
      'done',
      'failed',
      'cancelled',
    ]);
    for (const status of DownloadJobStatusValues) {
      expect(DownloadJobStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(DownloadJobStatusSchema.safeParse('processing').success).toBe(false);
    expect(DownloadJobStatusSchema.safeParse('completed').success).toBe(false);
    expect(DownloadJobStatusSchema.safeParse('unknown').success).toBe(false);
  });

  it('maps legacy database labels to wire statuses', () => {
    expect(toWireDownloadJobStatus('completed')).toBe('done');
    expect(toWireDownloadJobStatus('processing')).toBe('downloading');
    expect(toWireDownloadJobStatus('queued')).toBe('queued');
    expect(toWireDownloadJobStatus('bogus')).toBeNull();
  });

  it('parses a database row into its wire shape', () => {
    const job = parseDownloadJobRow(dbRow());
    expect(job).toMatchObject({
      id: JOB_ID,
      userId: USER_ID,
      status: 'downloading',
      progressPercent: 42,
    });
    expect(DownloadJobSchema.safeParse(job).success).toBe(true);
  });

  it('maps a legacy completed row to done', () => {
    expect(parseDownloadJobRow(dbRow({ status: 'completed' }))?.status).toBe('done');
  });

  it('rejects malformed rows instead of inventing a job', () => {
    expect(parseDownloadJobRow(dbRow({ progress_percent: 101 }))).toBeNull();
    expect(parseDownloadJobRow(dbRow({ status: 'bogus' }))).toBeNull();
    expect(parseDownloadJobRow(null)).toBeNull();
  });
});

describe('Download job API shapes (spec 149)', () => {
  it('validates a submit request (1–50 links, optional folder)', () => {
    expect(
      SubmitDownloadJobsRequestSchema.safeParse({
        links: ['https://example.com/a.mp4'],
        folderId: null,
      }).success
    ).toBe(true);
    expect(SubmitDownloadJobsRequestSchema.safeParse({ links: [] }).success).toBe(false);
    expect(
      SubmitDownloadJobsRequestSchema.safeParse({
        links: Array.from({ length: 51 }, (_, i) => `https://example.com/${i}.mp4`),
      }).success
    ).toBe(false);
  });

  it('validates submit/status/action responses', () => {
    const job = parseDownloadJobRow(dbRow({ status: 'done', progress_percent: 100 }));
    expect(job).not.toBeNull();
    expect(
      SubmitDownloadJobsResponseSchema.safeParse({
        jobs: [job],
        skippedDuplicates: 1,
        invalidLinks: ['not a link'],
      }).success
    ).toBe(true);
    expect(DownloadJobsStatusResponseSchema.safeParse({ jobs: [job] }).success).toBe(true);
    expect(RetryDownloadJobRequestSchema.safeParse({ jobId: JOB_ID }).success).toBe(true);
    expect(CancelDownloadJobRequestSchema.safeParse({ jobId: JOB_ID }).success).toBe(true);
    expect(RetryDownloadJobRequestSchema.safeParse({ jobId: 'nope' }).success).toBe(false);
  });
});
