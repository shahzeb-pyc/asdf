import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  PublishNowTempMediaDeleteRequestSchema,
  PublishNowTempMediaDeleteResponseSchema,
  PublishNowTempMediaRequestSchema,
  PublishNowTempMediaResponseSchema,
} from '@fbuploadpro/contracts';
import { extractConnectSession } from '@/lib/connect/session';
import { canAccessTenant } from '@fbuploadpro/contracts';
import { bodyTooLargeResponse, readJsonBody } from '@/lib/request-body';
import { getStorageService } from '@/lib/storage';
import { logServerError } from '@/lib/server-analytics';

/**
 * Temporary device media for Publish Now.
 *
 * POST issues a presigned R2 upload URL under a per-user temp
 * prefix (`users/<userId>/publish-now-temp/<uuid>/<file>`). The
 * file is uploaded straight from the browser to R2 — no
 * media_items row is ever created, so it never appears in the
 * Media Library. DELETE removes the object. The client deletes
 * the temp file when the run ends (Done, or the dialogue closing
 * after the results screen) and keeps it alive through the
 * results screen so "Retry failed only" can reuse it.
 *
 * DELETE only ever deletes keys under the caller's own temp
 * prefix — a key outside that prefix is rejected, never deleted.
 */

function tempPrefix(userId: string): string {
  return `users/${userId}/publish-now-temp/`;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const session = await extractConnectSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessTenant(session, subdomain).allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON' },
      { status: 400 }
    );
  }
  const parsed = PublishNowTempMediaRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { fileName, mimeType } = parsed.data;

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

  const key = `${tempPrefix(session.userId)}${randomUUID()}/${sanitizedFileName}`;
  let storage;
  try {
    storage = getStorageService();
  } catch (error) {
    logServerError('[publish-now temp-media] Storage unavailable', error, {
      source: 'publish-now-temp-media',
      subdomain,
    });
    return NextResponse.json(
      { error: 'Storage service unavailable' },
      { status: 500 }
    );
  }
  const result = await storage.getPresignedUploadUrl({
    key,
    contentType: mimeType,
    expiresInSeconds: 900,
  });
  return NextResponse.json(
    PublishNowTempMediaResponseSchema.parse({
      key,
      uploadUrl: result.uploadUrl,
      publicUrl: result.publicUrl,
      expiresInSeconds: 900,
    })
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const session = await extractConnectSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessTenant(session, subdomain).allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON' },
      { status: 400 }
    );
  }
  const parsed = PublishNowTempMediaDeleteRequestSchema.safeParse(
    bodyResult.value
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { key } = parsed.data;
  if (!key.startsWith(tempPrefix(session.userId)) || key.includes('..')) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Only temporary Publish Now media can be deleted here.' },
      { status: 400 }
    );
  }
  try {
    await getStorageService().deleteObject(key);
  } catch (error) {
    logServerError('[publish-now temp-media] Delete failed', error, {
      source: 'publish-now-temp-media',
      subdomain,
    });
    return NextResponse.json(
      PublishNowTempMediaDeleteResponseSchema.parse({ deleted: false }),
      { status: 500 }
    );
  }
  return NextResponse.json(
    PublishNowTempMediaDeleteResponseSchema.parse({ deleted: true })
  );
}
