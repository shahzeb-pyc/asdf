import { type NextRequest, NextResponse } from 'next/server';
import {
  decryptToken,
  evaluateGraphApiError,
  getTokenEncryptionKey,
  InstagramPublishNowRequestSchema,
  InstagramPublishNowResponseSchema,
  instagramPublishNowValidationMessage,
  isFacebookAccountRestricted,
  type InstagramPublishNowResult,
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
import { logServerError } from '@/lib/server-analytics';
import {
  assertPaidPlan,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';

/**
 * POST /api/tenant/[subdomain]/instagram/publish-now
 *
 * Direct, synchronous, multi-account Instagram publish — the
 * Instagram equivalent of Facebook Publish Now, with the same
 * nothing-saved rule (see the contracts header). It deliberately
 * does NOT enqueue queue_items, does NOT use the worker, and does
 * NOT write destinations, publish logs, or media rows for device
 * media. The only database access is READS (the account's encrypted
 * token and, for library media, the media row), plus the
 * idempotency record — stated, not hidden (see the spec). Publish
 * Now writes no subscription-usage rows: it is unlimited (owner
 * decision 2026-10-31), gated only on an active paid period.
 *
 * Per account, sequentially, continuing on failure: create a
 * container at graph.instagram.com, poll its status_code, then
 * media_publish it. First comment is posted only after that
 * account's post succeeds; a comment failure is a warning on an
 * otherwise published row, never a failed row.
 *
 * Container polling budget: the worker polls once a minute for up
 * to 5 minutes, which a synchronous web route cannot faithfully
 * reproduce. This route polls every 5 seconds for at most 12 polls
 * (~60 s per account). A reel still preparing after that budget
 * fails with a plain "still preparing" reason — and because no post
 * exists until media_publish succeeds, a retry creating a fresh
 * container cannot duplicate it. That limit is stated in the spec
 * and the PR, not hidden behind a generic failure.
 *
 * Idempotency (action `instagram-publish-now`, distinct from
 * Facebook's `publish-now` keys): a resend with a known key replays
 * the stored results without re-executing, except that a resend
 * carrying the same first comment retries ONLY failed comments
 * against the stored media ids. A concurrent same-key request gets
 * 409. Partial success (at least one published) is stored; nothing
 * published releases the claim so the same key retries immediately.
 */

const GRAPH_BASE_URL = 'https://graph.instagram.com/v26.0';
const GRAPH_TIMEOUT_MS = 60_000;
const MEDIA_HEAD_TIMEOUT_MS = 15_000;
const CONTAINER_POLL_INTERVAL_MS = 5_000;
const CONTAINER_MAX_POLLS = 12;
const INSTAGRAM_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const INSTAGRAM_PHOTO_MIN_ASPECT = 4 / 5;
const INSTAGRAM_PHOTO_MAX_ASPECT = 1.91;

type InstagramPublishNowStep =
  | 'account'
  | 'container-create'
  | 'container-poll'
  | 'media-publish'
  | 'comment'
  | 'media-fetch'
  | 'precheck';

const IG_STEPS: ReadonlySet<string> = new Set([
  'account',
  'container-create',
  'container-poll',
  'media-publish',
  'comment',
  'media-fetch',
  'precheck',
]);

/** Structured failure info for one publish attempt. Never carries a token. */
interface GraphFailure {
  code?: number | undefined;
  subcode?: number | undefined;
  message: string;
  step?: InstagramPublishNowStep | undefined;
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
    typeof stepValue === 'string' && IG_STEPS.has(stepValue)
      ? (stepValue as InstagramPublishNowStep)
      : undefined;
  return {
    code: finiteNumber(record.code),
    subcode: finiteNumber(record.subcode),
    message,
    step,
    httpStatus: finiteNumber(record.httpStatus) ?? finiteNumber(record.status),
    fbtraceId: nonEmptyString(record.fbtraceId),
  };
}

function steppedError(
  message: string,
  step: InstagramPublishNowStep
): Error {
  const error = new Error(message);
  (error as unknown as Record<string, unknown>).step = step;
  return error;
}

/**
 * Plain-language reason for Meta's active account restriction
 * (Graph code 1, subcodes 2424009 / 1404078, structured codes only).
 * Detection is shared with Facebook Publish Now; the wording here
 * is Instagram-specific. The restriction is account-level and
 * non-retryable while it stands.
 */
const ACCOUNT_RESTRICTED_MESSAGE =
  "Instagram has restricted this account from posting. Check Account Status on Instagram for the reason and to appeal — retrying won't work until the restriction is lifted.";

function isAccountRestricted(failure: GraphFailure): boolean {
  return isFacebookAccountRestricted(failure, { messageFallback: false });
}

function friendlyReason(error: unknown): string {
  const failure = toGraphFailure(error);
  if (isAccountRestricted(failure)) return ACCOUNT_RESTRICTED_MESSAGE;
  if (failure.code !== undefined) {
    const evaluation = evaluateGraphApiError(failure.code, failure.subcode);
    if (evaluation?.message) return evaluation.message;
  }
  return failure.message;
}

async function graphRequest(
  path: string,
  accessToken: string,
  init: { method: string; body?: Record<string, unknown> },
  step: InstagramPublishNowStep
): Promise<Record<string, unknown>> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  let data: {
    error?: {
      message?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
  } & Record<string, unknown>;
  try {
    data = (await response.json()) as typeof data;
  } catch {
    // An unreadable body is a real failure, surfaced loudly — never an
    // empty object that would let the caller proceed on missing fields.
    throw {
      message: 'Instagram returned an unreadable response. Please try again.',
      step,
      httpStatus: response.status,
    };
  }
  if (!response.ok || data.error) {
    throw {
      message:
        data.error?.message ??
        'Instagram could not complete this request. Please try again.',
      code: data.error?.code,
      subcode: data.error?.error_subcode,
      step,
      httpStatus: response.status,
      fbtraceId: data.error?.fbtrace_id,
    };
  }
  return data;
}

type ContainerStatusResult = {
  status: string | null;
  /** A failed status check is transient — carried, never swallowed. */
  pollError: unknown;
};

async function getContainerStatus(
  containerId: string,
  accessToken: string
): Promise<ContainerStatusResult> {
  try {
    const data = await graphRequest(
      `/${encodeURIComponent(containerId)}?fields=status_code`,
      accessToken,
      { method: 'GET' },
      'container-poll'
    );
    return {
      status: typeof data.status_code === 'string' ? data.status_code : null,
      pollError: null,
    };
  } catch (error) {
    // The caller keeps polling within budget, but the error rides along
    // so a budget-expiry failure can surface the real last error instead
    // of pretending the container was merely slow.
    return { status: null, pollError: error };
  }
}

async function postFirstComment(params: {
  mediaId: string;
  accessToken: string;
  message: string;
}): Promise<void> {
  await graphRequest(
    `/${encodeURIComponent(params.mediaId)}/comments`,
    params.accessToken,
    { method: 'POST', body: { message: params.message } },
    'comment'
  );
}

/**
 * Instagram publish for one account: create container → poll →
 * media_publish, with the worker's ambiguous-failure discipline
 * (re-read the container after a failed media_publish; PUBLISHED
 * settles published without a second publish call).
 */
async function publishToInstagramAccount(params: {
  igUserId: string;
  accessToken: string;
  postType: 'photo' | 'reel';
  caption: string;
  mediaUrl: string;
}): Promise<string> {
  const { igUserId, accessToken, postType, caption, mediaUrl } = params;
  const encodedUserId = encodeURIComponent(igUserId);
  const containerBody: Record<string, unknown> = {
    ...(postType === 'reel'
      ? { media_type: 'REELS', video_url: mediaUrl, share_to_feed: true }
      : { image_url: mediaUrl }),
    ...(caption.length > 0 ? { caption } : {}),
  };
  const created = await graphRequest(
    `/${encodedUserId}/media`,
    accessToken,
    { method: 'POST', body: containerBody },
    'container-create'
  );
  const containerId = created.id;
  if (typeof containerId !== 'string' || !containerId) {
    throw steppedError(
      'Instagram could not prepare this post. Please try again.',
      'container-create'
    );
  }

  let statusCode: string | null = null;
  let lastPollError: unknown = null;
  for (let attempt = 0; attempt < CONTAINER_MAX_POLLS; attempt += 1) {
    const checked = await getContainerStatus(containerId, accessToken);
    statusCode = checked.status;
    lastPollError = checked.pollError;
    if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') break;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') break;
    if (attempt < CONTAINER_MAX_POLLS - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS)
      );
    }
  }
  if (statusCode === 'PUBLISHED') return containerId;
  if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
    throw steppedError(
      'Instagram could not prepare this post. Check the media and try again.',
      'container-poll'
    );
  }
  if (statusCode !== 'FINISHED') {
    // If the last status check itself failed, say so with the real error
    // (auth, rate limit, transport) instead of blaming slow preparation.
    if (lastPollError !== null) throw lastPollError;
    throw steppedError(
      'Instagram is still preparing this post. Try again — nothing has been published yet, so a retry will not duplicate it.',
      'container-poll'
    );
  }

  try {
    const published = await graphRequest(
      `/${encodedUserId}/media_publish`,
      accessToken,
      { method: 'POST', body: { creation_id: containerId } },
      'media-publish'
    );
    const mediaId = published.id;
    if (typeof mediaId !== 'string' || !mediaId) {
      throw steppedError(
        'The post could not be completed. Please try again.',
        'media-publish'
      );
    }
    return mediaId;
  } catch (error) {
    const recheck = await getContainerStatus(containerId, accessToken);
    if (recheck.status === 'PUBLISHED') return containerId;
    throw error;
  }
}

