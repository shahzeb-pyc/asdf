import { type NextRequest, NextResponse } from 'next/server';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  type DatabaseMediaItemRow,
  canAccessTenant,
  ConfirmUploadRequestSchema,
  deriveDefaultCaptionFromFilename,
  getSessionSecret,
  MediaItemResponseSchema,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError, trackServerEvent } from '@/lib/server-analytics';
import {
  checkStorageQuota,
  getStorageQuotaState,
  type StorageQuotaState,
} from '@/lib/billing/storage-quota';
import {
  createR2S3Client,
  getR2Config,
  getStorageService,
  R2StorageProvider,
} from '../../../../../../lib/storage';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Media row as the handlers consume it (spec 137 §3.7): the contracts
 * row minus workspace_id (not projected by these selects), plus the
 * width/height columns the contracts type does not model yet. */
type MediaItemRow = Omit<DatabaseMediaItemRow, 'workspace_id'> & {
  width: number | null;
  height: number | null;
};

/**
 * Server-side view of an object already uploaded to storage (spec 139).
 *
 * The shared storage service (`IStorageService`) has no head-object
 * operation, so confirmation verifies existence through this narrow
 * interface instead: the production implementation below issues a raw
 * HeadObject call with the existing R2 client/config helpers from
 * `lib/storage`, and tests inject a fake. Only the metadata the confirm
 * step is allowed to trust is exposed.
 */
export interface StorageObjectMetadata {
  contentLength: number;
  contentType?: string | undefined;
}

export interface MediaStorageVerifier {
  /** Resolves to the object's metadata, or `null` when it does not exist. */
  headObject(key: string): Promise<StorageObjectMetadata | null>;
  /** Derives the stored public URL for a key, exactly as upload-url does. */
  getPublicUrl(key: string): string;
}

function isStorageNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const candidate = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === '404' ||
    candidate.Code === 'NoSuchKey'
  );
}

export function createDefaultMediaStorageVerifier(): MediaStorageVerifier {
  const config = getR2Config();
  if (config) {
    const client = createR2S3Client(config);
    const provider = new R2StorageProvider(config, client);
    return {
      async headObject(key: string) {
        try {
          const result = await client.send(
            new HeadObjectCommand({ Bucket: config.bucketName, Key: key })
          );
          if (typeof result.ContentLength !== 'number') {
            return null;
          }
          return {
            contentLength: result.ContentLength,
            contentType: result.ContentType,
          };
        } catch (err) {
          if (isStorageNotFoundError(err)) {
            return null;
          }
          throw err;
        }
      },
      getPublicUrl: (key: string) => provider.getPublicUrl(key),
    };
  }

  // No R2 configuration: outside production this resolves to the shared
  // mock storage provider, whose uploaded-object registry is the record
  // of what was actually uploaded. In production getStorageService()
  // throws, which the caller turns into a generic failure — an upload
  // is never confirmed without verification.
  const storage = getStorageService();
  return {
    headObject(key: string) {
      const uploadedObjects = (
        storage as unknown as {
          uploadedObjects?: Map<string, { contentType: string; byteLength: number }>;
        }
      ).uploadedObjects;
      const entry = uploadedObjects?.get(key);
      if (!entry) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        contentLength: entry.byteLength,
        contentType: entry.contentType,
      });
    },
    getPublicUrl: (key: string) => storage.getPublicUrl(key),
  };
}

function uploadVerificationFailed(): NextResponse {
  // One plain-language message for every verification failure: it does
  // not reveal whether the problem was ownership, the file, or its size.
  return NextResponse.json(
    {
      error: 'INVALID_REQUEST',
      message: 'We could not verify this upload. Please try uploading the file again.',
    },
    { status: 400 }
  );
}

/**
 * Quota-state provider seam, mirroring the storage verifier: tests
 * inject a fake; production resolves a client from the injected
 * database client or the admin client. When no client resolves
 * (test harnesses without a database), the check is skipped — in
 * production a client always resolves, so the skip is unreachable
 * there.
 */
export type ConfirmQuotaStateProvider = (userId: string) => Promise<StorageQuotaState | null>;

