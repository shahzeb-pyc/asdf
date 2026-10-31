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
  assertPaidPlan,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import {
  postThreadsReply,
  publishOneThreadsContainer,
  threadsFriendlyReason,
  threadsMediaImageTooLarge,
  threadsMediaUrlReachable,
  toThreadsGraphFailure,
} from '@/lib/publishing/threads-publish-now';

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
 * `threads-publish-now`). Publish Now writes no subscription-usage
 * rows: it is unlimited (owner decision 2026-10-31), gated only
 * on an active paid period.
 * No queue, destination, publish-log, media, or history rows.
 * Publishing continues to the remaining accounts even when
 * one fails; the response carries one result per target.
 */

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
    if (!(await threadsMediaUrlReachable(mediaUrl))) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'The media could not be reached. Please re-attach the media and try again.' },
        { status: 400 }
      );
    }
    if (postType === 'image' && (await threadsMediaImageTooLarge(mediaUrl))) {
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
  // Publish Now is unlimited (owner decision 2026-10-31): the
  // ONLY gate is an active paid period. There is no per-account
  // cap and no usage registration. Admins are not gated.
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
            await postThreadsReply({
              threadsUserId: result.threadsUserId,
              accessToken: accountToken,
              postId: result.postId,
              message: trimmedReply,
            });
            result.replyFailed = null;
            result.replyReason = null;
            replyRetried = true;
          } catch (replyError) {
            result.replyReason = toThreadsGraphFailure(replyError).message.slice(0, 500);
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
      const postId = await publishOneThreadsContainer({
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
          await postThreadsReply({
            threadsUserId,
            accessToken: accountToken,
            postId,
            message: trimmedReply,
          });
        } catch (replyError) {
          replyFailed = true;
          replyReason = toThreadsGraphFailure(replyError).message.slice(0, 500);
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
      const failure = toThreadsGraphFailure(error);
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
        reason: threadsFriendlyReason(error),
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
