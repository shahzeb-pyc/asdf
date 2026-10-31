import { type NextRequest, NextResponse } from 'next/server';
import {
  PublishNowCopyLibraryMediaRequestSchema,
  PublishNowCopyLibraryMediaResponseSchema,
  publishNowValidationMessage,
} from '@fbuploadpro/contracts';
import { extractConnectSession } from '@/lib/connect/session';
import { canAccessTenant } from '@fbuploadpro/contracts';
import { bodyTooLargeResponse, readJsonBody } from '@/lib/request-body';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { getStorageService } from '@/lib/storage';
import { copyLibraryMediaToPostOwned } from '@/lib/publishing/post-owned-media';
import { logServerError } from '@/lib/server-analytics';

/**
 * Copy a Media Library file to post-owned storage for a Publish
 * Now post (media/posting separation).
 *
 * The composer calls this at pick time — not at publish time — so
 * a library file deleted after picking can never affect the post:
 * from the pick onward the post's media lives under the caller's
 * own post-media prefix. The library row and bytes are never
 * touched by this endpoint (no delete, no update); the thumbnail
 * is copied too when one exists, so the composer's attached
 * preview survives a library delete as well.
 *
 * Copy failure fails loud with MEDIA_COPY_FAILED and no partial
 * state: nothing is returned to compose from.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
) {
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
      { error: 'INVALID_REQUEST', message: 'The request could not be understood. Please try again.' },
      { status: 400 }
    );
  }
  const parsed = PublishNowCopyLibraryMediaRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: publishNowValidationMessage(parsed.error),
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: 'We could not access the Media Library. Please try again.' },
      { status: 500 }
    );
  }
  const { data, error } = await supabase
    .from('media_items')
    .select('id, media_type, storage_key, thumbnail_key')
    .eq('id', parsed.data.mediaId)
    .eq('user_id', session.userId)
    .maybeSingle();
  if (
    error ||
    !data ||
    typeof data.storage_key !== 'string' ||
    !data.storage_key ||
    (data.media_type !== 'image' && data.media_type !== 'video')
  ) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The selected library media was not found.' },
      { status: 400 }
    );
  }

  const storage = getStorageService();
  try {
    const copied = await copyLibraryMediaToPostOwned(
      storage,
      session.userId,
      data.storage_key
    );
    let thumbnailUrl: string | null = null;
    if (typeof data.thumbnail_key === 'string' && data.thumbnail_key) {
      const copiedThumbnail = await copyLibraryMediaToPostOwned(
        storage,
        session.userId,
        data.thumbnail_key
      );
      thumbnailUrl = copiedThumbnail.url;
    }
    return NextResponse.json(
      PublishNowCopyLibraryMediaResponseSchema.parse({
        storageKey: copied.storageKey,
        url: copied.url,
        mediaType: data.media_type,
        thumbnailUrl,
      })
    );
  } catch (err) {
    logServerError('[publish-now copy-library-media] Copy failed', err, {
      source: 'publish-now-copy-library-media',
      subdomain,
    });
    return NextResponse.json(
      {
        error: 'MEDIA_COPY_FAILED',
        message: 'We could not prepare this file for publishing. Please pick it again.',
      },
      { status: 500 }
    );
  }
}
