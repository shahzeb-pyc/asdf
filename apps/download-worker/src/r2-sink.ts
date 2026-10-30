import {
  DOWNLOAD_MULTIPART_PART_SIZE_BYTES,
  type IStorageService,
  type PresignedUploadParams,
  type PresignedUploadResult,
  type PutObjectParams,
  type PutObjectResult,
} from '@fbuploadpro/contracts';
import type { MediaStreamSink } from './engine/stream.js';

/**
 * R2 access for the Cloudflare download consumer (spec 149 backend
 * revision §6.1). The R2 BINDING replaces the AWS SDK entirely: no
 * S3 client, no presigner, no megabytes of SDK in a Worker bundle
 * capped at 10 MB compressed. The Worker fails loudly if the binding
 * is missing — it never silently pretends to save files.
 */

export const MULTIPART_PART_SIZE_BYTES = DOWNLOAD_MULTIPART_PART_SIZE_BYTES;

export interface CheckpointPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartSinkOptions {
  /** Existing multipart upload to resume (checkpoint). */
  resumeUploadId?: string | undefined;
  /** Parts already uploaded for that upload id. */
  resumeParts?: CheckpointPart[] | undefined;
  /** Bytes already uploaded (checkpoint_bytes). */
  initialBytes?: number | undefined;
  /** Called after every part uploads successfully (checkpoint + cancel check). */
  onPart?: ((info: {
    partNumber: number;
    etag: string;
    totalBytes: number;
    parts: CheckpointPart[];
  }) => Promise<void>) | undefined;
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) {
    end--;
  }
  return str.slice(0, end);
}

export function r2PublicUrl(publicUrlBase: string, key: string): string {
  return `${trimTrailingSlashes(publicUrlBase)}/${key.replace(/^\/+/, '')}`;
}

/** IStorageService over the R2 binding (thumbnails + cleanup). */
export class R2StorageService implements IStorageService {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly publicUrlBase: string
  ) {}

  async getPresignedUploadUrl(
    _params: PresignedUploadParams
  ): Promise<PresignedUploadResult> {
    // Presigned uploads are a web-app path (browser uploads), never
    // used by the download consumer, which streams via the binding.
    throw new Error('getPresignedUploadUrl is not supported by the download consumer');
  }

  async putObject(params: PutObjectParams): Promise<PutObjectResult> {
    await this.bucket.put(params.key, params.body, {
      httpMetadata: { contentType: params.contentType },
    });
    return {
      key: params.key,
      publicUrl: r2PublicUrl(this.publicUrlBase, params.key),
      byteLength: params.body.byteLength,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  getPublicUrl(key: string): string {
    return r2PublicUrl(this.publicUrlBase, key);
  }
}

/**
 * R2 multipart sink. Parts flush whenever the buffer reaches 8 MB;
 * the remainder goes out as the final part on finish(). Abort
 * discards the whole multipart upload, so a cancelled or oversized
 * download leaves no partial object behind. Resume reuses the
 * checkpoint's upload id and already-uploaded parts — they are NOT
 * re-downloaded or re-uploaded.
 */
export class R2MultipartSink implements MediaStreamSink {
  private upload: R2MultipartUpload | null = null;
  private uploadId: string | null;
  private partNumber: number;
  private readonly parts: CheckpointPart[];
  private buffer = new Uint8Array(0);
  private totalBytes: number;
  private finished = false;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    private readonly contentType: string,
    private readonly publicUrlBase: string,
    options: R2MultipartSinkOptions = {}
  ) {
    this.uploadId = options.resumeUploadId ?? null;
    this.parts = [...(options.resumeParts ?? [])];
    this.partNumber = this.parts.reduce((max, part) => Math.max(max, part.partNumber), 0);
    this.totalBytes = options.initialBytes ?? 0;
    this.onPart = options.onPart;
  }

  private readonly onPart: R2MultipartSinkOptions['onPart'];

  get currentUploadId(): string | null {
    return this.uploadId;
  }

  get currentParts(): CheckpointPart[] {
    return [...this.parts];
  }

  get currentTotalBytes(): number {
    return this.totalBytes;
  }

  private appendToBuffer(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
  }

  private async ensureUpload(): Promise<R2MultipartUpload> {
    if (this.upload) return this.upload;
    if (this.uploadId) {
      this.upload = this.bucket.resumeMultipartUpload(this.key, this.uploadId);
      return this.upload;
    }
    const created = await this.bucket.createMultipartUpload(this.key, {
      httpMetadata: { contentType: this.contentType },
    });
    this.uploadId = created.uploadId;
    this.upload = created;
    return this.upload;
  }

  private async uploadOnePart(part: Uint8Array): Promise<void> {
    const upload = await this.ensureUpload();
    this.partNumber += 1;
    const partNumber = this.partNumber;
    const uploaded = await upload.uploadPart(partNumber, part);
    if (!uploaded.etag) {
      throw new Error('R2 part upload did not return an ETag');
    }
    this.parts.push({ partNumber, etag: uploaded.etag });
    await this.onPart?.({
      partNumber,
      etag: uploaded.etag,
      totalBytes: this.totalBytes,
      parts: this.currentParts,
    });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.finished) {
      throw new Error('Cannot write to a finished multipart sink');
    }
    this.totalBytes += chunk.byteLength;
    this.appendToBuffer(chunk);
    while (this.buffer.byteLength >= MULTIPART_PART_SIZE_BYTES) {
      const part = this.buffer.slice(0, MULTIPART_PART_SIZE_BYTES);
      this.buffer = this.buffer.slice(MULTIPART_PART_SIZE_BYTES);
      await this.uploadOnePart(part);
    }
  }

  async finish(): Promise<{ key: string; byteLength: number; publicUrl: string }> {
    if (this.finished) {
      throw new Error('Multipart sink already finished');
    }
    this.finished = true;
    if (this.buffer.byteLength > 0) {
      const body = this.buffer;
      this.buffer = new Uint8Array(0);
      await this.uploadOnePart(body);
    }
    if (!this.uploadId || this.parts.length === 0) {
      throw new Error('Cannot finish a multipart upload with no parts');
    }
    const upload = await this.ensureUpload();
    await upload.complete(
      this.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag }))
    );
    return {
      key: this.key,
      byteLength: this.totalBytes,
      publicUrl: r2PublicUrl(this.publicUrlBase, this.key),
    };
  }

  async abort(): Promise<void> {
    this.finished = true;
    if (!this.uploadId) return;
    try {
      const upload = await this.ensureUpload();
      await upload.abort();
    } catch {
      // Best effort: the upload is abandoned either way; R2's
      // incomplete-upload lifecycle cleans up the rest.
    }
  }
}
