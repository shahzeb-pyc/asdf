import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  IStorageService,
  PresignedUploadParams,
  PresignedUploadResult,
  PutObjectParams,
  PutObjectResult,
} from '@fbuploadpro/contracts';
import type { MediaStreamSink } from '@/lib/media-downloader/storage-upload';
import type { DownloadWorkerConfig } from './config.js';

/**
 * R2 access for the download worker (spec 149). Same endpoint, timeouts,
 * and retry bounds as the web app's R2 provider — but this module does
 * not import the web storage file: that file falls back to a test mock
 * when R2 is unconfigured, and a worker must fail loud instead.
 *
 * Multipart upload is what makes the worker stream: parts are uploaded
 * as bytes arrive, so memory stays bounded by one part buffer no matter
 * how large the file is.
 */

export const R2_MAX_ATTEMPTS = 3;
export const R2_REQUEST_TIMEOUT_MS = 15_000;
export const R2_CONNECTION_TIMEOUT_MS = 5_000;

/** Minimum S3 part size is 5 MB; 8 MB parts keep a comfortable margin. */
export const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

export function createR2Client(config: DownloadWorkerConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    maxAttempts: R2_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
      requestTimeout: R2_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) {
    end--;
  }
  return str.slice(0, end);
}

export function r2PublicUrl(config: DownloadWorkerConfig, key: string): string {
  return `${trimTrailingSlashes(config.r2PublicUrl)}/${key.replace(/^\/+/, '')}`;
}

/** IStorageService over R2 (thumbnails + cleanup; media bytes stream). */
export class R2StorageService implements IStorageService {
  private readonly client: S3Client;

  constructor(
    private readonly config: DownloadWorkerConfig,
    client?: S3Client
  ) {
    this.client = client ?? createR2Client(config);
  }

  async getPresignedUploadUrl(
    params: PresignedUploadParams
  ): Promise<PresignedUploadResult> {
    const expiresIn = params.expiresInSeconds ?? 900;
    const command = new PutObjectCommand({
      Bucket: this.config.r2BucketName,
      Key: params.key,
      ContentType: params.contentType,
    });
    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });
    return {
      uploadUrl,
      publicUrl: r2PublicUrl(this.config, params.key),
      expiresInSeconds: expiresIn,
    };
  }

  async putObject(params: PutObjectParams): Promise<PutObjectResult> {
    const command = new PutObjectCommand({
      Bucket: this.config.r2BucketName,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ContentLength: params.body.byteLength,
    });
    await this.client.send(command);
    return {
      key: params.key,
      publicUrl: r2PublicUrl(this.config, params.key),
      byteLength: params.body.byteLength,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.r2BucketName, Key: key })
    );
  }

  getPublicUrl(key: string): string {
    return r2PublicUrl(this.config, key);
  }
}

/**
 * S3 multipart sink. Upload parts are flushed whenever the buffer
 * reaches the part size; the remainder goes out as the final part on
 * finish(). Abort discards the whole multipart upload, so a cancelled
 * or oversized download leaves no partial object behind.
 */
export class S3MultipartSink implements MediaStreamSink {
  private uploadId: string | null = null;
  private partNumber = 0;
  private readonly parts: CompletedPart[] = [];
  private buffer = new Uint8Array(0);
  private totalBytes = 0;
  private finished = false;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly key: string,
    private readonly contentType: string,
    private readonly publicUrlBase: string
  ) {}

  private appendToBuffer(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
  }

  private async ensureUpload(): Promise<void> {
    if (this.uploadId) return;
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        ContentType: this.contentType,
      })
    );
    if (!created.UploadId) {
      throw new Error('S3 multipart upload did not return an upload id');
    }
    this.uploadId = created.UploadId;
  }

  /** Upload whatever is buffered as the final part (any size allowed). */
  private async flushFinalPart(): Promise<void> {
    if (this.buffer.byteLength === 0) return;
    await this.ensureUpload();
    this.partNumber += 1;
    const partNumber = this.partNumber;
    const body = this.buffer;
    this.buffer = new Uint8Array(0);
    const uploaded = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: this.uploadId as string,
        PartNumber: partNumber,
        Body: body,
      })
    );
    if (!uploaded.ETag) {
      throw new Error('S3 part upload did not return an ETag');
    }
    this.parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.finished) {
      throw new Error('Cannot write to a finished multipart sink');
    }
    this.totalBytes += chunk.byteLength;
    this.appendToBuffer(chunk);
    while (this.buffer.byteLength >= MULTIPART_PART_SIZE_BYTES) {
      // Split off exactly one part; the remainder stays buffered.
      const part = this.buffer.slice(0, MULTIPART_PART_SIZE_BYTES);
      this.buffer = this.buffer.slice(MULTIPART_PART_SIZE_BYTES);
      this.partNumber += 1;
      const partNumber = this.partNumber;
      await this.ensureUpload();
      const uploaded = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: this.key,
          UploadId: this.uploadId as string,
          PartNumber: partNumber,
          Body: part,
        })
      );
      if (!uploaded.ETag) {
        throw new Error('S3 part upload did not return an ETag');
      }
      this.parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
    }
  }

  async finish(): Promise<{ key: string; byteLength: number; publicUrl: string }> {
    if (this.finished) {
      throw new Error('Multipart sink already finished');
    }
    this.finished = true;
    await this.flushFinalPart();
    if (!this.uploadId || this.parts.length === 0) {
      throw new Error('Cannot finish a multipart upload with no parts');
    }
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: this.uploadId,
        MultipartUpload: { Parts: this.parts },
      })
    );
    return {
      key: this.key,
      byteLength: this.totalBytes,
      publicUrl: `${trimTrailingSlashes(this.publicUrlBase)}/${this.key.replace(/^\/+/, '')}`,
    };
  }

  async abort(): Promise<void> {
    this.finished = true;
    if (!this.uploadId) return;
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key,
          UploadId: this.uploadId,
        })
      );
    } catch {
      // Best effort: the upload is abandoned either way; a failed
      // abort leaves R2's own incomplete-upload lifecycle to clean up.
    }
  }
}
