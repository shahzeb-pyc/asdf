/**
 * Manual payment screenshot upload (submit rewrite 2026-11-01).
 *
 * The screenshot travels straight from the browser to R2 through a
 * presigned URL minted by the billing upload route — never through a
 * serverless function body. Each step gets one automatic retry on a
 * transient failure (network error or 5xx); anything else surfaces
 * immediately with a specific kind so checkout can say exactly what
 * failed and what to do. The returned storage key is what the
 * payment POST references, so a retry of the submission never
 * re-uploads: the bytes are already there.
 */

import {
  BillingScreenshotUploadUrlResponseSchema,
  type BillingScreenshotUploadUrlResponse,
} from '@fbuploadpro/contracts';
import { apiPost, buildTenantApiPath, isApiError } from '@/lib/api';

export type ScreenshotUploadErrorKind = 'network' | 'timeout' | 'rejected' | 'unknown';

export class ScreenshotUploadError extends Error {
  readonly kind: ScreenshotUploadErrorKind;
  readonly status: number | undefined;

  constructor(kind: ScreenshotUploadErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ScreenshotUploadError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ScreenshotUploadDeps {
  /** Test seam: replaces the global `fetch` for the R2 PUT. */
  fetchFn?: typeof fetch;
}

const MINT_TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 120_000;

/** AbortSignal.timeout is missing in older runtimes — no timeout then, not a crash. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

function isTransientApiError(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.kind === 'network') return true;
  return error.kind === 'http' && error.status !== undefined && error.status >= 500;
}

async function mintUploadUrl(
  subdomain: string,
  mimeType: string,
  fileSize: number
): Promise<BillingScreenshotUploadUrlResponse> {
  const signal = timeoutSignal(MINT_TIMEOUT_MS);
  return apiPost(buildTenantApiPath(subdomain, '/billing/payments/screenshot-upload'), {
    mimeType,
    fileSize,
  }, {
    schema: BillingScreenshotUploadUrlResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

async function putFile(
  uploadUrl: string,
  file: File,
  fetchFn: typeof fetch
): Promise<void> {
  let response: Response;
  try {
    const signal = timeoutSignal(PUT_TIMEOUT_MS);
    response = await fetchFn(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw new ScreenshotUploadError(
        'timeout',
        'The screenshot upload timed out. Your screenshot was not saved — try uploading again.'
      );
    }
    throw new ScreenshotUploadError(
      'network',
      'The screenshot could not be uploaded. Check your connection and try uploading again.'
    );
  }
  if (!response.ok) {
    if (response.status >= 500) {
      throw new ScreenshotUploadError(
        'network',
        'The screenshot could not be uploaded. Check your connection and try uploading again.',
        response.status
      );
    }
    throw new ScreenshotUploadError(
      'rejected',
      'The screenshot was rejected. Try a PNG, JPG, WebP, or GIF image under 10 MB.',
      response.status
    );
  }
}

/**
 * Mint a presigned URL and PUT the file to R2, with one automatic
 * retry per step on a transient failure. Returns the storage key the
 * payment POST must reference. The same key is reused across retries
 * of the submission itself — call this once per file, not per retry.
 */
export async function uploadScreenshotFile(
  subdomain: string,
  file: File,
  deps: ScreenshotUploadDeps = {}
): Promise<{ storageKey: string }> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  let minted: BillingScreenshotUploadUrlResponse | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      minted = await mintUploadUrl(subdomain, file.type, file.size);
      break;
    } catch (error) {
      if (attempt === 1 || !isTransientApiError(error)) throw error;
    }
  }
  if (!minted) {
    throw new ScreenshotUploadError('unknown', 'The screenshot upload could not start.');
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await putFile(minted.uploadUrl, file, fetchFn);
      return { storageKey: minted.storageKey };
    } catch (error) {
      const transient =
        error instanceof ScreenshotUploadError && error.kind === 'network';
      if (attempt === 1 || !transient) throw error;
    }
  }
  throw new ScreenshotUploadError('unknown', 'The screenshot upload could not finish.');
}