/**
 * Reachability + fact probe for a media URL Instagram itself must
 * fetch (image_url / video_url). A HEAD the host rejects (405/501)
 * falls back to a ranged GET. Returns null when the URL cannot be
 * verified at all; content-type/length only when the probe answered.
 */
async function probeMediaUrl(
  mediaUrl: string
): Promise<{ reachable: boolean; contentType: string | null; size: number | null }> {
  try {
    const head = await fetch(mediaUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(MEDIA_HEAD_TIMEOUT_MS),
    });
    if (head.ok) {
      return {
        reachable: true,
        contentType: head.headers.get('content-type'),
        size: head.headers.get('content-length')
          ? Number.parseInt(head.headers.get('content-length') as string, 10)
          : null,
      };
    }
    if (head.status === 405 || head.status === 501) {
      const ranged = await fetch(mediaUrl, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(MEDIA_HEAD_TIMEOUT_MS),
      });
      return {
        reachable: ranged.ok,
        contentType: ranged.headers.get('content-type'),
        size: ranged.headers.get('content-length')
          ? Number.parseInt(ranged.headers.get('content-length') as string, 10)
          : null,
      };
    }
    return { reachable: false, contentType: null, size: null };
  } catch {
    return { reachable: false, contentType: null, size: null };
  }
}

