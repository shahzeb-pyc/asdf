export interface PresignedUploadParams {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}

export interface PresignedUploadResult {
  uploadUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
}

export interface PutObjectParams {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface PutObjectResult {
  key: string;
  publicUrl: string;
  byteLength: number;
}

/**
 * Server-side object copy (media/posting separation): the copy runs
 * inside the object store, so no bytes travel through the app server.
 * Used to give a queued post its own private copy of a library file's
 * bytes — after the copy, deleting the library file can never touch
 * the post.
 */
export interface CopyObjectParams {
  sourceKey: string;
  destinationKey: string;
}

export interface ListedObject {
  key: string;
  /** Last-modified time from the object store, or null when unknown. */
  lastModified: Date | null;
}

export interface ListObjectsParams {
  prefix: string;
  maxKeys?: number;
}

export interface IStorageService {
  getPresignedUploadUrl(params: PresignedUploadParams): Promise<PresignedUploadResult>;
  putObject(params: PutObjectParams): Promise<PutObjectResult>;
  copyObject(params: CopyObjectParams): Promise<void>;
  listObjects(params: ListObjectsParams): Promise<ListedObject[]>;
  deleteObject(key: string): Promise<void>;
  getPublicUrl(key: string): string;
}

