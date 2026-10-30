import { describe, expect, it } from 'vitest';
import { R2MultipartSink } from '../src/r2-sink.js';
import { FakeBucket, MB } from './fakes.js';

const BASE = 'https://media.example.test';

function sinkWith(bucket: FakeBucket, key = 'users/u1/media/m1/file.mp4') {
  return new R2MultipartSink(bucket as unknown as R2Bucket, key, 'video/mp4', BASE);
}

describe('R2MultipartSink', () => {
  it('uploads in 8 MB parts and completes with the right total', async () => {
    const bucket = new FakeBucket();
    const sink = sinkWith(bucket);
    // 20 MB in 3 MB chunks: parts flush at 8 MB boundaries.
    for (let i = 0; i < 7; i += 1) {
      await sink.write(new Uint8Array(3 * MB));
    }
    // 21 MB total: parts 8 + 8 + final 5.
    const finished = await sink.finish();
    expect(finished.byteLength).toBe(21 * MB);
    expect(finished.key).toBe('users/u1/media/m1/file.mp4');
    expect(finished.publicUrl).toBe(`${BASE}/users/u1/media/m1/file.mp4`);
    const upload = [...bucket.uploads.values()][0];
    expect(upload?.completed?.partNumbers).toEqual([1, 2, 3]);
    expect(upload?.completed?.totalBytes).toBe(21 * MB);
    expect(upload?.parts.size).toBe(3);
  });

  it('aborts leave no completed object behind', async () => {
    const bucket = new FakeBucket();
    const sink = sinkWith(bucket);
    await sink.write(new Uint8Array(9 * MB));
    await sink.abort();
    const upload = [...bucket.uploads.values()][0];
    expect(upload?.aborted).toBe(true);
    expect(upload?.completed).toBeNull();
  });

  it('resumes an existing upload id with its original parts intact', async () => {
    const bucket = new FakeBucket();
    // Seed: first 8 MB uploaded as part 1 under upload-1.
    const first = sinkWith(bucket);
    await first.write(new Uint8Array(8 * MB));
    const uploadId = first.currentUploadId;
    expect(uploadId).not.toBeNull();
    expect(first.currentParts).toEqual([{ partNumber: 1, etag: 'etag-1' }]);

    // Resume: only the remaining 4 MB are written, under the same id.
    const resumed = new R2MultipartSink(
      bucket as unknown as R2Bucket,
      'users/u1/media/m1/file.mp4',
      'video/mp4',
      BASE,
      {
        resumeUploadId: uploadId ?? undefined,
        resumeParts: [{ partNumber: 1, etag: 'etag-1' }],
        initialBytes: 8 * MB,
      }
    );
    await resumed.write(new Uint8Array(4 * MB));
    const finished = await resumed.finish();
    expect(finished.byteLength).toBe(12 * MB);
    expect(resumed.currentUploadId).toBe(uploadId);
    const upload = bucket.uploads.get(uploadId ?? '');
    expect(upload?.completed?.partNumbers).toEqual([1, 2]);
    expect(upload?.completed?.totalBytes).toBe(12 * MB);
  });

  it('calls onPart after every part upload, for checkpoint + cancel checks', async () => {
    const bucket = new FakeBucket();
    const seen: number[] = [];
    const sink = new R2MultipartSink(
      bucket as unknown as R2Bucket,
      'users/u1/media/m1/file.mp4',
      'video/mp4',
      BASE,
      {
        onPart: async (info) => {
          seen.push(info.partNumber);
        },
      }
    );
    await sink.write(new Uint8Array(17 * MB));
    await sink.finish();
    expect(seen).toEqual([1, 2, 3]);
  });
});