interface ResolvedAccount {
  igUserId: string;
  accessToken: string;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const routeContext = await resolveSocialRouteContext(request, subdomain);
  if (routeContext.errorResponse) return routeContext.errorResponse;
  const { session, workspaceId } = routeContext;

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
        action: 'instagram-publish-now',
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
  const parsed = InstagramPublishNowRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: instagramPublishNowValidationMessage(parsed.error),
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }
  const { caption, postType, firstComment, targets, media } = parsed.data;

  // Post-owned media belongs to the Facebook Publish Now path
  // only. The shared schema accepts the value, so this route
  // rejects it explicitly — net behaviour is unchanged (it
  // previously failed enum validation with 400, and still fails
  // with 400, only with a clearer message).
  if (media?.source === 'post-owned') {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Post-owned media is not supported for Instagram Publish Now.' },
      { status: 400 }
    );
  }

  if (!media) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'This post type needs media.' },
      { status: 400 }
    );
  }

  let encryptionKey: string;
  try {
    encryptionKey = getTokenEncryptionKey();
  } catch {
    return NextResponse.json(
      { error: 'We could not access your Instagram account. Please try again.' },
      { status: 500 }
    );
  }

  // Load every target account up front (bounded: targets ≤ 50, one
  // row each). The Instagram user id comes from this row, never
  // from the client. Accounts that cannot be loaded are skipped by
  // the gate and fail per-account in the loop, so one stale target
  // never blocks the rest.
  const accountCache = new Map<string, ResolvedAccount>();
  const accountFailures = new Map<string, string>();
  for (const target of targets) {
    if (accountCache.has(target.accountId) || accountFailures.has(target.accountId)) {
      continue;
    }
    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .select('external_account_id, encrypted_access_token')
      .eq('id', target.accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'instagram')
      .maybeSingle();
    if (
      accountError ||
      !account?.encrypted_access_token ||
      typeof account.external_account_id !== 'string' ||
      !account.external_account_id
    ) {
      accountFailures.set(
        target.accountId,
        'This Instagram account is no longer available. Reconnect it in Instagram Accounts and try again.'
      );
      continue;
    }
    try {
      const accessToken = await decryptToken(
        account.encrypted_access_token as string,
        encryptionKey
      );
      accountCache.set(target.accountId, {
        igUserId: account.external_account_id,
        accessToken,
      });
    } catch {
      accountFailures.set(
        target.accountId,
        'We could not access your Instagram account. Please try again.'
      );
    }
  }

  // Subscription gate, server-side, before any Instagram call:
  // Publish Now is unlimited (owner decision 2026-10-31): the
  // ONLY gate is an active paid period. There is no per-account
  // cap and no usage registration. A gate failure fails the whole
  // request. Admins are not gated.
  if (session.role !== 'admin') {
    try {
      await assertPaidPlan(supabase, session.userId);
    } catch (err) {
      if (err instanceof SubscriptionGateError) {
        const status = err.code === 'SUBSCRIPTION_REQUIRED' ? 403 : 500;
        return NextResponse.json({ error: err.code, message: err.message }, { status });
      }
      throw err;
    }
  }

  // Resolve the media URL server-side. Library media: the stored row
  // (ownership = session user) is the source of truth — the client's
  // URL is never trusted. Temp media: the URL must be the R2 public
  // URL for a key under the caller's own temp prefix.
  let mediaUrl: string | null = null;
  let libraryMimeType: string | null = null;
  let libraryFileSize: number | null = null;
  let libraryWidth: number | null = null;
  let libraryHeight: number | null = null;
  if (media.source === 'library' && media.mediaId) {
    const { data, error } = await supabase
      .from('media_items')
      .select('id, media_type, url, mime_type, file_size, width, height')
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
    libraryMimeType = typeof data.mime_type === 'string' ? data.mime_type : null;
    libraryFileSize = typeof data.file_size === 'number' ? data.file_size : null;
    libraryWidth = typeof data.width === 'number' ? data.width : null;
    libraryHeight = typeof data.height === 'number' ? data.height : null;
  } else if (media.source === 'temp' && media.tempKey) {
    const config = getR2Config();
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
  if (!mediaUrl) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'This post type needs media.' },
      { status: 400 }
    );
  }

  // Instagram itself must fetch the media URL, so an unreachable URL
  // would fail every account with a generic Meta error — fail the
  // whole request early with a specific reason instead. The same
  // probe supplies the photo facts (JPEG / 8 MB / aspect) when the
  // library row does not already carry them.
  const probe = await probeMediaUrl(mediaUrl);
  if (!probe.reachable) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'The photo or video could not be uploaded. Please re-attach it and try again.',
      },
      { status: 400 }
    );
  }
  if (postType === 'photo') {
    const mimeType = libraryMimeType ?? probe.contentType?.split(';')[0]?.trim() ?? null;
    if (mimeType && mimeType !== 'image/jpeg') {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Instagram photos must be JPEG files. Choose a JPEG photo and try again.' },
        { status: 400 }
      );
    }
    const size = libraryFileSize ?? probe.size;
    if (size !== null && Number.isFinite(size) && size > INSTAGRAM_PHOTO_MAX_BYTES) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Instagram photos can be at most 8 MB. Choose a smaller photo and try again.' },
        { status: 400 }
      );
    }
    const width = media.width ?? libraryWidth;
    const height = media.height ?? libraryHeight;
    if (width !== null && height !== null && height > 0) {
      const ratio = width / height;
      if (ratio < INSTAGRAM_PHOTO_MIN_ASPECT || ratio > INSTAGRAM_PHOTO_MAX_ASPECT) {
        return NextResponse.json(
          { error: 'INVALID_REQUEST', message: 'Instagram photos must be between 4:5 and 1.91:1 in shape. Crop the photo and try again.' },
          { status: 400 }
        );
      }
    }
  }

  const trimmedFirstComment = firstComment?.trim() || undefined;

  // Idempotency lookup runs AFTER all validation above (so a
  // rejected request never claims a key) and BEFORE the publish
  // loop (so a resend never re-executes). A lookup failure is 500
  // fail-loud: the request has not executed yet, so failing it is safe.
  let idempotencyClaimed = false;
  if (idempotencyScope) {
    let stored: Awaited<ReturnType<typeof lookupIdempotencyResult>>;
    try {
      stored = await lookupIdempotencyResult(routeContext.client, idempotencyScope);
    } catch {
      return NextResponse.json(
        { error: 'We could not verify this publish request. Please try again.' },
        { status: 500 }
      );
    }
    if (stored) {
      const replayed = InstagramPublishNowResponseSchema.safeParse(stored.body);
      if (!replayed.success) {
        logServerError(
          '[instagram-publish-now] Stored idempotency body failed validation',
          new Error('Stored instagram-publish-now idempotency body failed validation'),
          { source: 'instagram-publish-now', subdomain }
        );
        return NextResponse.json(
          { error: 'We could not verify this publish request. Please try again.' },
          { status: 500 }
        );
      }
      const replayResults = replayed.data.results;
      // First-comment recovery only: a resend carrying the same
      // first comment retries ONLY the failed comments against the
      // stored media ids. Nothing here re-publishes.
      if (trimmedFirstComment) {
        let commentRetried = false;
        for (const result of replayResults) {
          if (result.status !== 'published' || !result.firstCommentFailed || !result.postId) {
            continue;
          }
          const cached = accountCache.get(result.accountId);
          if (!cached) continue;
          try {
            await postFirstComment({
              mediaId: result.postId,
              accessToken: cached.accessToken,
              message: trimmedFirstComment,
            });
            result.firstCommentFailed = null;
            result.firstCommentReason = null;
            commentRetried = true;
          } catch (commentError) {
            result.firstCommentReason = toGraphFailure(commentError).message.slice(0, 500);
            logServerError('[instagram-publish-now] First-comment retry failed on replay', commentError, {
              source: 'instagram-publish-now',
              subdomain,
            });
          }
        }
        if (commentRetried) {
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
      claim = await claimIdempotencyResult(routeContext.client, idempotencyScope);
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

  const results: InstagramPublishNowResult[] = [];
  // Sequential, one account at a time, continuing on failure.
  for (const target of targets) {
    const loopStep: InstagramPublishNowStep = 'account';
    try {
      const cached = accountCache.get(target.accountId);
      if (!cached) {
        throw new Error(accountFailures.get(target.accountId) ?? 'This Instagram account is no longer available.');
      }
      const postId = await publishToInstagramAccount({
        igUserId: cached.igUserId,
        accessToken: cached.accessToken,
        postType,
        caption,
        mediaUrl,
      });
      let firstCommentFailed = false;
      let firstCommentReason: string | null = null;
      if (trimmedFirstComment) {
        try {
          await postFirstComment({
            mediaId: postId,
            accessToken: cached.accessToken,
            message: trimmedFirstComment,
          });
        } catch (commentError) {
          firstCommentFailed = true;
          firstCommentReason = toGraphFailure(commentError).message.slice(0, 500);
          logServerError('[instagram-publish-now] First comment failed for a target', commentError, {
            source: 'instagram-publish-now',
            subdomain,
          });
        }
      }
      results.push({
        accountId: target.accountId,
        accountName: target.accountName,
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
      logServerError('[instagram-publish-now] Publish failed for a target', error, {
        source: 'instagram-publish-now',
        subdomain,
        graphCode: failure.code ?? null,
        graphSubcode: failure.subcode ?? null,
        step,
        httpStatus: failure.httpStatus ?? null,
        fbtraceId: failure.fbtraceId ?? null,
      });
      results.push({
        accountId: target.accountId,
        accountName: target.accountName,
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

  const responseBody = InstagramPublishNowResponseSchema.parse({ results });
  if (idempotencyScope) {
    if (results.some((result) => result.status === 'published')) {
      if (idempotencyClaimed) {
        const completed = await completeIdempotencyResult(
          routeContext.client,
          idempotencyScope,
          { status: 200, body: responseBody }
        );
        if (!completed) {
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
      await releaseIdempotencyClaim(routeContext.client, idempotencyScope);
    }
  }
  return NextResponse.json(responseBody);
}
