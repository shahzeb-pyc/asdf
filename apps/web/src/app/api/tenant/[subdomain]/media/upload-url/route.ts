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
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  checkStorageQuota,
  getStorageQuotaState,
  type StorageQuotaState,
} from '@/lib/billing/storage-quota';

/**
 * Quota-state provider seam, mirroring the confirm route's storage
 * verifier: production resolves the admin client and enforces the
 * plan's storage quota; tests inject a fake. When no client resolves
 * (test harnesses without a database), the check is skipped — in
 * production the admin client is always configured, so the skip is
 * unreachable there.
 */
export type UploadUrlQuotaStateProvider = (userId: string) => Promise<StorageQuotaState | null>;

async function defaultQuotaState(userId: string): Promise<StorageQuotaState | null> {
  const client = getSupabaseAdminClient();
  if (!client) return null;
  return getStorageQuotaState(client, userId);
}

export async function handleCreateUploadUrl(
  request: NextRequest,
  subdomain: string,
  storageService?: IStorageService,
  quotaStateProvider?: UploadUrlQuotaStateProvider
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

  // 3b. Storage quota gate (declared size — advisory: a presigned PUT
  // carries no size bound, so the confirm step re-checks the verified
  // size before anything lands). No active period → quota 0 → refused.
  try {
    const quotaState = await (quotaStateProvider ?? defaultQuotaState)(session.userId);
    if (quotaState) {
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
  const mediaKey = `users/${session.userId}/media/${mediaId}/${sanitizedFileName}`;
  const thumbnailExt = body.thumbnailMimeType === 'image/jpeg' ? 'jpeg' : 'webp';
  const thumbnailKey = `users/${session.userId}/thumbnails/${mediaId}.${thumbnailExt}`;

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
