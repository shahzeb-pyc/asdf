import { type NextRequest, NextResponse } from 'next/server';
import {
  decryptToken,
  getTokenEncryptionKey,
  ThreadsPublishNowRequestSchema,
  ThreadsPublishNowResponseSchema,
  threadsPublishNowValidationMessage,
  type ThreadsPublishNowResult,
  type ThreadsPublishNowStep,
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
  assertCanPost,
  registerUsage,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';

/**
 * POST /api/tenant/[subdomain]/threads/publish-now
 *
 * Direct, synchronous, multi-account Threads publish, modelled
 * on Facebook Publish Now (apps/web/src/app/api/tenant/[subdomain]
 * /publishing/publish-now/route.ts) with only Threads differences:
 *
 * - Targets are connected Threads accounts (no pages step):
 *   the account's token is decrypted server-side and used in
 *   memory only, never sent to the browser, never stored.
 * - Threads has no upload endpoint: Meta fetches the public
 *   media URL itself, so the media URL is reachability-checked
 *   (and, for images, size-checked at 8 MB when known) before
 *   any container is created.
 * - Publishing is the worker's container flow
 *   (apps/worker/src/publishers/threads.ts): create container
 *   → poll status → publish ONLY on FINISHED. Polling
 *   deviation, stated openly: the worker polls once a minute
 *   up to 5 minutes, which a synchronous multi-account route
 *   cannot do without timing out. This route polls every
 *   10 seconds, up to 12 polls (2 minutes) per account. A
 *   container still preparing after that fails with a specific
 *   "still preparing" reason, never as "published", so a later
 *   retry cannot silently duplicate a post the user has not
 *   checked on their Threads profile.
 * - The reply (Facebook Publish Now's first comment) is a
 *   Threads reply post (`reply_to_id`): posted only after that
 *   account's post succeeds; a reply failure is a warning on
 *   an otherwise published row, never a failed row.
 *
 * Database writes: ONLY the idempotency record (action
 * `threads-publish-now`) and the subscription-usage registry.
 * No queue, destination, publish-log, media, or history rows.
 * Publishing continues to the remaining accounts even when
 * one fails; the response carries one result per target.
 */

const GRAPH_BASE_URL = 'https://graph.threads.net/v1.0';
const GRAPH_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_ATTEMPTS = 12;

const STEPS: ReadonlySet<string> = new Set([
  'container-create',
  'container-status',
  'container-publish',
  'media-fetch',
  'reply',
  'publish',
]);

interface GraphFailure {
  code?: number | undefined;
  subcode?: number | undefined;
  message: string;
  step?: ThreadsPublishNowStep | undefined;
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
  return {
    code: finiteNumber(record.code),
    subcode: finiteNumber(record.subcode),
    message: nonEmptyString(record.message) ?? 'Publishing failed. Please try again.',
    step:
      typeof record.step === 'string' && STEPS.has(record.step)
        ? (record.step as ThreadsPublishNowStep)
        : undefined,
    httpStatus: finiteNumber(record.httpStatus) ?? finiteNumber(record.status),
    fbtraceId: nonEmptyString(record.fbtraceId),
  };
}

function steppedError(message: string, step: ThreadsPublishNowStep): Error {
  const error = new Error(message);
  (error as unknown as Record<string, unknown>).step = step;
  return error;
}

function friendlyReason(error: unknown): string {
  const failure = toGraphFailure(error);
  if (failure.code === 190) {
    return 'Your Threads connection has expired. Reconnect the account and try again.';
  }
  return failure.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphRequest(
  path: string,
  accessToken: string,
  init: { method: string; body?: Record<string, unknown> },
  step: ThreadsPublishNowStep
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
      message: data.error?.message ?? 'Threads could not complete this request. Please try again.',
      code: data.error?.code,
      subcode: data.error?.error_subcode,
      step,
      httpStatus: response.status,
      fbtraceId: data.error?.fbtrace_id,
    };
  }
  return data;
}

