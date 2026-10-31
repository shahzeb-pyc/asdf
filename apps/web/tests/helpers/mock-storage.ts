import type {
  CopyObjectParams,
  ListedObject,
  ListObjectsParams,
  PresignedUploadParams,
  PresignedUploadResult,
  PutObjectParams,
  PutObjectResult,
} from '@fbuploadpro/contracts';
import type { IStorageServiceWithCopy } from '@/lib/storage';

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) {
    end--;
  }
  return str.slice(0, end);
}

export class MockStorageProvider implements IStorageServiceWithCopy {
  public deletedKeys: Set<string> = new Set();
  public requestedUploadKeys: Set<string> = new Set();
  public uploadedObjects: Map<
    string,
    { contentType: string; byteLength: number; uploadedAt: Date }
  > = new Map();
  public publicUrlBase: string = 'https://media.fbuploadpro.com';

  getPresignedUploadUrl(params: PresignedUploadParams): Promise<PresignedUploadResult> {
    const expiresIn = params.expiresInSeconds ?? 900;
    this.requestedUploadKeys.add(params.key);
    return Promise.resolve({
      uploadUrl: `https://mock-r2.fbuploadpro.com/upload/${encodeURIComponent(params.key)}?expires=${expiresIn}`,
      publicUrl: this.getPublicUrl(params.key),
      expiresInSeconds: expiresIn,
    });
  }

  putObject(params: PutObjectParams): Promise<PutObjectResult> {
    this.uploadedObjects.set(params.key, {
      contentType: params.contentType,
      byteLength: params.body.byteLength,
      uploadedAt: new Date(),
    });
    this.deletedKeys.delete(params.key);
    return Promise.resolve({
      key: params.key,
      publicUrl: this.getPublicUrl(params.key),
      byteLength: params.body.byteLength,
    });
  }

  deleteObject(key: string): Promise<void> {
    this.deletedKeys.add(key);
    this.requestedUploadKeys.delete(key);
    this.uploadedObjects.delete(key);
    return Promise.resolve();
  }

  copyObject(params: CopyObjectParams): Promise<void> {
    const source = this.uploadedObjects.get(params.sourceKey);
    if (!source) {
      return Promise.reject(new Error(`Mock storage: source key not found: ${params.sourceKey}`));
    }
    this.uploadedObjects.set(params.destinationKey, { ...source, uploadedAt: new Date() });
    this.deletedKeys.delete(params.destinationKey);
    return Promise.resolve();
  }

  listObjects(params: ListObjectsParams): Promise<ListedObject[]> {
    const limit = params.maxKeys ?? 1000;
    const out: ListedObject[] = [];
    for (const [key, value] of this.uploadedObjects.entries()) {
      if (key.startsWith(params.prefix)) {
        out.push({ key, lastModified: value.uploadedAt });
        if (out.length >= limit) break;
      }
    }
    return Promise.resolve(out);
  }

  getPublicUrl(key: string): string {
    const trimmedBase = trimTrailingSlashes(this.publicUrlBase);
    const trimmedKey = key.replace(/^\/+/, '');
    return `${trimmedBase}/${trimmedKey}`;
  }

  reset(): void {
    this.deletedKeys.clear();
    this.requestedUploadKeys.clear();
    this.uploadedObjects.clear();
  }
}

let activeMockStorage: MockStorageProvider | null = null;

export function getMockStorageProvider(): MockStorageProvider {
  activeMockStorage ??= new MockStorageProvider();
  return activeMockStorage;
}
