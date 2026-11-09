import {
  destinationFbStatusMarker,
  evaluateGraphApiError,
  isPageGoneSignal,
  ValidationError,
  type ClassifiedPublishError,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type GraphRateLimitTelemetry,
  type IFacebookPublishClient,
  type Platform,
  type Publisher,
  type PublisherTokenSet,
  type PublishOutcome,
  type RefreshedTokenSet,
} from '@fbuploadpro/contracts';
import {
  FacebookGraphError,
  FacebookPublishClient,
  type FacebookPublishDiagnostic,
} from '../fb-client.js';

// ==========================================
// Facebook publisher (spec 122 — port of the pre-121 dispatcher)
// ==========================================
//
// This module moves the existing Facebook publishing behaviour behind
// the contracts `Publisher` interface with NO behaviour change. The
// parity source of truth is the pre-121 dispatcher deleted in PR #653
// (`git show fe45344:apps/worker/src/dispatcher.ts`): per-format
// dispatch, the first-comment flow, the retry/backoff formula, the
// max-retries handling, and the Graph-error status side effects are
// reproduced here in the unified `PublishOutcome` vocabulary.
//
// Translation notes (old vocabulary -> unified vocabulary, spec 120):
//   - Page status `fb_rate_limited` -> destination status `rate_limited`,
//     `invalid_token` -> `error`, `page_checkpoint` -> `error`,
//     `paused` -> `disconnected` (the backfill CASE in migration
//     20261022120000; the settle RPC also translates legacy names, but
//     this publisher emits the new names directly).
//   - Account status `expired` is spelled the same in both vocabularies.
//   - The old 3-day `fb_rate_limited` recovery was driven by the page
//     status timestamp in the old claim SQL. The claim RPCs now flip a
//     `rate_limited` destination back to `active` once its
//     `metadata.rate_limited_at` anchor (written by the settle RPC on
//     marking, `updated_at` as the legacy-only fallback) is 3+ days old
//     — the same 3-day window, kept as a status anchor, not a cooldown
//     write (migration 20261102160000 removed cooldown pacing).
//   - Graph telemetry `bucUsageMaxPct` -> `rateUsagePct` (the old
//     `buc_usage_pct` page column is `destinations.rate_usage_pct`).

export const FACEBOOK_PLATFORM: Platform = 'facebook';

/** Dispatch retry/backoff tuning — identical to the old dispatcher. */
const DISPATCH_RETRY_BASE_DELAY_SECONDS = 300;
const DISPATCH_RETRY_MAX_DELAY_SECONDS = 3600;

/** First-comment retry tuning — identical to the old dispatcher. */
const FIRST_COMMENT_MAX_ATTEMPTS = 3;
const FIRST_COMMENT_RETRY_DELAY_MS = 500;

type FacebookFormat = 'text' | 'image' | 'reel' | 'video' | 'story' | 'carousel';

interface ExtractedError {
  code: number | undefined;
  subcode: number | undefined;
  message: string;
  telemetry: GraphRateLimitTelemetry | undefined;
  isAuthError: boolean;
  isPermanentPolicyError: boolean;
  isPermanentClientError: boolean;
  isRateLimit: boolean;
  /**
   * Full failure diagnostic from the client (failing phase, HTTP status,
   * raw body), when the client recorded one. Carried into the outcome's
   * `detail` by `failureOutcome` so settlement persists it.
   */
  diagnostic: FacebookPublishDiagnostic | undefined;
}

