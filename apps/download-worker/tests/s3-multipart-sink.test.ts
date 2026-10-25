/**
 * S3MultipartSink tests (spec 149). The S3 client is a stub that
 * records commands — these tests prove part splitting, completion,
 * and abort behaviour without touching R2.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  MULTIPART_PART_SIZE_BYTES,
  S3MultipartSink,
} from '../src/r2.js';

class FakeS3 {
  readonly commands: unknown[] = [];
  uploadParts: { partNumber: number; bytes: number }[] = [];

  async send(command: unknown): Promise<Record<string, unknown>> {
    this.commands.push(command);
    if (command instanceof CreateMultipartUploadCommand) {
      return { UploadId: 'up-1' };
    }
    if (command instanceof UploadPartCommand) {
      const partNumber = command.input.PartNumber ?? 0;
      const body = command.input.Body as Uint8Array;
      this.uploadParts.push({ partNumber, bytes: body.byteLength });
      return { ETag: `etag-${partNumber}` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) {
      return {};
    }
    throw new Error('unexpected command');
  }
}

function sink(fake: FakeS3): S3MultipartSink {
  return new S3MultipartSink(
    fake as unknown as S3Client,
    'bucket',
    'media/user-1/clip.mp4',
    'video/mp4',
    'https://cdn.example.com'
  );
}

const megabytes = (n: number) => new Uint8Array(n * 1024 * 1024);

describe('S3MultipartSink', () => {
  it('splits at the part size and completes with parts in order', async () => {
    const fake = new FakeS3();
    const s = sink(fake);
    await s.write(megabytes(20));
    const finished = await s.finish();
    // 20 MB = 8 + 8 flushed during write, 4 as the final part.
    expect(fake.uploadParts).toEqual([
      { partNumber: 1, bytes: MULTIPART_PART_SIZE_BYTES },
      { partNumber: 2, bytes: MULTIPART_PART_SIZE_BYTES },
      { partNumber: 3, bytes: 4 * 1024 * 1024 },
    ]);
    expect(finished.byteLength).toBe(20 * 1024 * 1024);
    expect(finished.publicUrl).toBe('https://cdn.example.com/media/user-1/clip.mp4');
    const complete = fake.commands.find(
      (c) => c instanceof CompleteMultipartUploadCommand
    ) as CompleteMultipartUploadCommand;
    expect(complete.input.MultipartUpload?.Parts?.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
  });

  it('uploads a small file as a single final part', async () => {
    const fake = new FakeS3();
    const s = sink(fake);
    await s.write(new Uint8Array(100));
    await s.finish();
    expect(fake.uploadParts).toEqual([{ partNumber: 1, bytes: 100 }]);
  });

  it('aborts without completing', async () => {
    const fake = new FakeS3();
    const s = sink(fake);
    await s.write(megabytes(10));
    await s.abort();
    expect(fake.commands.some((c) => c instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(fake.commands.some((c) => c instanceof CompleteMultipartUploadCommand)).toBe(false);
  });

  it('refuses to finish with no parts', async () => {
    const fake = new FakeS3();
    const s = sink(fake);
    await expect(s.finish()).rejects.toThrow(/no parts/);
  });
});
