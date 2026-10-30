import { type NextRequest, NextResponse } from 'next/server';
import {
  composerTextLimitForType,
  decryptToken,
  evaluateGraphApiError,
  fetchAllFacebookPages,
  getTokenEncryptionKey,
  isFacebookAccountRestricted,
  PublishNowRequestSchema,
  PublishNowResponseSchema,
  publishNowValidationMessage,
  type PublishNowResult,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveSocialRouteContext } from '@/lib/connect/session';
import {
  claimIdempotencyResult,
  completeIdempotencyResult,
  lookupIdempotencyResult,
  parseIdempotencyKeyHeader,
  releaseIdempotencyClaim,
  storeIdempotencyResult,
  updateIdempotencyResult,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';
import {
  bodyTooLargeResponse,
  LARGE_JSON_BODY_LIMIT_BYTES,
  readJsonBody,
} from '@/lib/request-body';
import { getR2Config } from '@/lib/storage';
import { logServerError, trackServerEvent } from '@/lib/server-analytics';
import {
  assertCanPost,
  registerUsage,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';

/**
 * POST /api/tenant/[subdomain]/publishing/publish-now
 *
 * Direct, synchronous, multi-page Facebook publish that saves
 * NOTHING to the database except subscription usage rows (the
 * across-features cap registry — see the gate below). It deliberately does NOT use
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
 * mutating call made exactly once per page (single-attempt).
 *
 * Audit BG16 (owner decision 2026-10-30): this route honours the
 * `Idempotency-Key` header (action `publish-now`, same
 * idempotency_keys pattern as PR #29). A resend with a known key
 * returns the STORED results without re-executing, so a
 * response-lost retry cannot duplicate already-published pages.
 * A result is stored when at least one target published (partial
 * success counts — that is exactly the case a retry must not
 * re-publish); when nothing published, nothing is stored, so a
 * fresh retry with the same key executes again. A stored result
 * whose first comment failed is the one exception to blind replay:
 * a resend carrying the same first comment retries ONLY the
 * comment against the stored post id, never re-publishes the post.
 * Absent a key, behaviour is unchanged (no replay possible) — the
 * UI therefore sends one stable key per publish run, and a fresh
 * key for a deliberate retry of failed pages. Account-state
 * behaviour is unchanged by this change (Publish Now still
 * ignores destinations/status/expiry by owner decision).
 *
 * Two deliberate divergences from the worker, both from the
 * uniform code-1 failures on the preview: (1) before attempting,
 * the route checks the publish rights Facebook itself reports —
 * the page's `tasks` from /me/accounts and an explicit
 * `pages_manage_posts` decline on /me/permissions — and fails a
 * page fast with a specific reason when the right is clearly
 * absent, instead of attempting and surfacing generic code 1;
 * (2) photos are uploaded as bytes (multipart `source`) rather
 * than handing Facebook a URL to fetch, because a fresh temporary
 * R2 object is the one media URL the worker never proves
 * Facebook can fetch. Videos keep the worker's `file_url` shape
 * but are reachability-checked first (see below).
 */

const GRAPH_BASE_URL = 'https://graph.facebook.com/v26.0';
const GRAPH_TIMEOUT_MS = 60_000;
const MEDIA_FETCH_TIMEOUT_MS = 300_000;

type PublishNowStep =
  | 'discover'
  | 'feed'
  | 'photos'
  | 'videos'
  | 'reel-start'
  | 'reel-upload'
  | 'reel-finish'
  | 'media-fetch'
  | 'precheck'
  | 'publish';

const PUBLISH_NOW_STEPS: ReadonlySet<string> = new Set([
  'discover',
  'feed',
  'photos',
  'videos',
  'reel-start',
  'reel-upload',
  'reel-finish',
  'media-fetch',
  'precheck',
  'publish',
]);

/** Structured failure info for one publish attempt. Never carries a token. */
interface GraphFailure {
  code?: number | undefined;
  subcode?: number | undefined;
  message: string;
  step?: PublishNowStep | undefined;
  httpStatus?: number | undefined;
  fbtraceId?: string | undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toGraphFailure(error: unknown): GraphFailure {
  const record = (error ?? {}) as Record<string, unknown>;
  const message =
    nonEmptyString(record.message) ?? 'Publishing failed. Please try again.';
  const stepValue = record.step;
  const step =
    typeof stepValue === 'string' && PUBLISH_NOW_STEPS.has(stepValue)
      ? (stepValue as PublishNowStep)
      : undefined;
  return {
    code: finiteNumber(record.code),
    subcode: finiteNumber(record.subcode),
    message,
    step,
    // Discovery helpers attach `.status`; Graph calls attach `.httpStatus`.
    httpStatus: finiteNumber(record.httpStatus) ?? finiteNumber(record.status),
    fbtraceId: nonEmptyString(record.fbtraceId),
  };
}

/** Attach a publish step to an Error without changing its message. */
function steppedError(message: string, step: PublishNowStep): Error {
  const error = new Error(message);
  (error as unknown as Record<string, unknown>).step = step;
  return error;
}

/**
 * Plain-language reason for Meta's active account restriction
 * (Graph code 1, subcodes 2424009 / 1404078). The restriction is
 * account-level and Meta does not return its specific reason via
 * the API, so no specific reason is claimed here. This check runs
 * before the generic fallback so the restriction is never reported
 * as "An unknown error occurred".
 */
const ACCOUNT_RESTRICTED_MESSAGE =
  "Facebook has restricted this account from posting. Check Account Status on Facebook for the reason and to appeal — retrying won't work until the restriction is lifted.";

/**
 * Restriction detection lives in contracts (shared with Auto Repost) so
 * the subcode list cannot drift between features. Publish Now keeps its
 * own approved copy above and its exact historical semantics (structured
 * codes only — no message fallback); only the detection is shared.
 */
function isAccountRestricted(failure: GraphFailure): boolean {
  return isFacebookAccountRestricted(failure, { messageFallback: false });
}

/** Friendly, user-facing reason for a Graph failure (never a raw dump). */
function friendlyReason(error: unknown): string {
  const failure = toGraphFailure(error);
  if (isAccountRestricted(failure)) return ACCOUNT_RESTRICTED_MESSAGE;
  if (failure.code !== undefined) {
    const evaluation = evaluateGraphApiError(failure.code, failure.subcode);
    if (evaluation?.message) return evaluation.message;
  }
  return failure.message;
}

async function graphPost(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  step: PublishNowStep
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
    error?: {
      message?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
  } & Record<string, unknown>;
  if (!response.ok || data.error) {
    throw {
      message: data.error?.message ?? 'Facebook could not complete this request. Please try again.',
      code: data.error?.code,
      subcode: data.error?.error_subcode,
      step,
      httpStatus: response.status,
      fbtraceId: data.error?.fbtrace_id,
    };
  }
  return data;
}

/**
 * First comment, old Direct Post mechanics: after a page's post
 * succeeds, POST /{postId}/comments with the page token and the
 * trimmed message. A failure here throws like a Graph failure but
 * is caught by the caller and reported as a WARNING on an
 * otherwise published row — it never fails the post, because the
 * post already published.
 */
async function postFirstComment(params: {
  postId: string;
  pageToken: string;
  message: string;
}): Promise<void> {
  const response = await fetch(
    `${GRAPH_BASE_URL}/${encodeURIComponent(params.postId)}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.pageToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: params.message }),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    }
  );
  const data = (await response.json().catch(() => ({}))) as {
    error?: {
      message?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
  };
  if (!response.ok || data.error) {
    throw {
      message: data.error?.message ?? 'Facebook could not complete this request. Please try again.',
      code: data.error?.code,
      subcode: data.error?.error_subcode,
      httpStatus: response.status,
      fbtraceId: data.error?.fbtrace_id,
    };
  }
}

/**
 * Page-level publish rights, from the `tasks` array Facebook returns
 * on /me/accounts. Publishing needs the CREATE_CONTENT task (or
 * MANAGE, which implies it). This is deliberately strict in only
 * one direction: a non-empty tasks list that lacks both is a
 * definite "cannot post" — fail fast with an actionable reason
 * instead of attempting and surfacing Facebook's generic code 1.
 * A missing/empty tasks list is unknown, not a denial — attempt
 * as before rather than blocking a page on absent data.
 */
function hasPublishTask(tasks: unknown): boolean | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const normalized = tasks
    .filter((task): task is string => typeof task === 'string')
    .map((task) => task.toUpperCase());
  if (normalized.length === 0) return null;
  return normalized.includes('CREATE_CONTENT') || normalized.includes('MANAGE');
}

/**
 * Whether the account's user token explicitly declined
 * `pages_manage_posts` (server-side GET /me/permissions). Only an
 * explicit 'declined' counts — a missing entry or a failed lookup
 * is unknown and must not block publishing.
 */
async function pagesManagePostsDeclined(accountToken: string): Promise<boolean> {
  try {
    const response = await fetch(
      'https://graph.facebook.com/v26.0/me/permissions?fields=permission,status',
      {
        headers: { Authorization: `Bearer ${accountToken}` },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) return false;
    const data = (await response.json().catch(() => ({}))) as {
      data?: Array<{ permission?: string; status?: string }>;
    };
    const entry = (data.data ?? []).find(
      (item) => item.permission === 'pages_manage_posts'
    );
    return entry?.status === 'declined';
  } catch {
    return false;
  }
}

/**
 * Server-side reachability check for a media URL that Facebook is
 * asked to fetch (feed videos use `file_url`). A HEAD that the host
 * rejects (405/501) falls back to a ranged GET. A network error or
 * a non-2xx/3xx answer means the URL is not fetchable — fail fast
 * with a specific reason rather than letting Facebook return its
 * generic code 1 for every page. Photos do not need this: they are
 * uploaded as bytes below, so their fetch failure surfaces there.
 */
async function mediaUrlReachable(mediaUrl: string): Promise<boolean> {
  try {
    const head = await fetch(mediaUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    if (head.ok) return true;
    if (head.status === 405 || head.status === 501) {
      const ranged = await fetch(mediaUrl, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(15_000),
      });
      return ranged.ok;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Photo upload by bytes, not by Facebook-fetched URL. The worker
 * proves `url` works for library media it already serves, but a
 * Publish Now photo can also be a fresh temporary R2 object whose
 * public URL Facebook may not fetch (custom-domain or propagation
 * quirks) — and when that fetch fails Facebook answers with its
 * generic code 1, which tells the user nothing. The server can
 * reach the R2 public URL, so it fetches the bytes and uploads
 * them as multipart `source` (a documented /photos shape) instead.
 * A fetch failure here is a specific media-fetch failure, not a
 * per-page Facebook rejection, and the publish call itself is
 * still exactly one attempt.
 */
async function publishPhotoWithBytes(params: {
  pageId: string;
  pageToken: string;
  caption: string;
  mediaUrl: string;
}): Promise<string> {
  const { pageId, pageToken, caption, mediaUrl } = params;
  let mediaRes: Response;
  try {
    mediaRes = await fetch(mediaUrl, {
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw steppedError(
      'The photo could not be uploaded to Facebook. Please re-attach the photo and try again.',
      'media-fetch'
    );
  }
  if (!mediaRes.ok || !mediaRes.body) {
    throw steppedError(
      'The photo could not be uploaded to Facebook. Please re-attach the photo and try again.',
      'media-fetch'
    );
  }
  const contentLength = mediaRes.headers.get('content-length');
  const size = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
  if (Number.isFinite(size) && size > 30_000_000) {
    throw steppedError(
      'This photo is too large to upload. Choose a smaller photo and try again.',
      'media-fetch'
    );
  }
  const buffer = await mediaRes.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw steppedError(
      'The photo could not be uploaded to Facebook. Please re-attach the photo and try again.',
      'media-fetch'
    );
  }
  const contentType =
    mediaRes.headers.get('content-type') ?? 'image/jpeg';
  const filename =
    new URL(mediaUrl).pathname.split('/').filter(Boolean).pop() ?? 'photo.jpg';
  const form = new FormData();
  form.append('source', new Blob([buffer], { type: contentType }), filename);
  form.append('caption', caption);
  form.append('published', 'true');
  const response = await fetch(
    `${GRAPH_BASE_URL}/${encodeURIComponent(pageId)}/photos`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${pageToken}` },
      body: form,
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    }
  );
  const data = (await response.json().catch(() => ({}))) as {
    post_id?: string;
    id?: string;
    error?: {
      message?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
  };
  if (!response.ok || data.error) {
    throw {
      message: data.error?.message ?? 'Facebook could not complete this request. Please try again.',
      code: data.error?.code,
      subcode: data.error?.error_subcode,
      step: 'photos' as PublishNowStep,
      httpStatus: response.status,
      fbtraceId: data.error?.fbtrace_id,
    };
  }
  const postId = data.post_id ?? data.id;
  if (typeof postId !== 'string' || !postId) {
    throw steppedError('The photo post could not be completed. Please try again.', 'photos');
  }
  return postId;
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
  // `step` tracks the phase in progress so a failure that carries no
  // step of its own (a local throw, a fetch abort) is still reported
  // with the phase it failed in. Graph failures already carry their
  // step from graphPost and are left untouched.
  let step: PublishNowStep = 'publish';
  try {
    if (type === 'text') {
      step = 'feed';
      const data = await graphPost(
        `${GRAPH_BASE_URL}/${encodedPageId}/feed`,
        pageToken,
        { message: caption },
        step
      );
      if (typeof data.id !== 'string' || !data.id) {
        throw steppedError('The post could not be completed. Please try again.', step);
      }
      return data.id;
    }
    if (type === 'image') {
      step = 'photos';
      if (!mediaUrl) throw steppedError('An image is required for an image post.', step);
      // Bytes, not a Facebook-fetched URL (see publishPhotoWithBytes).
      return publishPhotoWithBytes({
        pageId,
        pageToken,
        caption,
        mediaUrl,
      });
    }
    if (type === 'video') {
      step = 'videos';
      if (!mediaUrl) throw steppedError('A video is required for a video post.', step);
      const data = await graphPost(
        `${GRAPH_BASE_URL}/${encodedPageId}/videos`,
        pageToken,
        { file_url: mediaUrl, description: caption },
        step
      );
      if (typeof data.id !== 'string' || !data.id) {
        throw steppedError('The video post could not be completed. Please try again.', step);
      }
      return data.id;
    }
    // Reel: 3-phase upload, same shape as the worker's fb-client.
    step = 'reel-start';
    if (!mediaUrl) throw steppedError('A video is required for a reel.', step);
    const start = await graphPost(
      `${GRAPH_BASE_URL}/${encodedPageId}/video_reels`,
      pageToken,
      { upload_phase: 'start' },
      step
    );
    const videoId = start.video_id;
    const uploadUrl = start.upload_url;
    if (typeof videoId !== 'string' || !videoId || typeof uploadUrl !== 'string' || !uploadUrl) {
      throw steppedError('The reel could not be uploaded. Please try again.', step);
    }
    step = 'media-fetch';
    let videoRes: Response;
    try {
      videoRes = await fetch(mediaUrl, {
        signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw steppedError('The video could not be uploaded to Facebook.', step);
    }
    if (!videoRes.ok || !videoRes.body) {
      throw steppedError('The video could not be uploaded to Facebook.', step);
    }
    step = 'reel-upload';
    // The upload host is rupload, not graph: the worker's
    // streamVideoUpload uses `OAuth` here, not `Bearer`.
    const uploadRes = await fetch(
      uploadUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${pageToken}`,
          offset: '0',
          'Content-Type': 'application/octet-stream',
        },
        body: videoRes.body,
        duplex: 'half',
      } as RequestInit
    );
    if (!uploadRes.ok) {
      const uploadData = (await uploadRes.json().catch(() => ({}))) as {
        error?: {
          message?: string;
          code?: number;
          error_subcode?: number;
          fbtrace_id?: string;
        };
      };
      throw {
        message: uploadData.error?.message ?? 'The reel could not be uploaded. Please try again.',
        code: uploadData.error?.code,
        subcode: uploadData.error?.error_subcode,
        step,
        httpStatus: uploadRes.status,
        fbtraceId: uploadData.error?.fbtrace_id,
      };
    }
    step = 'reel-finish';
    const finish = await graphPost(
      `${GRAPH_BASE_URL}/${encodedPageId}/video_reels`,
      pageToken,
      {
        upload_phase: 'finish',
        video_state: 'PUBLISHED',
        description: caption,
        video_id: videoId,
      },
      step
    );
    const postId = finish.post_id ?? finish.id ?? finish.video_id ?? videoId;
    if (typeof postId !== 'string' || !postId) {
      throw steppedError('The reel could not be completed. Please try again.', step);
    }
    return postId;
  } catch (error) {
    // Attach the phase in progress only when the failure does not
    // already carry a step (Graph failures from graphPost do).
    const record = error as Record<string, unknown> | null;
    if (record && typeof record === 'object' && typeof record.step !== 'string') {
      (record as Record<string, unknown>).step = step;
    }
    throw error;
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const routeContext = await resolveSocialRouteContext(request, subdomain);
  if (routeContext.errorResponse) return routeContext.errorResponse;
  const { session, workspaceId } = routeContext;

  // BG16: a present-but-malformed key is a client bug — reject
  // fail-loud before any execution, never treat it as "no key".
  const headerKey = parseIdempotencyKeyHeader(request.headers);
  if (headerKey.invalid) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The idempotency key is invalid. Please try again.' },
      { status: 400 }
    );
  }
  const idempotencyScope: IdempotencyScope | null = headerKey.key
    ? {
        workspaceId,
        userId: session.userId,
        action: 'publish-now',
        key: headerKey.key,
      }
    : null;

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  const bodyResult = await readJsonBody(request, LARGE_JSON_BODY_LIMIT_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The request could not be understood. Please try again.' },
      { status: 400 }
    );
  }
  const parsed = PublishNowRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    // Never a bare code: the message names the actual problem in
    // plain language (see publishNowValidationMessage); details
    // are kept alongside for debugging, never as the display text.
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: publishNowValidationMessage(parsed.error),
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }
  const { caption, postType, firstComment, targets, media } = parsed.data;

  // Subscription gate, server-side, before any Facebook call:
  // a paid period must be active and every target page must fit
  // the across-features Facebook cap. Registering here counts a
  // page once even if it is also queued via destination-queue.
  // Admins are not gated. A gate failure fails the whole request
  // so a partial publish can never slip past the cap.
  // Pre-check every target first: registering one by one means a
  // cap failure on page 3 would leave pages 1-2 permanently
  // registered even though nothing was published. A gate failure
  // in the pre-check registers nothing.
  if (session.role !== 'admin') {
    const distinctPageIds = Array.from(new Set(targets.map((target) => target.fbPageId)));
    try {
      for (const fbPageId of distinctPageIds) {
        await assertCanPost(supabase, session.userId, 'facebook', fbPageId);
      }
      for (const fbPageId of distinctPageIds) {
        await registerUsage(supabase, session.userId, 'facebook', fbPageId, 'publish-now', null);
      }
    } catch (err) {
      if (err instanceof SubscriptionGateError) {
        const status =
          err.code === 'SUBSCRIPTION_CAP_REACHED' || err.code === 'SUBSCRIPTION_REQUIRED'
            ? 403
            : 500;
        return NextResponse.json({ error: err.code, message: err.message }, { status });
      }
      throw err;
    }
  }

  const trimmedFirstComment = firstComment?.trim() || undefined;

  // Explicit type decides emptiness: text needs caption, every
  // other type needs media (the composer clears media on a type
  // switch, so a text post never carries media).
  if (postType === 'text' && caption.trim().length === 0) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'A text post needs text.' },
      { status: 400 }
    );
  }
  if (postType !== 'text' && !media) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'This post type needs media.' },
      { status: 400 }
    );
  }

  // Explicit type + limit: the picked type is the type published.
  const limit = composerTextLimitForType(postType);
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
    // Strip trailing slashes without a regex: the R2 public URL is
    // stored with a trailing slash in some environments, and the
    // prefix check below needs the bare base.
    let publicBase: string | null = null;
    if (config) {
      let stripped = config.publicUrl;
      while (stripped.endsWith('/')) {
        stripped = stripped.slice(0, -1);
      }
      publicBase = stripped;
    }
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
        { error: 'INVALID_REQUEST', message: 'The uploaded media could not be verified. Please try again.' },
        { status: 400 }
      );
    }
    mediaUrl = media.url;
  }

  // Feed videos are the one format where Facebook itself fetches
  // the media URL (`file_url`, the worker's shape). If that URL is
  // not reachable at all, every page would fail with Facebook's
  // generic code 1 — fail the whole request early with a specific
  // reason instead. Photos are uploaded as bytes and reels stream
  // bytes, so both surface their own media-fetch failure per page.
  if (postType === 'video' && mediaUrl) {
    if (!(await mediaUrlReachable(mediaUrl))) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message:
            'The video could not be uploaded. Please re-attach the video and try again.',
        },
        { status: 400 }
      );
    }
  }

  let encryptionKey: string;
  try {
    encryptionKey = getTokenEncryptionKey();
  } catch {
    return NextResponse.json(
      { error: 'We could not access your Facebook account. Please try again.' },
      { status: 500 }
    );
  }

  // BG16 replay/claim: lookup runs AFTER all validation above
  // (body, limits, media, encryption key) so a rejected request
  // never claims a key, and BEFORE the publish loop so a resend
  // never re-executes. A lookup failure is 500 fail-loud: the
  // request has not executed yet, so failing it is safe.
  let idempotencyClaimed = false;
  if (idempotencyScope) {
    let stored: Awaited<ReturnType<typeof lookupIdempotencyResult>>;
    try {
      stored = await lookupIdempotencyResult(
        routeContext.client,
        idempotencyScope
      );
    } catch {
      return NextResponse.json(
        { error: 'We could not verify this publish request. Please try again.' },
        { status: 500 }
      );
    }
    if (stored) {
      const replayed = PublishNowResponseSchema.safeParse(stored.body);
      if (!replayed.success) {
        // Corrupt stored body: fail loud, never execute blindly
        // (executing could duplicate the original publish).
        logServerError(
          '[publish-now] Stored idempotency body failed validation',
          new Error('Stored publish-now idempotency body failed validation'),
          {
            source: 'publish-now',
            subdomain,
          }
        );
        return NextResponse.json(
          { error: 'We could not verify this publish request. Please try again.' },
          { status: 500 }
        );
      }
      const replayResults = replayed.data.results;
      // First-comment recovery only: a resend carrying the same
      // first comment retries ONLY the failed comments against
      // the stored post ids. Nothing here re-publishes.
      if (trimmedFirstComment) {
        let commentRetried = false;
        for (const result of replayResults) {
          if (
            result.status !== 'published' ||
            !result.firstCommentFailed ||
            !result.postId
          ) {
            continue;
          }
          try {
            const { data: account, error: accountError } = await supabase
              .from('social_accounts')
              .select('encrypted_access_token')
              .eq('id', result.accountId)
              .eq('workspace_id', workspaceId)
              .eq('platform', 'facebook')
              .maybeSingle();
            if (accountError || !account?.encrypted_access_token) {
              throw new Error('Facebook account not found.');
            }
            const accountToken = await decryptToken(
              account.encrypted_access_token as string,
              encryptionKey
            );
            const { pages } = await fetchAllFacebookPages(
              accountToken,
              'id,name,category,tasks,access_token,followers_count,picture{url}'
            );
            const page = pages.find((p) => String(p.id) === result.fbPageId);
            const pageToken = page?.access_token;
            if (!page || typeof pageToken !== 'string' || !pageToken) {
              throw new Error(
                'This page is no longer available on this Facebook account.'
              );
            }
            await postFirstComment({
              postId: result.postId,
              pageToken,
              message: trimmedFirstComment,
            });
            result.firstCommentFailed = null;
            result.firstCommentReason = null;
            commentRetried = true;
          } catch (commentError) {
            result.firstCommentReason = toGraphFailure(commentError).message.slice(
              0,
              500
            );
            logServerError('[publish-now] First-comment retry failed on replay', commentError, {
              source: 'publish-now',
              subdomain,
            });
          }
        }
        if (commentRetried) {
          // Persist the corrected body best-effort (never throws);
          // the in-band response below already carries the truth.
          await updateIdempotencyResult(routeContext.client, idempotencyScope, {
            status: 200,
            body: { results: replayResults },
          });
        }
      }
      return NextResponse.json(
        { results: replayResults },
        { headers: { 'Idempotency-Replayed': 'true' } }
      );
    }
    let claim: Awaited<ReturnType<typeof claimIdempotencyResult>>;
    try {
      claim = await claimIdempotencyResult(
        routeContext.client,
        idempotencyScope
      );
    } catch {
      return NextResponse.json(
        { error: 'We could not verify this publish request. Please try again.' },
        { status: 500 }
      );
    }
    if (claim === 'already-processing') {
      return NextResponse.json(
        {
          error: 'IDEMPOTENCY_PROCESSING',
          message: 'This publish is already in progress. Please wait for it to finish.',
        },
        { status: 409 }
      );
    }
    idempotencyClaimed = true;
  }

  const results: PublishNowResult[] = [];
  // Per-account cache for this request only: the account token,
  // its re-discovered pages, and its permission state. Previously
  // every target re-ran /me/accounts for its account, so five
  // pages under one account hit Facebook five times for the same
  // list — and the publish-rights checks below need the same
  // data. Nothing here is stored beyond the request.
  interface CachedAccount {
    pages: Awaited<ReturnType<typeof fetchAllFacebookPages>>['pages'];
    permissionsDeclined: boolean;
  }
  const accountCache = new Map<string, CachedAccount>();
  // Sequential, one page at a time, continuing on failure: a burst
  // of parallel publish calls would invite Facebook rate limiting,
  // and a failure on one page must never block the rest.
  for (const target of targets) {
    // Phase in progress outside publishToPage (account lookup and
    // page discovery). publishToPage failures carry their own step
    // and take precedence over this in the catch below.
    let loopStep: PublishNowStep = 'publish';
    try {
      let cached = accountCache.get(target.accountId);
      if (!cached) {
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
          throw new Error('We could not access your Facebook account. Please try again.');
        }
        // Transient tokens: re-discovered now, used only in memory.
        loopStep = 'discover';
        const [fetched, permissionsDeclined] = await Promise.all([
          fetchAllFacebookPages(
            accountToken,
            'id,name,category,tasks,access_token,followers_count,picture{url}'
          ),
          pagesManagePostsDeclined(accountToken),
        ]);
        // A truncated/partial re-discovery can only fail to find a
        // target page, which surfaces as "no longer available" below
        // — it never publishes to the wrong page.
        cached = { pages: fetched.pages, permissionsDeclined };
        accountCache.set(target.accountId, cached);
      }
      const page = cached.pages.find((p) => String(p.id) === target.fbPageId);
      const pageToken = page?.access_token;
      if (!page || typeof pageToken !== 'string' || !pageToken) {
        throw new Error(
          'This page is no longer available on this Facebook account.'
        );
      }
      // Publish-rights pre-checks. Both are fail-fast only on
      // definite data (see hasPublishTask / pagesManagePostsDeclined);
      // anything unknown proceeds to the publish attempt as before,
      // so these checks can never block a page that could publish.
      if (cached.permissionsDeclined) {
        throw steppedError(
          'This Facebook account has not allowed posting to pages. Reconnect the account and allow posting to pages, then try again.',
          'precheck'
        );
      }
      const publishTask = hasPublishTask(page.tasks);
      if (publishTask === false) {
        throw steppedError(
          `You do not have permission to post to ${target.pageName}. Your role on this page does not include creating content — ask a page admin to give you the Create content role, or pick a page you can post to.`,
          'precheck'
        );
      }
      const postId = await publishToPage({
        pageId: target.fbPageId,
        pageToken,
        type: postType,
        caption,
        mediaUrl,
      });
      // First comment: only after this page's post succeeded, and
      // a failure here is a warning, never a failed row — the post
      // published, and retry must never re-publish it to retry
      // the comment.
      let firstCommentFailed = false;
      let firstCommentReason: string | null = null;
      if (trimmedFirstComment) {
        try {
          await postFirstComment({
            postId,
            pageToken,
            message: trimmedFirstComment,
          });
        } catch (commentError) {
          firstCommentFailed = true;
          firstCommentReason = toGraphFailure(commentError).message.slice(0, 500);
          logServerError('[publish-now] First comment failed for a target', commentError, {
            source: 'publish-now',
            subdomain,
          });
        }
      }
      results.push({
        accountId: target.accountId,
        fbPageId: target.fbPageId,
        pageName: target.pageName,
        status: 'published',
        postId,
        reason: null,
        graphCode: null,
        graphSubcode: null,
        step: null,
        httpStatus: null,
        fbtraceId: null,
        firstCommentFailed: firstCommentFailed || null,
        firstCommentReason,
      });
    } catch (error) {
      const failure = toGraphFailure(error);
      const step = failure.step ?? loopStep;
      logServerError('[publish-now] Publish failed for a target', error, {
        source: 'publish-now',
        subdomain,
        graphCode: failure.code ?? null,
        graphSubcode: failure.subcode ?? null,
        step,
        httpStatus: failure.httpStatus ?? null,
        fbtraceId: failure.fbtraceId ?? null,
      });
      results.push({
        accountId: target.accountId,
        fbPageId: target.fbPageId,
        pageName: target.pageName,
        status: 'failed',
        postId: null,
        reason: friendlyReason(error),
        graphCode: failure.code ?? null,
        graphSubcode: failure.subcode ?? null,
        step,
        httpStatus: failure.httpStatus ?? null,
        fbtraceId: failure.fbtraceId ?? null,
        firstCommentFailed: null,
        firstCommentReason: null,
      });
    }
  }

  const responseBody = PublishNowResponseSchema.parse({ results });
  if (idempotencyScope) {
    if (results.some((result) => result.status === 'published')) {
      // Partial success counts as stored: a retry must not
      // re-publish the pages that already went out.
      if (idempotencyClaimed) {
        const completed = await completeIdempotencyResult(
          routeContext.client,
          idempotencyScope,
          { status: 200, body: responseBody }
        );
        if (!completed) {
          // Sentinel already gone — overwrite unconditionally
          // rather than leaving a stale processing row behind.
          await updateIdempotencyResult(routeContext.client, idempotencyScope, {
            status: 200,
            body: responseBody,
          });
        }
      } else {
        await storeIdempotencyResult(routeContext.client, idempotencyScope, {
          status: 200,
          body: responseBody,
        });
      }
    } else if (idempotencyClaimed) {
      // Nothing published: release the claim so a fresh retry
      // with the same key executes immediately instead of
      // waiting out the 5-minute sentinel.
      await releaseIdempotencyClaim(routeContext.client, idempotencyScope);
    }
  }
  // Analytics: only when at least one page actually published — an
  // all-failed run is not a publish. Fire-and-forget — never blocks
  // the response.
  const publishedCount = results.filter(
    (result) => result.status === 'published'
  ).length;
  if (publishedCount > 0) {
    void trackServerEvent('post_published_now', session.userId, {
      platform: 'facebook',
      page_count: results.length,
      published_count: publishedCount,
    });
  }

  return NextResponse.json(responseBody);
}
