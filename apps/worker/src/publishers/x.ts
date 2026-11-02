import {
  validateXPlatformOptions,
  validateXText,
  type ClassifiedPublishError,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type Platform,
  type Publisher,
  type PublisherTokenSet,
  type PublishOutcome,
  type RefreshedTokenSet,
} from '@fbuploadpro/contracts';
import { captureWorkerError, type PostHogEnv } from '../analytics.js';
import {
  XApiError,
  XClient,
  type IXClient,
  type XRateLimitInfo,
} from '../x-client.js';

// ==========================================
// X publisher (spec 127)
// ==========================================
//
// Publishes through OUR single global X app (D4/D7): per-user tokens
// issued to that app, app credentials from worker env only — never
// from `platform_credentials` (BYOC-only) and never persisted anywhere
// by this module. Media first, post second, in ONE consumer attempt
// (uploaded media expires within hours–24 h).
//
// This module NEVER refreshes tokens (D6): `publish` contains zero
// refresh calls; the separate token-refresh job owns X's rotating,
// single-use refresh tokens and calls `refreshTokens` below, which
// returns the FULL new token set for the job's one atomic persist.
//
// Settlement specifics:
//  - D10 duplicate-403: X has no idempotency key. A duplicate rejection
//    is verified against the account's timeline — a matching post
//    settles `published` with that post's id; no match settles
//    `failed` with the rejection surfaced. A blind re-post is NEVER
//    attempted, and copy is never mutated to evade detection.
//  - 402 credits-exhausted is PLATFORM-WIDE (our one app, D4): a
//    distinct error code, a platform-level PostHog exception, a long
//    deferral, and NO account expiry. See `creditsExhaustedOutcome`
//    for the exact deferral rule (settles `deferred`; no retry budget
//    is consumed).
//  - `x-rate-limit-*` headers are metered as `rateUsagePct` only.
//    Migration 20261102160000 removed the destination-wide cooldown
//    they used to feed: a 429's reset time now only sets this item's
//    own retry delay (mapping in `rateLimitOutcomeParts`), never a
//    destination gate.

export const X_PLATFORM: Platform = 'x';

/** Distinct settle/log code for the platform-wide 402 state. */
export const X_CREDITS_EXHAUSTED_CODE = 'x_platform_credits_exhausted';

/** Deferral applied to every X item while the platform balance is empty. */
export const X_CREDITS_EXHAUSTED_DELAY_SECONDS = 3600;

/** Backoff for transient X failures (mirrors the Facebook publisher's shape). */
const X_RETRY_BASE_DELAY_SECONDS = 300;
const X_RETRY_MAX_DELAY_SECONDS = 3600;

export interface XPublisherOptions {
  /** Global-app client ID (worker env X_CLIENT_ID). Absent → refresh fails auth-class, publish unaffected. */
  clientId?: string | undefined;
  /** Global-app client secret (worker env X_CLIENT_SECRET). */
  clientSecret?: string | undefined;
  /** PostHog env for the platform-level 402 exception (analytics.ts seam). */
  env?: PostHogEnv | undefined;
  now?: (() => Date) | undefined;
}

interface ExtractedXError {
  status: number | undefined;
  code: string;
  message: string;
  isAuth: boolean;
  isDuplicate: boolean;
  isCreditsExhausted: boolean;
  isRateLimit: boolean;
  rateLimit: XRateLimitInfo | undefined;
}

function extractError(err: unknown): ExtractedXError {
  if (err instanceof XApiError) {
    const haystack = `${err.title ?? ''} ${err.detail ?? ''} ${err.message}`.toLowerCase();
    return {
      status: err.status,
      code: err.errorCode ?? String(err.status),
      message: err.message,
      isAuth: err.status === 401 || err.errorCode === 'invalid_grant',
      isDuplicate: err.isDuplicateContent(),
      isCreditsExhausted: err.status === 402,
      isRateLimit: err.status === 429 || haystack.includes('rate limit'),
      rateLimit: err.rateLimit,
    };
  }
  const record = (err ?? {}) as Record<string, unknown>;
  const status = typeof record.status === 'number' ? record.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof record.error === 'string'
      ? record.error
      : typeof record.code === 'string'
        ? record.code
        : status !== undefined
          ? String(status)
          : 'unknown';
  return {
    status,
    code,
    message,
    isAuth: status === 401 || code === 'invalid_grant' || message.includes('invalid_grant'),
    isDuplicate: status === 403 && message.toLowerCase().includes('duplicate'),
    isCreditsExhausted: status === 402,
    isRateLimit: status === 429,
    rateLimit: undefined,
  };
}

