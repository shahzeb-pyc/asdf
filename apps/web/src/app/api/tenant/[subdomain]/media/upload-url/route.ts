import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  canAccessTenant,
  getSessionSecret,
  UploadUrlRequestSchema,
  UploadUrlResponseSchema,
  verifySessionToken,
  type IStorageService,
} from '@fbuploadpro/contracts';
import { getStorageService } from '../../../../../../lib/storage';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';

export async function handleCreateUploadUrl(
  request: NextRequest,
  subdomain: string,
  storageService?: IStorageService
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

  // 1. Session auth guard
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Tenant isolation check
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Request payload validation
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Invalid JSON' }, { status: 400 });
  }
  const rawBody: unknown = bodyResult.value;

  const parsed = UploadUrlRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const body = parsed.data;

  // 4. Build isolated object keys
  const normalizedFileName = body.fileName.normalize('NFKC');
  let sanitizedFileName = normalizedFileName
    .replaceAll(/[/\\]/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^_+/, '');

  if (!sanitizedFileName || sanitizedFileName === '.' || sanitizedFileName.startsWith('.')) {
    const ext = body.mimeType.startsWith('image/') ? '.jpg' : '.mp4';
    sanitizedFileName = `upload_${Date.now()}${ext}`;
  }

  const mediaId = randomUUID();
  // Purpose selects the key prefix; 'library' is the historical
  // default and keeps this route's behaviour exactly. 'post-staging'
  // mints composer staged keys — bytes that belong to a post, never
  // to the library (the confirm route only accepts the library
  // prefix, so a staging key can never be confirmed into it).
  const mediaKey =
    body.purpose === 'post-staging'
      ? `users/${session.userId}/post-staging/${mediaId}/${sanitizedFileName}`
      : `users/${session.userId}/media/${mediaId}/${sanitizedFileName}`;
  const thumbnailExt = body.thumbnailMimeType === 'image/jpeg' ? 'jpeg' : 'webp';
  const thumbnailKey =
    body.purpose === 'post-staging'
      ? `users/${session.userId}/post-staging/${mediaId}/thumbnail.${thumbnailExt}`
      : `users/${session.userId}/thumbnails/${mediaId}.${thumbnailExt}`;

  // 6. Generate presigned PUT URLs via storage service
  const storage = storageService ?? getStorageService();
  const expiresInSeconds = 900;

  const [mediaResult, thumbnailResult] = await Promise.all([
    storage.getPresignedUploadUrl({
      key: mediaKey,
      contentType: body.mimeType,
      expiresInSeconds,
    }),
    storage.getPresignedUploadUrl({
      key: thumbnailKey,
      contentType: body.thumbnailMimeType,
      expiresInSeconds,
    }),
  ]);

  const responsePayload = UploadUrlResponseSchema.parse({
    mediaId,
    mediaKey,
    mediaUploadUrl: mediaResult.uploadUrl,
    thumbnailKey,
    thumbnailUploadUrl: thumbnailResult.uploadUrl,
    publicMediaUrl: mediaResult.publicUrl,
    publicThumbnailUrl: thumbnailResult.publicUrl,
    expiresInSeconds,
  });

  return NextResponse.json(responsePayload);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_upload_url', 30);
  if (limited) return limited;
  return handleCreateUploadUrl(request, subdomain);
}
