import { type NextRequest, NextResponse } from 'next/server';
import {
  composerTextLimitForType,
  decryptToken,
  deriveComposerPostType,
  evaluateGraphApiError,
  fetchAllFacebookPages,
  getTokenEncryptionKey,
  PublishNowRequestSchema,
  PublishNowResponseSchema,
  type PublishNowResult,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveSocialRouteContext } from '@/lib/connect/session';
import {
  bodyTooLargeResponse,
  LARGE_JSON_BODY_LIMIT_BYTES,
  readJsonBody,
} from '@/lib/request-body';
import { getR2Config } from '@/lib/storage';
import { logServerError } from '@/lib/server-analytics';

/**
 * POST /api/tenant/[subdomain]/publishing/publish-now
 *
 * Direct, synchronous, multi-page Facebook publish that saves
 * NOTHING to the database. It deliberately does NOT use
 * destination-queue (which inserts queue_items), does NOT use the
 * publish-now re-time routes (which never call Facebook), and does
 * NOT write idempotency, publish-log, destination, media, or
 * posting-slot rows. The only database access here is READS:
 * the account's encrypted token, and (for library media) the
 * media row's URL for ownership + URL resolution.
 *
 * Per target, the page token is obtained transiently: the account
 * token is decrypted server-side, Graph /me/accounts is re-queried
 * (exactly as the discover route does), the matching page's token
 * is used in memory only, and it is never sent to the browser and
 * never stored. Publishing continues to the remaining pages even
 * when one fails; the response carries one result per target.
 *
 * Graph calls mirror the worker's Facebook publisher shapes
 * (apps/worker/src/fb-client.ts): text → /feed, photo → /photos,
 * video → /videos, reel → 3-phase /video_reels, each publish
 * mutating call made exactly once per page (single-attempt), so a
 * retry of the whole request re-publishes successes — the UI must
 * therefore only ever retry failed pages, never the whole set.
 */

const GRAPH_BASE_URL = 'https://graph.facebook.com/v26.0';
const GRAPH_TIMEOUT_MS = 60_000;
const MEDIA_FETCH_TIMEOUT_MS = 300_000;

interface GraphFailure {
  code?: number | undefined;
  subcode?: number | undefined;
  message: string;
}

function toGraphFailure(error: unknown): GraphFailure {
  const record = (error ?? {}) as Record<string, unknown>;
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : 'Publishing failed. Please try again.';
  const code =
    typeof record.code === 'number' && Number.isFinite(record.code)
      ? record.code
      : undefined;
  const subcode =
    typeof record.subcode === 'number' && Number.isFinite(record.subcode)
      ? record.subcode
      : undefined;
  return { code, subcode, message };
}

/** Friendly, user-facing reason for a Graph failure (never a raw dump). */
function friendlyReason(error: unknown): string {
  const failure = toGraphFailure(error);
  if (failure.code !== undefined) {
    const evaluation = evaluateGraphApiError(failure.code, failure.subcode);
    if (evaluation?.message) return evaluation.message;
  }
  return failure.message;
}

async function graphPost(
  url: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number };
  } & Record<string, unknown>;
  if (!response.ok || data.error) {
    throw {
      message: data.error?.message ?? `Facebook returned ${response.status}.`,
      code: data.error?.code,
      subcode: data.error?.error_subcode,
    };
  }
  return data;
}