function classifyExtracted(extracted: ExtractedXError): ClassifiedPublishError {
  if (extracted.isCreditsExhausted) {
    return { kind: 'retryable', code: X_CREDITS_EXHAUSTED_CODE, message: extracted.message };
  }
  if (extracted.isDuplicate) {
    return { kind: 'permanent', code: 'duplicate_content', message: extracted.message };
  }
  if (extracted.isAuth) {
    return { kind: 'auth', code: extracted.code, message: extracted.message };
  }
  if (extracted.isRateLimit) {
    return { kind: 'retryable', code: extracted.code, message: extracted.message };
  }
  if (extracted.status !== undefined && extracted.status >= 400 && extracted.status < 500) {
    return { kind: 'permanent', code: extracted.code, message: extracted.message };
  }
  return { kind: 'retryable', code: extracted.code, message: extracted.message };
}

type XMediaKind = 'image' | 'gif' | 'video';

function resolveMedia(item: DatabaseUnifiedQueueItemRow): {
  kind: XMediaKind;
  mediaType: string;
  mediaCategory: string;
} {
  const url = (item.media_url ?? '').split('?')[0]?.toLowerCase() ?? '';
  const format = item.platform_format?.trim().toLowerCase() ?? '';
  if (format === 'gif' || url.endsWith('.gif')) {
    return { kind: 'gif', mediaType: 'image/gif', mediaCategory: 'tweet_gif' };
  }
  if (/\.(mov|webm)$/.test(url)) {
    // v1 enforces the conservative official spec (MP4 only, spec 127
    // Scope.3) — never mislabel another container as video/mp4.
    throw new XApiError(400, {
      error: 'unsupported_video_format',
      detail: 'Only MP4 videos can be posted to X — this file is not an MP4 video.',
    });
  }
  if (item.kind === 'video' || format === 'video' || url.endsWith('.mp4')) {
    return { kind: 'video', mediaType: 'video/mp4', mediaCategory: 'tweet_video' };
  }
  const mediaType = url.endsWith('.png')
    ? 'image/png'
    : url.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg';
  return { kind: 'image', mediaType, mediaCategory: 'tweet_image' };
}

export class XPublisher implements Publisher {
  readonly platform: Platform = X_PLATFORM;
  private readonly client: IXClient;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly env: PostHogEnv;
  private readonly now: () => Date;

  constructor(client: IXClient = new XClient(), options?: XPublisherOptions) {
    this.client = client;
    this.clientId = options?.clientId;
    this.clientSecret = options?.clientSecret;
    this.env = options?.env ?? {};
    this.now = options?.now ?? (() => new Date());
  }

  /** Classifies any error thrown by the X client. Pure and total: never throws. */
  mapError(err: unknown): ClassifiedPublishError {
    return classifyExtracted(extractError(err));
  }