async function createContainer(params: {
  threadsUserId: string;
  accessToken: string;
  mediaType: 'TEXT' | 'IMAGE' | 'VIDEO';
  text?: string | undefined;
  imageUrl?: string | undefined;
  videoUrl?: string | undefined;
  replyToId?: string | undefined;
}): Promise<string> {
  const body: Record<string, unknown> = { media_type: params.mediaType };
  if (params.text) body.text = params.text;
  if (params.imageUrl) body.image_url = params.imageUrl;
  if (params.videoUrl) body.video_url = params.videoUrl;
  if (params.replyToId) body.reply_to_id = params.replyToId;
  const data = await graphRequest(
    `/${encodeURIComponent(params.threadsUserId)}/threads`,
    params.accessToken,
    { method: 'POST', body },
    'container-create'
  );
  if (typeof data.id !== 'string' || !data.id) {
    throw steppedError('Threads could not prepare this post. Please try again.', 'container-create');
  }
  return data.id;
}

async function getContainerStatus(
  containerId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const data = await graphRequest(
      `/${encodeURIComponent(containerId)}?fields=status,error_message`,
      accessToken,
      { method: 'GET' },
      'container-status'
    );
    return typeof data.status === 'string' ? data.status : null;
  } catch (error) {
    const failure = toGraphFailure(error);
    // Initial 404s are expected while the container propagates
    // (worker publisher, same rule): keep polling inside budget.
    if (failure.httpStatus === 404 || failure.code === 24) return null;
    throw error;
  }
}

async function publishContainer(params: {
  threadsUserId: string;
  accessToken: string;
  containerId: string;
}): Promise<string> {
  const data = await graphRequest(
    `/${encodeURIComponent(params.threadsUserId)}/threads_publish`,
    params.accessToken,
    { method: 'POST', body: { creation_id: params.containerId } },
    'container-publish'
  );
  if (typeof data.id !== 'string' || !data.id) {
    throw steppedError('Threads could not publish this post. Please try again.', 'container-publish');
  }
  return data.id;
}

/**
 * One container through the full state machine. Returns the
 * published media id. Throws on every failure — including
 * "still preparing" after the poll budget, which the caller
 * reports as a failed row with that specific reason.
 */
async function publishOneContainer(params: {
  threadsUserId: string;
  accessToken: string;
  mediaType: 'TEXT' | 'IMAGE' | 'VIDEO';
  text?: string | undefined;
  imageUrl?: string | undefined;
  videoUrl?: string | undefined;
  replyToId?: string | undefined;
}): Promise<string> {
  const containerId = await createContainer(params);
  let status: string | null = null;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    status = await getContainerStatus(containerId, params.accessToken);
    if (status === 'FINISHED' || status === 'PUBLISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw steppedError(
        'Threads could not prepare this post. Check the media and try again.',
        'container-status'
      );
    }
    if (attempt < POLL_MAX_ATTEMPTS - 1) await sleep(POLL_INTERVAL_MS);
  }
  if (status === 'PUBLISHED') return containerId;
  if (status !== 'FINISHED') {
    throw steppedError(
      'Threads is still preparing this post. Check your Threads profile before retrying, so you do not post it twice.',
      'container-status'
    );
  }
  try {
    return await publishContainer({
      threadsUserId: params.threadsUserId,
      accessToken: params.accessToken,
      containerId,
    });
  } catch (error) {
    // The 24/4279009 propagation trap (worker publisher, same
    // rule): re-read the container status BEFORE any second
    // publish attempt — never a blind re-publish.
    const failure = toGraphFailure(error);
    const ambiguous =
      (failure.code === 24 && failure.subcode === 4279009) ||
      (failure.code === 24 && failure.httpStatus === 404);
    if (!ambiguous) throw error;
    const rechecked = await getContainerStatus(containerId, params.accessToken);
    if (rechecked === 'PUBLISHED') return containerId;
    if (rechecked === 'FINISHED') {
      return await publishContainer({
        threadsUserId: params.threadsUserId,
        accessToken: params.accessToken,
        containerId,
      });
    }
    throw error;
  }
}

async function postReply(params: {
  threadsUserId: string;
  accessToken: string;
  postId: string;
  message: string;
}): Promise<void> {
  await publishOneContainer({
    threadsUserId: params.threadsUserId,
    accessToken: params.accessToken,
    mediaType: 'TEXT',
    text: params.message,
    replyToId: params.postId,
  });
}

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

