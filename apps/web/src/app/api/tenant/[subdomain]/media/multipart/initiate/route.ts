import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { CreateMultipartUploadCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readJsonBody, enforceIpRateLimit, bodyTooLargeResponse } from '@/lib/request-body';
import { MultipartInitiateRequestSchema } from '@fbuploadpro/contracts';
import {
  authenticateMultipartRequest,
  getMultipartClient,
  getMultipartPublicUrl,
  sanitizeMultipartFileName,
} from '../multipart-lib';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { checkStorageQuota, getStorageQuotaState } from '@/lib/billing/storage-quota';

/**
 * Multipart step 1 (P3): create the server-side upload and mint the
 * thumbnail PUT URL. The media object itself is NOT created here —
 * it appears in R2 only when the client completes the upload, and
 * in the library only when the confirm step runs, exactly like the
 * single-PUT flow.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_multipart_initiate', 30);
  if (limited) return limited;

  const auth = await authenticateMultipartRequest(request, subdomain);
  if (auth instanceof NextResponse) return auth;
  const { session } = auth;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = MultipartInitiateRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // Storage quota gate (declared size — advisory; the confirm step
  // re-checks the verified size before anything lands). No active
  // period → quota 0 → refused. A missing admin client only happens
  // in test harnesses without a database; production always has one.
  try {
    const quotaClient = getSupabaseAdminClient();
    if (quotaClient) {
      const quotaState = await getStorageQuotaState(quotaClient, session.userId);
      const check = checkStorageQuota(quotaState, body.fileSize);
      if (!check.allowed) {
        return NextResponse.json(
          { error: 'STORAGE_QUOTA_EXCEEDED', message: check.message },
          { status: check.noQuota ? 403 : 413 }
        );
      }
    }
  } catch {
    return NextResponse.json(
      { error: 'Your storage could not be checked. Please try again.' },
      { status: 500 }
    );
  }

  const clientOrError = getMultipartClient();
  if (clientOrError instanceof NextResponse) return clientOrError;
  const { client, config } = clientOrError;

  const sanitizedFileName = sanitizeMultipartFileName(body.fileName, body.mimeType);
  const mediaId = randomUUID();
  // Purpose selects the key prefix; 'library' is the historical
  // default and keeps this route's behaviour exactly. 'post-staging'
  // mints composer staged keys (see the upload-url route's note).
  const mediaKey =
    body.purpose === 'post-staging'
      ? `users/${session.userId}/post-staging/${mediaId}/${sanitizedFileName}`
      : `users/${session.userId}/media/${mediaId}/${sanitizedFileName}`;
  const thumbnailExt = body.thumbnailMimeType === 'image/jpeg' ? 'jpeg' : 'webp';
  const thumbnailKey =
    body.purpose === 'post-staging'
      ? `users/${session.userId}/post-staging/${mediaId}/thumbnail.${thumbnailExt}`
      : `users/${session.userId}/thumbnails/${mediaId}.${thumbnailExt}`;
  const expiresInSeconds = 900;

  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: config.bucketName,
      Key: mediaKey,
      ContentType: body.mimeType,
    })
  );
  if (!created.UploadId) {
    return NextResponse.json(
      { error: 'Could not start the multipart upload' },
      { status: 502 }
    );
  }

  const thumbnailUploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: thumbnailKey,
      ContentType: body.thumbnailMimeType,
    }),
    { expiresIn: expiresInSeconds }
  );

  return NextResponse.json({
    mediaId,
    mediaKey,
    uploadId: created.UploadId,
    publicMediaUrl: getMultipartPublicUrl(config, mediaKey),
    thumbnailKey,
    thumbnailUploadUrl,
    publicThumbnailUrl: getMultipartPublicUrl(config, thumbnailKey),
    expiresInSeconds,
  });
}