async function defaultConfirmQuotaState(
  dbClient: DatabaseClient | SupabaseClient | undefined,
  userId: string
): Promise<StorageQuotaState | null> {
  if (dbClient && 'from' in dbClient && typeof dbClient.from === 'function') {
    return getStorageQuotaState(dbClient as SupabaseClient, userId);
  }
  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    return getStorageQuotaState(dbClient as DatabaseClient, userId);
  }
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  return getStorageQuotaState(admin, userId);
}

export async function handleConfirmUpload(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient,
  storageVerifier?: MediaStorageVerifier,
  quotaStateProvider?: ConfirmQuotaStateProvider
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
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON' },
      { status: 400 }
    );
  }

  const parsed = ConfirmUploadRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const body = parsed.data;

  const resolvedCaptionText =
    body.captionText !== undefined
      ? body.captionText
      : deriveDefaultCaptionFromFilename(body.name);

  // 4. Verify the upload against storage before anything is saved
  // (spec 139). The client-supplied storage key, URL and file size are
  // never trusted: the key must be the one upload-url minted for this
  // user and this media item, the object must actually exist, and the
  // stored size, content type and URL all come from storage itself.
  //
  // The ownership check runs before the existence check so a key that
  // belongs to someone else is never even probed in storage.
  const expectedMediaKeyPrefix = `users/${session.userId}/media/${body.mediaId}/`;
  if (!body.storageKey.startsWith(expectedMediaKeyPrefix)) {
    return uploadVerificationFailed();
  }
  const uploadedFileName = body.storageKey.slice(expectedMediaKeyPrefix.length);
  if (
    uploadedFileName.length === 0 ||
    uploadedFileName.includes('/') ||
    uploadedFileName.includes('\\')
  ) {
    return uploadVerificationFailed();
  }

  let verifier: MediaStorageVerifier;
  let objectMetadata: StorageObjectMetadata | null;
  let verifiedUrl: string;
  let verifiedThumbnailKey: string | null = null;
  let verifiedThumbnailUrl: string | null = null;
  try {
    verifier = storageVerifier ?? createDefaultMediaStorageVerifier();

    if (body.thumbnailKey) {
      // Thumbnails are minted by upload-url under the same user's
      // thumbnails prefix for this media item; the stored thumbnail URL
      // is derived from that key, never taken from the request. (The
      // thumbnail itself stays best-effort, so it is not head-checked —
      // only the main media object is.)
      const expectedThumbnailKeyPrefix = `users/${session.userId}/thumbnails/${body.mediaId}.`;
      if (!body.thumbnailKey.startsWith(expectedThumbnailKeyPrefix)) {
        return uploadVerificationFailed();
      }
      verifiedThumbnailKey = body.thumbnailKey;
      verifiedThumbnailUrl = verifier.getPublicUrl(body.thumbnailKey);
    }

    objectMetadata = await verifier.headObject(body.storageKey);
    verifiedUrl = verifier.getPublicUrl(body.storageKey);
  } catch (err) {
    logServerError('[media/confirm] Failed to confirm media upload', err, {
      source: 'media-confirm',
      subdomain,
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to confirm media upload' },
      { status: 500 }
    );
  }

  if (
    !objectMetadata ||
    !Number.isInteger(objectMetadata.contentLength) ||
    objectMetadata.contentLength <= 0
  ) {
    return uploadVerificationFailed();
  }

  const verifiedFileSize = objectMetadata.contentLength;
  const verifiedMimeType = objectMetadata.contentType?.trim()
    ? objectMetadata.contentType.trim()
    : body.mimeType;

  // Storage quota gate on VERIFIED bytes — the real enforcement.
  // Upload start only saw the client-declared size, which a caller
  // can understate; nothing lands here over quota. No active period
  // → quota 0 → refused. Usage sums live rows only, so deleting a
  // file frees its quota immediately.
  try {
    const quotaState = await (quotaStateProvider ?? ((userId: string) => defaultConfirmQuotaState(dbClient, userId)))(
      session.userId
    );
    if (quotaState) {
      const check = checkStorageQuota(quotaState, verifiedFileSize);
      if (!check.allowed) {
        return NextResponse.json(
          { error: 'STORAGE_QUOTA_EXCEEDED', message: check.message },
          { status: check.noQuota ? 403 : 413 }
        );
      }
    }
  } catch (err) {
    logServerError('[media/confirm] Failed to check storage quota', err, {
      source: 'media-confirm',
      subdomain,
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to confirm media upload' },
      { status: 500 }
    );
  }

  try {
    let insertedRow: MediaItemRow;

    if (
      dbClient &&
      (('query' in dbClient && typeof (dbClient as unknown as Record<string, unknown>).query === 'function') ||
        ('withTransaction' in dbClient && typeof (dbClient as unknown as Record<string, unknown>).withTransaction === 'function'))
    ) {
      const executeInsert = async (tx: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: MediaItemRow[]; rowCount?: number }>;
      }) => {
        const insertRes = await tx.query(
          `INSERT INTO media_items (
             id, user_id, folder_id, name, file_size, mime_type, media_type,
             storage_key, url, thumbnail_key, thumbnail_url, duration_seconds,
             aspect_ratio, caption_text, width, height, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12,
             $13, $14, $15, $16, now(), now()
           )
           RETURNING *`,
          [
            body.mediaId,
            session.userId,
            body.folderId ?? null,
            body.name,
            verifiedFileSize,
            verifiedMimeType,
            body.mediaType,
            body.storageKey,
            verifiedUrl,
            verifiedThumbnailKey,
            verifiedThumbnailUrl,
            body.durationSeconds ?? null,
            body.aspectRatio ?? 'unknown',
            resolvedCaptionText,
            body.width ?? null,
            body.height ?? null,
          ]
        );

        return insertRes.rows[0];
      };

      if (typeof dbClient.withTransaction === 'function') {
        insertedRow = await dbClient.withTransaction(executeInsert);
      } else {
        insertedRow = await executeInsert({
          query: async (sql, params) => {
            const rows = await dbClient.query<MediaItemRow>(sql, params);
            return { rows, rowCount: rows.length };
          },
        });
      }
    } else {
      const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
      if (!supabase) {
        return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
      }

      const { data, error } = await supabase
        .from('media_items')
        .insert({
          id: body.mediaId,
          user_id: session.userId,
          folder_id: body.folderId ?? null,
          name: body.name,
          file_size: verifiedFileSize,
          mime_type: verifiedMimeType,
          media_type: body.mediaType,
          storage_key: body.storageKey,
          url: verifiedUrl,
          thumbnail_key: verifiedThumbnailKey,
          thumbnail_url: verifiedThumbnailUrl,
          duration_seconds: body.durationSeconds ?? null,
          aspect_ratio: body.aspectRatio ?? 'unknown',
          caption_text: resolvedCaptionText,
          width: body.width ?? null,
          height: body.height ?? null,
        })
        .select()
        .single();

      if (error || !data) {
        return NextResponse.json(
          { error: 'INTERNAL_ERROR', message: 'Failed to confirm media upload' },
          { status: 500 }
        );
      }

      insertedRow = data;
    }

    const responsePayload = MediaItemResponseSchema.parse({
      id: insertedRow.id,
      userId: insertedRow.user_id,
      folderId: insertedRow.folder_id ?? null,
      name: insertedRow.name,
      fileSize: Number(insertedRow.file_size),
      mimeType: insertedRow.mime_type,
      mediaType: insertedRow.media_type,
      storageKey: insertedRow.storage_key,
      url: insertedRow.url,
      thumbnailKey: insertedRow.thumbnail_key ?? null,
      thumbnailUrl: insertedRow.thumbnail_url ?? null,
      durationSeconds:
        insertedRow.duration_seconds !== null && insertedRow.duration_seconds !== undefined
          ? Number(insertedRow.duration_seconds)
          : null,
      aspectRatio: insertedRow.aspect_ratio ?? 'unknown',
      captionText: insertedRow.caption_text ?? null,
      width:
        insertedRow.width !== null && insertedRow.width !== undefined
          ? Number(insertedRow.width)
          : null,
      height:
        insertedRow.height !== null && insertedRow.height !== undefined
          ? Number(insertedRow.height)
          : null,
      createdAt: new Date(insertedRow.created_at).toISOString(),
      updatedAt: new Date(insertedRow.updated_at).toISOString(),
    });

    // Analytics: the media row landed. Fire-and-forget — never blocks
    // the response.
    void trackServerEvent('media_uploaded', session.userId, {
      media_type: body.mediaType,
    });

    return NextResponse.json(responsePayload, { status: 201 });
  } catch (err) {
    logServerError('[media/confirm] Failed to confirm media upload', err, {
      source: 'media-confirm',
      subdomain,
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to confirm media upload' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleConfirmUpload(request, subdomain);
}