async function mediaImageTooLarge(mediaUrl: string): Promise<boolean> {
  try {
    const head = await fetch(mediaUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    const size = head.headers.get('content-length');
    const parsed = size ? Number.parseInt(size, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 8 * 1024 * 1024;
  } catch {
    return false;
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
        action: 'threads-publish-now',
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
  const parsed = ThreadsPublishNowRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: threadsPublishNowValidationMessage(parsed.error),
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }
  const { caption, postType, reply, targets, media } = parsed.data;
  const trimmedReply = reply?.trim() || undefined;

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

  // Resolve the media URL server-side. Library media: the stored
  // row (ownership = session user) is the source of truth — the
  // client's URL is never trusted. Temp media: the URL must be
  // the R2 public URL for a key under the caller's own temp
  // prefix (same prefix as Facebook Publish Now's temp upload).
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
    const expectedType = postType === 'image' ? 'image' : 'video';
    if (data.media_type !== expectedType) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'The selected media does not match the post type.' },
        { status: 400 }
      );
    }
    mediaUrl = data.url;
  } else if (media?.source === 'temp' && media.tempKey) {
    const config = getR2Config();
    let publicBase: string | null = null;
    if (config) {
      let stripped = config.publicUrl;
      while (stripped.endsWith('/')) stripped = stripped.slice(0, -1);
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

  // Threads fetches the media URL itself, so an unreachable URL
  // would fail every account with a generic Threads error — fail
  // the whole request early with a specific reason instead.
  if (mediaUrl) {
    if (!(await mediaUrlReachable(mediaUrl))) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'The media could not be reached. Please re-attach the media and try again.' },
        { status: 400 }
      );
    }
    if (postType === 'image' && (await mediaImageTooLarge(mediaUrl))) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'This photo is over the 8 MB limit for Threads. Choose a smaller photo and try again.' },
        { status: 400 }
      );
    }
  }

  let encryptionKey: string;
  try {
    encryptionKey = getTokenEncryptionKey();
  } catch {
    return NextResponse.json(
      { error: 'We could not access your Threads account. Please try again.' },
      { status: 500 }
    );
  }

  // Subscription gate, server-side, before any Threads call.
  // Pre-check every target first: registering one by one means
  // a cap failure on account 3 would leave accounts 1–2
  // permanently registered even though nothing was published.
  if (session.role !== 'admin') {
    const distinctUserIds = Array.from(new Set(targets.map((t) => t.threadsUserId)));
    try {
      for (const threadsUserId of distinctUserIds) {
        await assertCanPost(supabase, session.userId, 'threads', threadsUserId);
      }
      for (const threadsUserId of distinctUserIds) {
        await registerUsage(supabase, session.userId, 'threads', threadsUserId, 'threads-publish-now', null);
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

  // Idempotency replay: lookup runs AFTER all validation above
  // so a rejected request never claims a key, and BEFORE the
  // publish loop so a resend never re-executes.
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
      const replayed = ThreadsPublishNowResponseSchema.safeParse(stored.body);
      if (!replayed.success) {
        logServerError(
          '[threads-publish-now] Stored idempotency body failed validation',
          new Error('Stored threads publish-now idempotency body failed validation'),
          { source: 'threads-publish-now', subdomain }
        );
        return NextResponse.json(
          { error: 'We could not verify this publish request. Please try again.' },
          { status: 500 }
        );
      }
      const replayResults = replayed.data.results;
      // Reply recovery only: a resend carrying a reply retries
      // ONLY the failed replies against the stored post ids.
      // Nothing here re-publishes.
      if (trimmedReply) {
        let replyRetried = false;
        for (const result of replayResults) {
          if (result.status !== 'published' || !result.replyFailed || !result.postId) continue;
          try {
            const { data: account, error: accountError } = await supabase
              .from('social_accounts')
              .select('encrypted_access_token')
              .eq('id', result.accountId)
              .eq('workspace_id', workspaceId)
              .eq('platform', 'threads')
              .maybeSingle();
            if (accountError || !account?.encrypted_access_token) {
              throw new Error('Threads account not found.');
            }
            const accountToken = await decryptToken(
              account.encrypted_access_token as string,
              encryptionKey
            );
            await postReply({
              threadsUserId: result.threadsUserId,
              accessToken: accountToken,
              postId: result.postId,
              message: trimmedReply,
            });
            result.replyFailed = null;
            result.replyReason = null;
            replyRetried = true;
          } catch (replyError) {
            result.replyReason = toGraphFailure(replyError).message.slice(0, 500);
            logServerError('[threads-publish-now] Reply retry failed on replay', replyError, {
              source: 'threads-publish-now',
              subdomain,
            });
          }
        }
        if (replyRetried) {
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

  const results: ThreadsPublishNowResult[] = [];
  // Sequential, one account at a time, continuing on failure:
  // a burst of parallel publish calls would invite Threads rate
  // limiting, and a failure on one account must never block
  // the rest.
  for (const target of targets) {
    let loopStep: ThreadsPublishNowStep = 'publish';
    try {
      const { data: account, error: accountError } = await supabase
        .from('social_accounts')
        .select('encrypted_access_token, external_account_id')
        .eq('id', target.accountId)
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads')
        .maybeSingle();
      if (accountError || !account?.encrypted_access_token) {
        throw new Error('Threads account not found.');
      }
      let accountToken: string;
      try {
        accountToken = await decryptToken(
          account.encrypted_access_token as string,
          encryptionKey
        );
      } catch {
        throw new Error('We could not access your Threads account. Please try again.');
      }
      const threadsUserId =
        typeof account.external_account_id === 'string' && account.external_account_id
          ? account.external_account_id
          : target.threadsUserId;
      const mediaType = postType === 'text' ? 'TEXT' : postType === 'image' ? 'IMAGE' : 'VIDEO';
      loopStep = 'container-create';
      const postId = await publishOneContainer({
        threadsUserId,
        accessToken: accountToken,
        mediaType,
        ...(caption ? { text: caption } : {}),
        ...(mediaType === 'IMAGE' && mediaUrl ? { imageUrl: mediaUrl } : {}),
        ...(mediaType === 'VIDEO' && mediaUrl ? { videoUrl: mediaUrl } : {}),
      });
      let replyFailed = false;
      let replyReason: string | null = null;
      if (trimmedReply) {
        try {
          await postReply({
            threadsUserId,
            accessToken: accountToken,
            postId,
            message: trimmedReply,
          });
        } catch (replyError) {
          replyFailed = true;
          replyReason = toGraphFailure(replyError).message.slice(0, 500);
          logServerError('[threads-publish-now] Reply failed for a target', replyError, {
            source: 'threads-publish-now',
            subdomain,
          });
        }
      }
      results.push({
        accountId: target.accountId,
        threadsUserId: target.threadsUserId,
        accountName: target.accountName,
        handle: target.handle ?? null,
        status: 'published',
        postId,
        reason: null,
        graphCode: null,
        graphSubcode: null,
        step: null,
        httpStatus: null,
        fbtraceId: null,
        replyFailed: replyFailed || null,
        replyReason,
      });
    } catch (error) {
      const failure = toGraphFailure(error);
      const step = failure.step ?? loopStep;
      logServerError('[threads-publish-now] Publish failed for a target', error, {
        source: 'threads-publish-now',
        subdomain,
        graphCode: failure.code ?? null,
        graphSubcode: failure.subcode ?? null,
        step,
        httpStatus: failure.httpStatus ?? null,
        fbtraceId: failure.fbtraceId ?? null,
      });
      results.push({
        accountId: target.accountId,
        threadsUserId: target.threadsUserId,
        accountName: target.accountName,
        handle: target.handle ?? null,
        status: 'failed',
        postId: null,
        reason: friendlyReason(error),
        graphCode: failure.code ?? null,
        graphSubcode: failure.subcode ?? null,
        step,
        httpStatus: failure.httpStatus ?? null,
        fbtraceId: failure.fbtraceId ?? null,
        replyFailed: null,
        replyReason: null,
      });
    }
  }

  const responseBody = ThreadsPublishNowResponseSchema.parse({ results });
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