function isRateLimitErrorCode(code?: number, subcode?: number): boolean {
  if (code === undefined) return false;
  if (code === 4 || code === 17 || code === 32 || code === 341 || code === 613) {
    return true;
  }
  if (code === 368 && subcode === 1390008) {
    return true;
  }
  if (code >= 80000 && code <= 80014) {
    return true;
  }
  return false;
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Extracts the Graph error shape from any thrown value. Facebook client
 * failures are `FacebookGraphError`s (flags + telemetry carried on the
 * instance); plain objects with a numeric `code` are read defensively;
 * everything else yields no code and is classified by the fallback in
 * `classifyExtracted` — exactly the old dispatcher's fallback, under
 * which an error with no permanent/auth signal was transient.
 */
function extractError(err: unknown): ExtractedError {
  const rawMessage = err instanceof Error ? err.message : String(err);

  if (err instanceof FacebookGraphError) {
    return {
      code: err.code,
      subcode: err.errorSubcode,
      message: rawMessage,
      telemetry: err.telemetry,
      isAuthError: err.isAuthError,
      isPermanentPolicyError: err.isPermanentPolicyError,
      isPermanentClientError: err.isPermanentClientError,
      isRateLimit: err.isRateLimit,
      diagnostic: err.diagnostic,
    };
  }

  const record = (err ?? {}) as Record<string, unknown>;
  const code = numericField(record.code);
  const subcode =
    numericField(record.error_subcode) ?? numericField(record.errorSubcode) ?? numericField(record.subcode);
  // Spec 155: the raw message is part of the classification — the
  // classifier reads it for the 368 suspension / developer-app rules
  // and the 200 "api access blocked" rule.
  const evaluation = code !== undefined ? evaluateGraphApiError(code, subcode, rawMessage) : null;

  return {
    code,
    subcode,
    message: rawMessage,
    telemetry: undefined,
    isAuthError: evaluation?.requiresReauth === true,
    isPermanentPolicyError: code === 368 && (subcode === 4854002 || subcode === 1404082 || subcode === 1404102),
    isPermanentClientError:
      code === 100 ||
      code === 506 ||
      code === 1609005 ||
      code === 382 ||
      code === 1363040 ||
      (code !== undefined && code >= 400 && code < 500 && evaluation?.requiresReauth !== true),
    isRateLimit:
      isRateLimitErrorCode(code, subcode) || (code === 368 && subcode !== 4854002 && subcode !== 1404082 && subcode !== 1404102),
    diagnostic: undefined,
  };
}

/**
 * Classifies an extracted error. Priority mirrors the old dispatcher's
 * outcome computation, expressed in the shared taxonomy:
 *   auth      — evaluation requires reauth (190/102) or the Graph
 *               error's auth flag. Spec 155: 10 / 200-299 no longer
 *               require reauth (they are missing-permission / developer-
 *               app states now), so they classify `permanent`, not `auth`;
 *   permanent — permanent policy (368/4854002, 368/1404082, 368/1404102), permanent
 *               client (100, 506, 1609005, 382, 1363040, other 4xx), or any
 *               non-transient evaluation that is not auth;
 *   retryable — transient evaluations, rate-limit codes
 *               (4/17/32/341/613/80000-80014, 368 non-policy), and the
 *               old fallback for unknown errors (no code, or no
 *               permanent/auth signal), which the old dispatcher
 *               treated as transient.
 *
 * The message follows the old dispatcher's rule: for 368 with subcode
 * 4854002, 1404082 or 1404102 the canonical evaluation message replaces the raw
 * Graph message; every other error keeps its raw message.
 */
function classifyExtracted(extracted: ExtractedError): ClassifiedPublishError {
  const { code, subcode } = extracted;
  // Spec 155: pass the message so the classifier's message-dependent
  // rules apply here too — without it a 368 + "suspended" message
  // would still classify retryable (rate-limited) and keep retrying
  // a suspended account.
  const evaluation = code !== undefined ? evaluateGraphApiError(code, subcode, extracted.message) : null;

  const message =
    code === 368 && (subcode === 4854002 || subcode === 1404082 || subcode === 1404102) && evaluation
      ? evaluation.message
      : extracted.message;

  let kind: ClassifiedPublishError['kind'];
  if (extracted.isAuthError || evaluation?.requiresReauth === true) {
    kind = 'auth';
  } else if (
    extracted.isPermanentPolicyError ||
    extracted.isPermanentClientError ||
    (evaluation !== null && !evaluation.isTransient)
  ) {
    kind = 'permanent';
  } else if (
    evaluation?.isTransient === true ||
    extracted.isRateLimit ||
    isRateLimitErrorCode(code, subcode)
  ) {
    kind = 'retryable';
  } else {
    // Old dispatcher fallback: `!isAuth && !isPermanentPolicy &&
    // !isPermanentClient` was transient, for coded and uncoded errors
    // alike (validation errors, transport failures, unknown errors).
    kind = 'retryable';
  }

  return {
    kind,
    // No numeric Graph code (e.g. a body-less HTTP 400): store the HTTP
    // status as the code instead of `unknown`, so the queue item's own
    // error fields carry a real reason. Classification above keys off
    // the numeric code, so this changes no retry/permanent decision.
    code:
      errCodeString(extracted) ??
      (extracted.diagnostic?.httpStatus !== undefined
        ? `http_${extracted.diagnostic.httpStatus}`
        : 'unknown'),
    ...(subcode !== undefined ? { subcode: String(subcode) } : {}),
    message,
    ...(extracted.telemetry?.estimatedTimeToRegainAccessMinutes &&
    extracted.telemetry.estimatedTimeToRegainAccessMinutes > 0
      ? {
          retryDelaySeconds:
            extracted.telemetry.estimatedTimeToRegainAccessMinutes * 60,
        }
      : {}),
  };
}

function errCodeString(extracted: ExtractedError): string | undefined {
  return extracted.code !== undefined ? String(extracted.code) : undefined;
}

/** Maps an old page status onto the unified destination status (spec 120). */
function mapDestinationStatus(
  oldPageStatus: string
): DatabaseDestinationRow['status'] | undefined {
  switch (oldPageStatus) {
    case 'fb_rate_limited':
      return 'rate_limited';
    case 'invalid_token':
      return 'error';
    case 'page_checkpoint':
      return 'error';
    // Spec 155: the new detail statuses all ride on coarse `error` —
    // the detail lives in the `fb_status` marker (see
    // `targetDestinationFbStatus` on the outcome), not in the coarse
    // status. Queued work pauses on `error` (the readiness check
    // treats it as unclaimable) and is never failed for the error
    // itself.
    case 'page_not_accessible':
    case 'missing_page_access':
    case 'missing_permission':
    case 'check_developer_app':
    case 'account_suspended':
    case '2fa_required_on_BM':
      return 'error';
    case 'paused':
      return 'disconnected';
    case 'active':
      return 'active';
    default:
      return undefined;
  }
}

function resolveFormat(item: DatabaseUnifiedQueueItemRow): FacebookFormat {
  const pf = item.platform_format?.trim().toLowerCase();
  switch (pf) {
    case 'text':
    case 'link':
      return 'text';
    case 'image':
    case 'photo':
      return 'image';
    case 'reel':
    case 'reels':
      return 'reel';
    case 'video':
      return 'video';
    case 'story':
    case 'stories':
      return 'story';
    case 'carousel':
      return 'carousel';
    default:
      break;
  }
  // No (recognised) platform format: the normalised kind drives, which
  // is how backfilled rows read (`reel` arrives as kind `video` with
  // platform_format `reel`, handled above; a bare kind `video` is a
  // feed video, matching the old dispatcher's media-type fallback).
  switch (item.kind) {
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'story':
      return 'story';
    case 'carousel':
      return 'carousel';
    default:
      return 'video';
  }
}

/**
 * Whether a story item is a photo story. The old dispatcher branched on
 * the claimed row's media type (`image` -> photo story, anything else
 * -> video story). The unified row carries no media-type column, so
 * the signal is, in order: an explicit media type in
 * `platform_options`, a photo/image story format label, then the media
 * URL's image extension — falling back to video, the old default.
 */
function isPhotoStory(item: DatabaseUnifiedQueueItemRow): boolean {
  const options = item.platform_options ?? {};
  const optionMediaType =
    (typeof options.media_type === 'string' && options.media_type) ||
    (typeof options.mediaType === 'string' && options.mediaType) ||
    '';
  if (optionMediaType) return optionMediaType.toLowerCase() === 'image';

  const pf = item.platform_format?.trim().toLowerCase() ?? '';
  if (pf.includes('photo') || pf.includes('image')) return true;
  if (pf.includes('video')) return false;

  const url = (item.media_url ?? '').split('?')[0]?.toLowerCase() ?? '';
  return /\.(?:jpe?g|png|gif|webp|avif)$/.test(url);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FacebookPublisher implements Publisher {
  readonly platform: Platform = FACEBOOK_PLATFORM;
  private readonly client: IFacebookPublishClient;

  constructor(client: IFacebookPublishClient = new FacebookPublishClient()) {
    this.client = client;
  }

  /**
   * Classifies any error thrown by the Facebook client. Pure and
   * total: never throws. See `classifyExtracted` for the parity rules.
   */
  mapError(err: unknown): ClassifiedPublishError {
    return classifyExtracted(extractError(err));
  }

  /**
   * Facebook token refresh is interface completeness, not a stub.
   *
   * Spec 121's refresh job NEVER calls a publisher for a Facebook
   * account: Facebook's contracts refresh strategy is
   * `lapse-detection`, and `runRefreshCycle` (apps/worker/src/refresh.ts)
   * handles Facebook rows itself — flipping the account to `expired`
   * once its user token has actually lapsed — before any publisher is
   * looked up. There is no Facebook refresh grant to spend, so the
   * correct implementation returns the supplied tokens unchanged.
   */
  refreshTokens(
    _account: DatabaseSocialAccountRow,
    tokens: PublisherTokenSet
  ): Promise<RefreshedTokenSet> {
    return Promise.resolve({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      tokenExpiresAt: tokens.tokenExpiresAt ?? null,
    });
  }

  async publish(
    item: DatabaseUnifiedQueueItemRow,
    destination: DatabaseDestinationRow,
    tokens: PublisherTokenSet
  ): Promise<PublishOutcome> {
    const pageId = destination.external_destination_id;
    const accessToken = tokens.destinationToken ?? '';

    // Old dispatcher: a missing/empty Page token was a direct `failed`
    // outcome with no error code and no status side effects (token
    // decryption itself now happens in the consumer, before publish).
    // The unified vocabulary carries that as a permanent failure with
    // a descriptive code and — like the old outcome — no destination
    // or account status, so no expired cascade fires for it.
    if (!accessToken) {
      return {
        status: 'failed',
        error: {
          kind: 'permanent',
          code: 'missing_destination_token',
          message:
            'Token decryption failed: Access token is missing or page is soft-deleted',
        },
      };
    }

    const format = resolveFormat(item);
    const effectiveMaxRetries = item.max_retries ?? 3;

    let publishResult: { postId: string; telemetry?: GraphRateLimitTelemetry | undefined };
    try {
      publishResult = await this.dispatchByFormat(format, item, pageId, accessToken);
    } catch (err: unknown) {
      return this.failureOutcome(err, item.retry_count, effectiveMaxRetries);
    }

    // Automated first comment — strictly forbidden on stories, exactly
    // as the old dispatcher: 3 attempts, and a failure after the post
    // is live settles as a comment warning on a published outcome,
    // never as a post failure.
    let externalCommentId: string | undefined;
    let commentWarning: string | undefined;
    if (format !== 'story' && item.first_comment && item.first_comment.trim().length > 0) {
      const comment = await this.postFirstCommentWithRetry({
        postId: publishResult.postId,
        accessToken,
        message: item.first_comment.trim(),
        itemId: item.id,
      });
      externalCommentId = comment.commentId ?? undefined;
      commentWarning = comment.warning ?? undefined;
    }

    // BUC usage is reported on every published outcome that carried
    // it, as the `rateUsagePct` meter only. There is no cooldown on
    // success: migration 20261102160000 removed the >= 85% pacing
    // trigger, so a high BUC reading never gates the destination.
    let rateUsagePct: number | undefined;
    if (
      publishResult.telemetry?.bucUsageMaxPct !== undefined &&
      publishResult.telemetry.bucUsageMaxPct !== null
    ) {
      rateUsagePct = publishResult.telemetry.bucUsageMaxPct;
    }

    return {
      status: 'published',
      externalPostId: publishResult.postId,
      ...(externalCommentId !== undefined ? { externalCommentId } : {}),
      ...(commentWarning ? { commentWarning } : {}),
      ...(rateUsagePct !== undefined ? { rateUsagePct } : {}),
    };
  }

  private async dispatchByFormat(
    format: FacebookFormat,
    item: DatabaseUnifiedQueueItemRow,
    pageId: string,
    accessToken: string
  ): Promise<{ postId: string; telemetry?: GraphRateLimitTelemetry | undefined }> {
    const client = this.client;
    switch (format) {
      case 'text': {
        if (typeof client.publishTextPost === 'function') {
          return client.publishTextPost({
            pageId,
            accessToken,
            message: item.caption,
            linkUrl: item.link_url,
          });
        }
        throw new ValidationError('Facebook client does not support publishTextPost');
      }
      case 'image': {
        if (!item.media_url) {
          throw new ValidationError('Media URL is required for image publishing');
        }
        return client.publishPhoto({
          pageId,
          accessToken,
          imageUrl: item.media_url,
          caption: item.caption,
        });
      }
      case 'reel': {
        if (!item.media_url) {
          throw new ValidationError('Media URL is required for reel publishing');
        }
        return client.publishReel({
          pageId,
          accessToken,
          videoUrl: item.media_url,
          caption: item.caption,
          // Queue / ADU row id, so the [reel-publish] console lines in
          // Cloudflare Worker Logs name the post that failed.
          itemId: item.id,
        });
      }
      case 'video': {
        if (!item.media_url) {
          throw new ValidationError('Media URL is required for video publishing');
        }
        if (typeof client.publishVideo === 'function') {
          return client.publishVideo({
            pageId,
            accessToken,
            videoUrl: item.media_url,
            caption: item.caption,
          });
        }
        return client.publishReel({
          pageId,
          accessToken,
          videoUrl: item.media_url,
          caption: item.caption,
          // Same reel path as the 'reel' case: the item id belongs on
          // the [reel-publish] console lines too.
          itemId: item.id,
        });
      }
      case 'story': {
        if (!item.media_url) {
          throw new ValidationError('Media URL is required for story publishing');
        }
        if (isPhotoStory(item)) {
          if (typeof client.publishPhotoStory === 'function') {
            return client.publishPhotoStory({
              pageId,
              accessToken,
              imageUrl: item.media_url,
            });
          }
          throw new ValidationError('Facebook client does not support publishPhotoStory');
        }
        if (typeof client.publishVideoStory === 'function') {
          return client.publishVideoStory({
            pageId,
            accessToken,
            videoUrl: item.media_url,
          });
        }
        throw new ValidationError('Facebook client does not support publishVideoStory');
      }
      default: {
        // Includes `carousel`: the old dispatcher's format set had no
        // carousel path and fell through to this same validation error.
        throw new ValidationError(`Unsupported post format: ${String(format)}`);
      }
    }
  }

  private async postFirstCommentWithRetry(params: {
    postId: string;
    accessToken: string;
    message: string;
    itemId: string;
  }): Promise<{ commentId: string | null; warning: string | null }> {
    let attempt = 1;
    for (;;) {
      try {
        const commentRes = await this.client.postComment({
          postId: params.postId,
          accessToken: params.accessToken,
          message: params.message,
        });
        return { commentId: commentRes.commentId, warning: null };
      } catch (commentErr: unknown) {
        if (attempt >= FIRST_COMMENT_MAX_ATTEMPTS) {
          const errMsg =
            commentErr instanceof Error ? commentErr.message : String(commentErr);
          console.warn(
            `[FacebookPublisher] First comment failed for queue item ${params.itemId} (post ${params.postId}):`,
            commentErr
          );
          return {
            commentId: null,
            warning: `Published post but first comment failed: ${errMsg}`,
          };
        }
        await sleepMs(attempt * FIRST_COMMENT_RETRY_DELAY_MS);
        attempt += 1;
      }
    }
  }

  /**
   * Builds the failure outcome for a publish error, reproducing the old
   * dispatcher's outcome computation field for field:
   *   - status: `retry` only when the error is transient and
   *     retry_count < max_retries, otherwise `failed`;
   *   - retry delay: telemetry regain minutes when present, else
   *     min(3600, 300 * 2^retry_count);
   *   - destination status: the evaluation's non-active page status,
   *     mapped to the unified vocabulary;
   *   - account status: `expired` only when the classifier evaluation
   *     says `expired`. The old dispatcher also expired the account
   *     for any auth error carrying code 190/102, which bypassed the
   *     classifier and expired the account for codes the classifier
   *     deliberately keeps active (190/459, 190/464, 190/492,
   *     190/2069032) — that second disjunct is removed; the
   *     evaluation is the single decision point.
   *   Volume-limit errors (4/17/32/341/613/80000-80014) never park the
   *   page: they retry with the existing backoff and no status flip.
   *   Only the 368 spam throttle (and the temporarily-blocked signal)
   *   marks the destination `rate_limited`, and the settle RPC stamps
   *   the 3-day anchor when it does — there is no cooldown write
   *   (migration 20261102160000).
   */
  private failureOutcome(
    err: unknown,
    retryCount: number,
    effectiveMaxRetries: number
  ): PublishOutcome {
    const extracted = extractError(err);
    const classified = classifyExtracted(extracted);
    const { code, subcode } = extracted;
    // Spec 155: pass the message — the classifier's message-dependent
    // rules (368 suspension / developer-app, 200 "api access blocked")
    // only fire with it.
    const evaluation = code !== undefined ? evaluateGraphApiError(code, subcode, extracted.message) : null;

    // Spec 155: the page is gone — no numeric code (e.g. a body-less
    // HTTP 404) or an unmapped one, but the message / HTTP status says
    // the page no longer exists. Only when the classifier had no
    // opinion: a mapped evaluation (even `active`, e.g. a content
    // error) is never overridden by the message.
    const pageGone =
      evaluation === null &&
      isPageGoneSignal(extracted.message, extracted.diagnostic?.httpStatus);

    let targetDestinationStatus: DatabaseDestinationRow['status'] | undefined;
    let targetDestinationFbStatus: PublishOutcome['targetDestinationFbStatus'];
    if (pageGone) {
      targetDestinationStatus = 'error';
      targetDestinationFbStatus = 'page_not_accessible';
    } else if (evaluation?.pageStatus && evaluation.pageStatus !== 'active') {
      targetDestinationStatus = mapDestinationStatus(evaluation.pageStatus);
      // The detail marker rides with the coarse status: a detail
      // status sets it, `fb_rate_limited` clears it (its anchor is
      // `rate_limited_at`). An `active` evaluation leaves both the
      // status and the marker untouched — a failure that says nothing
      // about the page must not disturb either.
      targetDestinationFbStatus = destinationFbStatusMarker(evaluation.pageStatus);
    } else if (code === 368 && subcode === 1390008) {
      targetDestinationStatus = 'rate_limited';
      // Rate-limited clears any stale detail marker — the anchor is
      // `rate_limited_at`, and a leftover marker would resurface as
      // the wrong status if the page later flips to `error`.
      targetDestinationFbStatus = null;
    }
    // `active` is not a side effect: the old outcome left the page
    // status untouched for active evaluations.
    if (targetDestinationStatus === 'active') {
      targetDestinationStatus = undefined;
    }

    let targetAccountStatus: DatabaseSocialAccountRow['status'] | undefined;
    // Classifier-only: expire the account only when the evaluation
    // says expired. (The legacy `isAuthError && (190 || 102)`
    // disjunct bypassed the classifier and expired the account for
    // 190/459, 190/464, 190/492 and 190/2069032, whose evaluations
    // keep the account active.)
    const isAccountExpired = evaluation?.accountStatus === 'expired';
    if (isAccountExpired) {
      targetAccountStatus = 'expired';
    }

    const isTransient = classified.kind === 'retryable';
    // Content codes 100 / 1609005 (media Facebook couldn't fetch, link
    // scraper failure) are permanent by classification, but the owner
    // overruled that: they retry ×2, then fail — media-fetch failures
    // are sometimes transient. The ×2 cap is independent of the tick's
    // outer 5 budget: retry while retryCount < 2, failed at 2. `kind`
    // stays the terminal classification; `status` carries the retry
    // disposition.
    const isContentRetryCode = code === 100 || code === 1609005;
    const canRetry =
      (isTransient && retryCount < effectiveMaxRetries) ||
      (isContentRetryCode && retryCount < 2);

    const detail =
      extracted.diagnostic !== undefined
        ? diagnosticToDetail(extracted.diagnostic)
        : undefined;

    let retryDelaySeconds: number | undefined;

    if (canRetry) {
      if (
        extracted.telemetry?.estimatedTimeToRegainAccessMinutes &&
        extracted.telemetry.estimatedTimeToRegainAccessMinutes > 0
      ) {
        retryDelaySeconds = extracted.telemetry.estimatedTimeToRegainAccessMinutes * 60;
      } else {
        retryDelaySeconds = Math.min(
          DISPATCH_RETRY_MAX_DELAY_SECONDS,
          DISPATCH_RETRY_BASE_DELAY_SECONDS * Math.pow(2, retryCount || 0)
        );
      }
    }

    return {
      status: canRetry ? 'retry' : 'failed',
      error: classified,
      // Full failure diagnostic (phase, HTTP status, raw body, both
      // upload attempts when both failed) — the consumer settles it into
      // `publish_logs.detail` via `p_detail`, so a body-less 400 is never
      // again stored with nothing but code `unknown` to go on.
      ...(detail !== undefined ? { detail } : {}),
      ...(retryDelaySeconds !== undefined ? { retryDelaySeconds } : {}),
      ...(targetDestinationStatus !== undefined ? { targetDestinationStatus } : {}),
      ...(targetDestinationFbStatus !== undefined ? { targetDestinationFbStatus } : {}),
      ...(targetAccountStatus !== undefined ? { targetAccountStatus } : {}),
    };
  }
}

/** Turns a client diagnostic into the outcome's `detail` record. */
function diagnosticToDetail(
  diagnostic: FacebookPublishDiagnostic
): Record<string, unknown> {
  return {
    phase: diagnostic.phase,
    ...(diagnostic.httpStatus !== undefined ? { httpStatus: diagnostic.httpStatus } : {}),
    ...(diagnostic.rawBody !== undefined ? { rawBody: diagnostic.rawBody } : {}),
    ...(diagnostic.attempts !== undefined ? { attempts: diagnostic.attempts } : {}),
  };
}
