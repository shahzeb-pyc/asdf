import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { createR2S3Client, getR2Config, type R2Config } from '@/lib/storage';
import type { S3Client } from '@aws-sdk/client-s3';

/**
 * Shared helpers for the multipart (resumable) upload routes (P3).
 *
 * The multipart API deliberately bypasses the IStorageService
 * interface: that interface only knows single PUTs, and widening
 * it would ripple into the worker and the mock provider. These
 * routes talk to the same R2 bucket through the same S3 client
 * instead (R2 implements the S3 multipart calls), with the same
 * session + tenant + key-ownership checks as the single-PUT
 * upload-url route.
 */

export interface MultipartSession {
  userId: string;
}

/** Session auth + tenant isolation, mirroring the upload-url route. */
export async function authenticateMultipartRequest(
  request: NextRequest,
  subdomain: string
): Promise<{ session: MultipartSession } | NextResponse> {
  const sessionSecret = getSessionSecret();

  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return { session: { userId: session.userId } };
}

/** A multipart key must live under the caller's own users/ prefix. */
export function assertKeyOwnedBySession(
  key: string,
  session: MultipartSession
): NextResponse | null {
  if (!key.startsWith(`users/${session.userId}/`)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

/** R2 client + config, or a 503 when R2 is not configured (dev mock). */
export function getMultipartClient(): {
  client: S3Client;
  config: R2Config;
} | NextResponse {
  const config = getR2Config();
  if (!config) {
    return NextResponse.json(
      { error: 'Storage is not configured for multipart uploads' },
      { status: 503 }
    );
  }
  return { client: createR2S3Client(config), config };
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return str.slice(0, end);
}

/** Public URL for a key — same construction as R2StorageProvider. */
export function getMultipartPublicUrl(config: R2Config, key: string): string {
  const trimmedBase = trimTrailingSlashes(config.publicUrl);
  const trimmedKey = key.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedKey}`;
}

/** Filename sanitisation, identical to the upload-url route. */
export function sanitizeMultipartFileName(
  fileName: string,
  mimeType: string
): string {
  const normalizedFileName = fileName.normalize('NFKC');
  let sanitizedFileName = normalizedFileName
    .replaceAll(/[/\\]/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^_+/, '');

  if (
    !sanitizedFileName ||
    sanitizedFileName === '.' ||
    sanitizedFileName.startsWith('.')
  ) {
    const ext = mimeType.startsWith('image/') ? '.jpg' : '.mp4';
    sanitizedFileName = `upload_${Date.now()}${ext}`;
  }
  return sanitizedFileName;
}

/** True for the S3 NoSuchUpload error (vanished server-side upload). */
export function isNoSuchUploadError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'NoSuchUpload'
  );
}

/** 404 whose message carries the NoSuchUpload marker the client keys on. */
export function noSuchUploadResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Multipart upload not found (NoSuchUpload)' },
    { status: 404 }
  );
}