async function publishToPage(params: {
  pageId: string;
  pageToken: string;
  type: 'text' | 'image' | 'reel' | 'video';
  caption: string;
  mediaUrl: string | null;
}): Promise<string> {
  const { pageId, pageToken, type, caption, mediaUrl } = params;
  const encodedPageId = encodeURIComponent(pageId);
  if (type === 'text') {
    const data = await graphPost(`${GRAPH_BASE_URL}/${encodedPageId}/feed`, pageToken, {
      message: caption,
    });
    if (typeof data.id !== 'string' || !data.id) {
      throw new Error('Facebook did not return a post id for the text post.');
    }
    return data.id;
  }
  if (type === 'image') {
    if (!mediaUrl) throw new Error('An image is required for an image post.');
    const data = await graphPost(
      `${GRAPH_BASE_URL}/${encodedPageId}/photos`,
      pageToken,
      { url: mediaUrl, caption, published: true }
    );
    const postId = data.post_id ?? data.id;
    if (typeof postId !== 'string' || !postId) {
      throw new Error('Facebook did not return a post id for the photo.');
    }
    return postId;
  }
  if (type === 'video') {
    if (!mediaUrl) throw new Error('A video is required for a video post.');
    const data = await graphPost(
      `${GRAPH_BASE_URL}/${encodedPageId}/videos`,
      pageToken,
      { file_url: mediaUrl, description: caption }
    );
    if (typeof data.id !== 'string' || !data.id) {
      throw new Error('Facebook did not return a post id for the video.');
    }
    return data.id;
  }
  // Reel: 3-phase upload, same shape as the worker's fb-client.
  if (!mediaUrl) throw new Error('A video is required for a reel.');
  const start = await graphPost(
    `${GRAPH_BASE_URL}/${encodedPageId}/video_reels`,
    pageToken,
    { upload_phase: 'start' }
  );
  const videoId = start.video_id;
  const uploadUrl = start.upload_url;
  if (typeof videoId !== 'string' || !videoId || typeof uploadUrl !== 'string' || !uploadUrl) {
    throw new Error('Facebook did not start a reel upload session.');
  }
  const videoRes = await fetch(mediaUrl, {
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!videoRes.ok || !videoRes.body) {
    throw new Error('The video could not be fetched for upload to Facebook.');
  }
  const uploadRes = await fetch(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pageToken}`,
        offset: '0',
        'Content-Type': 'application/octet-stream',
      },
      body: videoRes.body,
      duplex: 'half',
    } as RequestInit
  );
  if (!uploadRes.ok) {
    const uploadData = (await uploadRes.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    throw {
      message: uploadData.error?.message ?? 'The reel upload to Facebook failed.',
      code: uploadData.error?.code,
      subcode: uploadData.error?.error_subcode,
    };
  }
  const finish = await graphPost(
    `${GRAPH_BASE_URL}/${encodedPageId}/video_reels`,
    pageToken,
    {
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description: caption,
      video_id: videoId,
    }
  );
  const postId = finish.post_id ?? finish.id ?? finish.video_id ?? videoId;
  if (typeof postId !== 'string' || !postId) {
    throw new Error('Facebook did not return a post id for the reel.');
  }
  return postId;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const routeContext = await resolveSocialRouteContext(request, subdomain);
  if (routeContext.errorResponse) return routeContext.errorResponse;
  const { session, workspaceId } = routeContext;

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 503 }
    );
  }

  const bodyResult = await readJsonBody(request, LARGE_JSON_BODY_LIMIT_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }
  const parsed = PublishNowRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { caption, targets, media } = parsed.data;

  if (caption.trim().length === 0 && !media) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'A post needs text or media.' },
      { status: 400 }
    );
  }

  // Derived type + limit, exactly as the composer derives them.
  const derivedType = !media
    ? 'text'
    : deriveComposerPostType({
        text: caption,
        mediaType: media.mediaType,
        aspectRatio: media.aspectRatio,
        width: media.width,
        height: media.height,
      });
  const limit = composerTextLimitForType(derivedType);
  if (caption.length > limit) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: `Text exceeds the ${limit.toLocaleString('en-US')}-character limit`,
      },
      { status: 400 }
    );
  }

  // Resolve the media URL server-side. Library media: the stored row
  // (ownership = session user) is the source of truth — the client's
  // URL is never trusted. Temp media: the URL must be the R2 public
  // URL for a key under the caller's own temp prefix.
  let mediaUrl: string | null = null;
  if (media?.source === 'library' && media.mediaId) {
    const { data, error } = await supabase
      .from('media_items')
      .select('id, media_type, url')
      .eq('id', media.mediaId)
      .eq('user_id', session.userId)
      .maybeSingle();
    if (error || !data || typeof data.url !== 'string' || !data.url) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'The selected library media was not found.' },
        { status: 400 }
      );
    }
    mediaUrl = data.url;
  } else if (media?.source === 'temp' && media.tempKey) {
    const config = getR2Config();
    const publicBase = config?.publicUrl
      ? config.publicUrl.replace(/\/+$/, '')
      : null;
    const expectedPrefix = `users/${session.userId}/publish-now-temp/`;
    const keyFromUrl =
      publicBase && media.url.startsWith(`${publicBase}/`)
        ? media.url.slice(publicBase.length + 1)
        : null;
    if (
      !publicBase ||
      keyFromUrl !== media.tempKey ||
      !media.tempKey.startsWith(expectedPrefix) ||
      media.tempKey.includes('..')
    ) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'The temporary media could not be verified.' },
        { status: 400 }
      );
    }
    mediaUrl = media.url;
  }

  let encryptionKey: string;
  try {
    encryptionKey = getTokenEncryptionKey();
  } catch {
    return NextResponse.json(
      { error: 'Failed to decrypt account credentials' },
      { status: 500 }
    );
  }

  const results: PublishNowResult[] = [];
  // Sequential, one page at a time, continuing on failure: a burst
  // of parallel publish calls would invite Facebook rate limiting,
  // and a failure on one page must never block the rest.
  for (const target of targets) {
    try {
      const { data: account, error: accountError } = await supabase
        .from('social_accounts')
        .select('encrypted_access_token')
        .eq('id', target.accountId)
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook')
        .maybeSingle();
      if (accountError || !account?.encrypted_access_token) {
        throw new Error('Facebook account not found.');
      }
      let accountToken: string;
      try {
        accountToken = await decryptToken(
          account.encrypted_access_token as string,
          encryptionKey
        );
      } catch {
        throw new Error('Failed to decrypt account credentials.');
      }
      // Transient token: re-discovered now, used only in memory.
      const pages = await fetchAllFacebookPages(
        accountToken,
        'id,name,category,tasks,access_token,followers_count,picture{url}'
      );
      const page = pages.find((p) => String(p.id) === target.fbPageId);
      const pageToken = page?.access_token;
      if (!page || typeof pageToken !== 'string' || !pageToken) {
        throw new Error(
          'This page is no longer available on this Facebook account.'
        );
      }
      const postId = await publishToPage({
        pageId: target.fbPageId,
        pageToken,
        type: derivedType,
        caption,
        mediaUrl,
      });
      results.push({
        accountId: target.accountId,
        fbPageId: target.fbPageId,
        pageName: target.pageName,
        status: 'published',
        postId,
        reason: null,
      });
    } catch (error) {
      logServerError('[publish-now] Publish failed for a target', error, {
        source: 'publish-now',
        subdomain,
      });
      results.push({
        accountId: target.accountId,
        fbPageId: target.fbPageId,
        pageName: target.pageName,
        status: 'failed',
        postId: null,
        reason: friendlyReason(error),
      });
    }
  }

  return NextResponse.json(PublishNowResponseSchema.parse({ results }));
}