  /**
   * X token refresh (D6) — called ONLY by the token-refresh job.
   * Rotating, single-use refresh tokens: spends the stored refresh
   * token once at the token endpoint (Basic auth with the global app's
   * env credentials) and returns the FULL new set for the job's atomic
   * persist. Absent app credentials fail auth-class
   * (`x_credentials_not_configured`) — a clean, classifiable failure,
   * never a silent pass-through of the spent token set.
   */
  async refreshTokens(
    _account: DatabaseSocialAccountRow,
    tokens: PublisherTokenSet
  ): Promise<RefreshedTokenSet> {
    if (!this.clientId || !this.clientSecret) {
      throw new XApiError(401, {
        error: 'x_credentials_not_configured',
        detail:
          'The X app details are not configured on the worker, so this connection cannot be refreshed.',
      });
    }
    if (!tokens.refreshToken) {
      throw new XApiError(401, {
        error: 'invalid_grant',
        detail: 'No refresh token is stored for this X connection.',
      });
    }
    const refreshed = await this.client.refreshAccessToken({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: tokens.refreshToken,
    });
    if (!refreshed.refreshToken) {
      // X refresh tokens are rotating and single-use: the stored token
      // was spent by this call. If the endpoint returned no replacement,
      // there is nothing safe to persist — fail auth-class so the
      // account goes `expired` (reconnect) instead of storing a spent
      // token that would look alive and fail forever.
      throw new XApiError(401, {
        error: 'invalid_grant',
        detail:
          'X did not return a new refresh token, so this connection cannot be refreshed safely.',
      });
    }
    const expiresAt =
      refreshed.expiresIn !== undefined
        ? new Date(this.now().getTime() + refreshed.expiresIn * 1000).toISOString()
        : (tokens.tokenExpiresAt ?? null);
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      tokenExpiresAt: expiresAt,
    };
  }

  async publish(
    item: DatabaseUnifiedQueueItemRow,
    destination: DatabaseDestinationRow,
    tokens: PublisherTokenSet
  ): Promise<PublishOutcome> {
    const accessToken = tokens.accessToken;
    if (!accessToken) {
      return {
        status: 'failed',
        error: {
          kind: 'auth',
          code: 'missing_access_token',
          message: 'The X connection for this account is missing its access token.',
        },
        targetAccountStatus: 'expired',
      };
    }

    const hasMedia = Boolean(item.media_url);
    const optionsResult = validateXPlatformOptions(item.platform_options, { hasMedia });
    if (!optionsResult.valid || !optionsResult.options) {
      return {
        status: 'failed',
        error: {
          kind: 'permanent',
          code: 'invalid_platform_options',
          message: optionsResult.error ?? 'The post options are not valid for X.',
        },
      };
    }
    const options = optionsResult.options;

    // The link (when present) rides in the text — X has no link field —
    // and is weighted at 23 like any URL by the contracts validator.
    const text = item.link_url
      ? `${item.caption} ${item.link_url}`.trim()
      : item.caption;
    const textCheck = validateXText(text);
    if (!textCheck.valid) {
      return {
        status: 'failed',
        error: {
          kind: 'permanent',
          code: 'text_too_long',
          message: `This post is ${textCheck.weightedLength} characters on X, over the 280 limit.`,
        },
      };
    }
    if (!text && !hasMedia && !options.poll) {
      return {
        status: 'failed',
        error: {
          kind: 'permanent',
          code: 'empty_post',
          message: 'A post needs text, media, or a poll.',
        },
      };
    }

    try {
      // Media first, post second — one attempt (uploaded media expires).
      const mediaIds: string[] = [];
      let lastRateLimit: XRateLimitInfo | undefined;
      if (item.media_url) {
        const media = resolveMedia(item);
        const uploaded = await this.client.uploadMediaChunked(accessToken, {
          sourceUrl: item.media_url,
          mediaType: media.mediaType,
          mediaCategory: media.mediaCategory,
        });
        mediaIds.push(uploaded.mediaId);
        lastRateLimit = uploaded.rateLimit ?? lastRateLimit;
        if (options.altText) {
          try {
            await this.client.setMediaMetadata(accessToken, uploaded.mediaId, options.altText);
          } catch (altErr) {
            // Alt text is descriptive metadata: the post still goes out,
            // and the miss is visible in the outcome detail/logs.
            console.warn(
              `[XPublisher] alt text failed for media ${uploaded.mediaId} (queue item ${item.id}):`,
              altErr
            );
          }
        }
      }

      const created = await this.client.createTweet(accessToken, {
        text,
        ...(mediaIds.length > 0 ? { mediaIds } : {}),
        ...(options.poll
          ? {
              poll: {
                options: options.poll.options,
                durationMinutes: options.poll.durationMinutes,
              },
            }
          : {}),
        ...(options.quoteTweetId ? { quoteTweetId: options.quoteTweetId } : {}),
        ...(options.replySettings ? { replySettings: options.replySettings } : {}),
      });
      lastRateLimit = created.rateLimit ?? lastRateLimit;

      return {
        status: 'published',
        externalPostId: created.id,
        detail: { mediaIds, tweetId: created.id },
        ...this.rateLimitOutcomeParts(lastRateLimit),
      };
    } catch (err: unknown) {
      return this.failureOutcome(err, item, destination, accessToken, text);
    }
  }

  /**
   * Rate-limit header mapping (spec 127 Scope.6, as amended by
   * migration 20261102160000). Whenever X reports headers,
   * `rateUsagePct` is the used share of the window
   * ((limit − remaining) / limit × 100); when the window is
   * EXHAUSTED (remaining = 0 with a future reset), the reset time
   * is returned as this item's own retry delay only — it never
   * gates the destination. Partial headroom never invents a delay
   * the platform did not report.
   */
  private rateLimitOutcomeParts(rateLimit: XRateLimitInfo | undefined): {
    rateUsagePct?: number;
    resetDelaySeconds?: number;
  } {
    if (!rateLimit) return {};
    const parts: { rateUsagePct?: number; resetDelaySeconds?: number } = {};
    if (
      rateLimit.limit !== undefined &&
      rateLimit.limit > 0 &&
      rateLimit.remaining !== undefined
    ) {
      parts.rateUsagePct = Math.round(
        ((rateLimit.limit - rateLimit.remaining) / rateLimit.limit) * 100
      );
    }
    if (rateLimit.remaining === 0 && rateLimit.resetEpochSeconds !== undefined) {
      const nowSeconds = Math.floor(this.now().getTime() / 1000);
      const delay = rateLimit.resetEpochSeconds - nowSeconds;
      if (delay > 0) parts.resetDelaySeconds = delay;
    }
    return parts;
  }

  /**
   * The platform-wide 402 outcome (spec 127 Scope.5), settled via the
   * `deferred` outcome (spec 139 defer outcome, Shahzeb 2026-10-24):
   * a 402 returns `deferred` with the distinct code
   * `x_platform_credits_exhausted` and a one-hour deferral delay, no
   * account-status side effect (accounts never expire over our
   * balance), plus a platform-level PostHog exception. The settle
   * RPC's deferred branch does not write retry_count, so an item
   * paused by an empty shared balance consumes NO retry budget while
   * it waits — the vocabulary tension this path originally flagged
   * is resolved. There is no destination cooldown: the one-hour
   * value is this item's deferral delay only.
   */
  private creditsExhaustedOutcome(extracted: ExtractedXError): PublishOutcome {
    captureWorkerError(
      this.env,
      new XApiError(402, { detail: extracted.message }),
      { site: 'XPublisher', kind: 'platform_credits_exhausted', platform: 'x' }
    );
    console.error(
      '[XPublisher] X platform credits exhausted (402): every X post is paused until the shared balance is topped up (auto-recharge must be on).'
    );
    return {
      status: 'deferred',
      error: {
        kind: 'retryable',
        code: X_CREDITS_EXHAUSTED_CODE,
        message:
          'Posting to X is paused because the shared X balance is empty. Posts will go out once the balance is topped up.',
      },
      retryDelaySeconds: X_CREDITS_EXHAUSTED_DELAY_SECONDS,
      detail: { platformWide: true, reason: 'credits_exhausted' },
    };
  }

  /**
   * D10 (DECIDED — verify-then-published): on a duplicate rejection,
   * read the account's timeline; a post whose text matches this item's
   * text settles `published` with that post's id. No match settles
   * `failed` with the rejection surfaced. This path NEVER re-posts.
   */
  private async duplicateOutcome(
    extracted: ExtractedXError,
    destination: DatabaseDestinationRow,
    accessToken: string,
    text: string
  ): Promise<PublishOutcome> {
    const classified = classifyExtracted(extracted);
    try {
      const timeline = await this.client.getUserTimeline(
        accessToken,
        destination.external_destination_id
      );
      const match = timeline.tweets.find((tweet) => tweet.text.trim() === text.trim());
      if (match) {
        return {
          status: 'published',
          externalPostId: match.id,
          detail: { tweetId: match.id, duplicateVerified: true },
          ...this.rateLimitOutcomeParts(timeline.rateLimit),
        };
      }
    } catch (timelineErr) {
      console.error(
        '[XPublisher] timeline verification after a duplicate rejection failed:',
        timelineErr
      );
      return {
        status: 'failed',
        error: {
          kind: 'permanent',
          code: 'duplicate_unverified',
          message: `X rejected this post as a duplicate and the earlier post could not be confirmed: ${extracted.message}`,
        },
      };
    }
    return { status: 'failed', error: classified };
  }

  private async failureOutcome(
    err: unknown,
    item: DatabaseUnifiedQueueItemRow,
    destination: DatabaseDestinationRow,
    accessToken: string,
    text: string
  ): Promise<PublishOutcome> {
    const extracted = extractError(err);

    if (extracted.isCreditsExhausted) {
      return this.creditsExhaustedOutcome(extracted);
    }
    if (extracted.isDuplicate) {
      return this.duplicateOutcome(extracted, destination, accessToken, text);
    }

    const classified = classifyExtracted(extracted);

    if (classified.kind === 'auth') {
      return {
        status: 'failed',
        error: classified,
        targetAccountStatus: 'expired',
      };
    }

    if (classified.kind === 'retryable') {
      const canRetry = item.retry_count < (item.max_retries ?? 3);
      // A 429's reset header, when reported, is the honest delay for
      // THIS item's retry. It never gates the destination: the
      // destination-wide cooldown was removed by migration
      // 20261102160000.
      let retryDelaySeconds: number | undefined;
      const parts = this.rateLimitOutcomeParts(extracted.rateLimit);
      if (extracted.isRateLimit && parts.resetDelaySeconds !== undefined) {
        retryDelaySeconds = parts.resetDelaySeconds;
      } else if (canRetry) {
        retryDelaySeconds = Math.min(
          X_RETRY_MAX_DELAY_SECONDS,
          X_RETRY_BASE_DELAY_SECONDS * Math.pow(2, item.retry_count || 0)
        );
      }
      return {
        status: canRetry ? 'retry' : 'failed',
        error: classified,
        ...(canRetry && retryDelaySeconds !== undefined ? { retryDelaySeconds } : {}),
        ...(parts.rateUsagePct !== undefined ? { rateUsagePct: parts.rateUsagePct } : {}),
      };
    }

    return { status: 'failed', error: classified };
  }
}
