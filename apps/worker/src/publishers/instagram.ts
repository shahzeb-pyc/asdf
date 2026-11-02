import {
  INSTAGRAM_UNIFIED_GRAPH_BASE_URL,
  InstagramPlatformOptionsSchema,
  resolvePublishLimit,
  validateInstagramCaption,
  type ClassifiedPublishError,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type InstagramCarouselItem,
  type InstagramPlatformOptions,
  type Platform,
  type Publisher,
  type PublisherTokenSet,
  type PublishLimitOverride,
  type PublishOutcome,
  type RefreshedTokenSet,
  ValidationError,
} from '@fbuploadpro/contracts';
import {
  InstagramGraphError,
  InstagramPublishClient,
  type IInstagramPublishClient,
} from '../instagram-client.js';

// ==========================================
// Instagram publisher (spec 124 — Instagram-Login route only, D2)
// ==========================================
//
// Container flow against `graph.instagram.com`: create the container at
// publish time (containers expire after 24 h — never at schedule
// time), poll `status_code` about once a minute until FINISHED, then
// publish. The container id rides in every outcome's `detail` from the
// first attempt, so settlement persists it in `publish_logs.detail`
// and a retry can re-check instead of restarting blind.
//
// No idempotency key exists on this API: when `media_publish` fails
// ambiguously (timeout / 5xx / network), the publisher re-reads the
// container status before returning, and a `PUBLISHED` status settles
// the item published WITHOUT a second publish call — never a
// double-post (the D10 settlement discipline).
//
// Quota (D5): the live per-destination quota is read from
// `content_publishing_limit` (Meta meters it per account; one account
// per destination) on every publish and fed through the
// contracts destination-override seam (`resolvePublishLimit`). No
// quota number is hardcoded in this module — Meta's own docs disagree
// with each other about the cap, so only the live read is trusted.
//
// Tokens (D6): this module NEVER refreshes inside `publish()`. The
// `refreshTokens` implementation below exists solely for the spec 121
// refresh job. Error 190 anywhere classifies as `auth`, which settles
// the account `expired` for reconnect — never a publish retry.

export const INSTAGRAM_PLATFORM: Platform = 'instagram';

/** Container polling cadence: ~1 check per minute, up to 5 minutes. */
export const INSTAGRAM_CONTAINER_POLL_INTERVAL_MS = 60_000;
export const INSTAGRAM_CONTAINER_MAX_POLLS = 5;

/** Follow-up first-comment attempts (Facebook settle pattern). */
const FIRST_COMMENT_MAX_ATTEMPTS = 3;
const FIRST_COMMENT_RETRY_DELAY_MS = 500;

/** Retry backoff for transient publish failures. */
const RETRY_BASE_DELAY_SECONDS = 300;
const RETRY_MAX_DELAY_SECONDS = 3600;

export interface InstagramPublisherOptions {
  pollIntervalMs?: number | undefined;
  maxPolls?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Client for BISU (Unified Login) destinations, on
   * graph.facebook.com. Injected for tests; defaults to a real client
   * on the Unified host.
   */
  bisuClient?: IInstagramPublishClient | undefined;
  /**
   * Internal delegation guard: when set, publish() uses this client
   * directly instead of selecting one by destination. Never set by
   * callers — publish() sets it on the one-shot delegate it creates
   * for a BISU destination, so the delegate cannot delegate again.
   */
  fixedClient?: IInstagramPublishClient | undefined;
}

/**
 * A destination connected through Unified Login carries
 * metadata.token_kind === 'bisu' (set by the web callback). Old
 * Instagram Login destinations carry no token_kind and keep the
 * graph.instagram.com path. Unknown metadata never guesses BISU.
 */
export function isBisuDestination(destination: DatabaseDestinationRow): boolean {
  const metadata = destination.metadata as Record<string, unknown> | null | undefined;
  return metadata?.token_kind === 'bisu';
}

function isBisuAccount(account: DatabaseSocialAccountRow): boolean {
  const metadata = account.metadata as Record<string, unknown> | null | undefined;
  return metadata?.token_kind === 'bisu';
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExtractedError {
  code: number | undefined;
  subcode: number | undefined;
  message: string;
  httpStatus: number | undefined;
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractError(err: unknown): ExtractedError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof InstagramGraphError) {
    return {
      code: err.code,
      subcode: err.errorSubcode,
      message,
      httpStatus: err.httpStatus,
    };
  }
  const record = (err ?? {}) as Record<string, unknown>;
  return {
    code: numericField(record.code),
    subcode:
      numericField(record.error_subcode) ??
      numericField(record.errorSubcode) ??
      numericField(record.subcode),
    message,
    httpStatus: numericField(record.httpStatus) ?? numericField(record.status),
  };
}

function isRateLimitCode(code: number | undefined): boolean {
  return (
    code === 4 || code === 17 || code === 32 || code === 341 || code === 613 ||
    (code !== undefined && code >= 80000 && code <= 80014)
  );
}

/**
 * Classifies an Instagram failure into the shared taxonomy:
 *   auth      — error 190 (invalid/expired token) or 102/10/2xx
 *               permission failures: reconnect required, never retried;
 *   retryable — rate limits, 5xx, and unknown transport failures;
 *   permanent — everything else with a definitive API answer.
 */
export function classifyInstagramError(err: unknown): ClassifiedPublishError {
  const { code, subcode, message, httpStatus } = extractError(err);

  // Our own pre-flight validation (missing media, bad carousel, …) is a
  // definitive content problem — permanent, never retried. ValidationError
  // carries a string code that extractError cannot read as a number, so
  // it must be recognised before the numeric branches, or it falls into
  // the code-undefined retryable branch by mistake.
  if (err instanceof ValidationError) {
    return { kind: 'permanent', code: 'validation', message };
  }
  if (code === 190 || code === 102 || code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return {
      kind: 'auth',
      code: code !== undefined ? String(code) : 'auth',
      ...(subcode !== undefined ? { subcode: String(subcode) } : {}),
      message:
        code === 190
          ? 'Your Instagram connection has expired. Reconnect the account to keep posting.'
          : message,
    };
  }
  if (isRateLimitCode(code)) {
    return {
      kind: 'retryable',
      code: String(code),
      ...(subcode !== undefined ? { subcode: String(subcode) } : {}),
      message,
      retryDelaySeconds: RETRY_BASE_DELAY_SECONDS,
    };
  }
  if (
    (httpStatus !== undefined && httpStatus >= 500) ||
    code === undefined
  ) {
    return {
      kind: 'retryable',
      code: code !== undefined ? String(code) : 'unknown',
      ...(subcode !== undefined ? { subcode: String(subcode) } : {}),
      message,
    };
  }
  return {
    kind: 'permanent',
    code: String(code),
    ...(subcode !== undefined ? { subcode: String(subcode) } : {}),
    message,
  };
}

/** The destination's account type, from destination metadata. */
function destinationAccountType(
  destination: DatabaseDestinationRow
): string | null {
  const raw =
    destination.metadata?.account_type ??
    destination.metadata?.accountType ??
    null;
  return typeof raw === 'string' ? raw : null;
}

function retryDelay(retryCount: number): number {
  return Math.min(
    RETRY_MAX_DELAY_SECONDS,
    RETRY_BASE_DELAY_SECONDS * Math.pow(2, retryCount || 0)
  );
}

export class InstagramPublisher implements Publisher {
  readonly platform: Platform = INSTAGRAM_PLATFORM;
  private readonly client: IInstagramPublishClient;
  private readonly bisuClient: IInstagramPublishClient;
  private readonly publisherOptions: InstagramPublisherOptions | undefined;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    client: IInstagramPublishClient = new InstagramPublishClient(),
    options?: InstagramPublisherOptions
  ) {
    this.client = client;
    this.bisuClient =
      options?.bisuClient ??
      new InstagramPublishClient({ baseUrl: INSTAGRAM_UNIFIED_GRAPH_BASE_URL });
    this.publisherOptions = options;
    this.pollIntervalMs =
      options?.pollIntervalMs ?? INSTAGRAM_CONTAINER_POLL_INTERVAL_MS;
    this.maxPolls = options?.maxPolls ?? INSTAGRAM_CONTAINER_MAX_POLLS;
    this.sleep = options?.sleep ?? sleepMs;
  }

  mapError(err: unknown): ClassifiedPublishError {
    return classifyInstagramError(err);
  }

  /**
   * Called ONLY by the spec 121 refresh job (D6) — the single owner of
   * token rotation. Refreshes the 60-day long-lived token in place
   * (the token must be at least 24 h old and unexpired; that due-ness
   * gate is the job's, via the contracts thresholds).
   */
  async refreshTokens(
    account: DatabaseSocialAccountRow,
    tokens: PublisherTokenSet
  ): Promise<RefreshedTokenSet> {
    // BISU tokens are configuration-expiry (default never expiring)
    // and the token-management API needs business_management, which
    // the locked publish-only set deliberately does not request.
    // Reconnect-only recovery: a dead BISU token is never refreshed
    // here — Meta's own instruction is to ask the client to connect
    // again, and error 190 elsewhere settles the account expired.
    if (isBisuAccount(account)) {
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        tokenExpiresAt: tokens.tokenExpiresAt ?? null,
      };
    }
    const refreshed = await this.client.refreshLongLivedToken({
      accessToken: tokens.accessToken,
    });
    return {
      accessToken: refreshed.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      tokenExpiresAt:
        refreshed.expiresIn !== undefined
          ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
          : (tokens.tokenExpiresAt ?? null),
    };
  }

  async publish(
    item: DatabaseUnifiedQueueItemRow,
    destination: DatabaseDestinationRow,
    tokens: PublisherTokenSet
  ): Promise<PublishOutcome> {
    // BISU destinations publish on graph.facebook.com, not
    // graph.instagram.com, but the container/status/publish/comment
    // call shapes are identical. The singleton publisher cannot
    // mutate its client per destination (concurrent publishes would
    // race), so a BISU destination delegates once to a one-shot
    // publisher bound to the BISU client; that delegate's fixedClient
    // guard stops it delegating again. Old destinations never enter
    // this branch and keep the existing client untouched.
    if (!this.publisherOptions?.fixedClient && isBisuDestination(destination)) {
      const delegate = new InstagramPublisher(this.bisuClient, {
        ...this.publisherOptions,
        bisuClient: this.bisuClient,
        fixedClient: this.bisuClient,
      });
      return delegate.publish(item, destination, tokens);
    }
    const igUserId = destination.external_destination_id;
    const accessToken = tokens.accessToken;
    if (!accessToken) {
      return {
        status: 'failed',
        error: {
          kind: 'permanent',
          code: 'missing_access_token',
          message:
            'We could not read the saved sign-in for this Instagram account. Reconnect the account and try again.',
        },
        detail: { platform: 'instagram' },
      };
    }

    // ---- Pre-claim validation surfaces (contracts schemas) ----
    const captionError = validateInstagramCaption(item.caption ?? '');
    if (captionError) return this.validationFailure(captionError);

    const optionsParse = InstagramPlatformOptionsSchema.safeParse(
      item.platform_options ?? {}
    );
    if (!optionsParse.success) {
      const first = optionsParse.error.issues[0];
      return this.validationFailure(
        `This post's Instagram settings need a fix: ${first ? `${first.path.join('.')} — ${first.message}` : 'invalid settings'}. Update the post and try again.`
      );
    }
    const options = optionsParse.data;

    const isStory =
      item.kind === 'story' || item.platform_format?.toLowerCase() === 'story' ||
      item.platform_format?.toLowerCase() === 'stories';

    // ---- Business-only story guard ----
    if (isStory) {
      const accountType = destinationAccountType(destination);
      if (accountType !== null && accountType.toUpperCase() !== 'BUSINESS') {
        return {
          status: 'failed',
          error: {
            kind: 'permanent',
            code: 'story_requires_business_account',
            message:
              'Instagram only lets Business accounts post stories this way. This account is a Creator account, so this story cannot be posted — switch the account to Business on Instagram, or post it as a regular post instead.',
          },
          detail: { platform: 'instagram', accountType },
        };
      }
    }

    // ---- Live quota read (D5) — best effort, never blocks the post ----
    const liveLimit = await this.readLiveLimit(igUserId, accessToken);

    // At the platform-reported cap the post DEFERS (D5) — the live
    // total overrides the claim-side default, and publishing into a
    // certain rejection would fail the post instead of pausing it.
    const limitOutcome = this.publishingLimitOutcome(liveLimit);
    if (limitOutcome) return limitOutcome;

    // ---- Container flow ----
    let containerId: string;
    try {
      containerId = await this.createContainerForItem(
        item,
        options,
        igUserId,
        accessToken,
        isStory
      );
    } catch (err) {
      return this.failureOutcome(err, item, undefined, liveLimit);
    }
    const detail: Record<string, unknown> = {
      platform: 'instagram',
      containerId,
      ...(liveLimit.detail ? { publishingLimit: liveLimit.detail } : {}),
    };

    // ---- Poll until FINISHED (PUBLISHED = already live, stop) ----
    const poll = await this.pollUntilFinished(containerId, accessToken);
    if (poll === 'published') {
      // Already live (e.g. a previous attempt published it) — settle
      // published with the container id as the best known reference,
      // and never publish again.
      return { status: 'published', externalPostId: containerId, detail };
    }
    if (poll !== 'finished') {
      return {
        status: poll === 'retry' ? 'retry' : 'failed',
        error:
          poll === 'retry'
            ? {
                kind: 'retryable',
                code: 'container_still_processing',
                message:
                  'Instagram is still preparing this post. It will be tried again shortly.',
              }
            : {
                kind: 'permanent',
                code: 'container_not_publishable',
                message:
                  'Instagram could not prepare this post. Check the media and try again.',
              },
        ...(poll === 'retry'
          ? { retryDelaySeconds: retryDelay(item.retry_count) }
          : {}),
        detail,
      };
    }

    // ---- Publish ----
    let mediaId: string;
    try {
      const published = await this.client.publishContainer({
        igUserId,
        accessToken,
        containerId,
      });
      mediaId = published.mediaId;
    } catch (err) {
      // Ambiguous failure discipline: re-check the container before
      // deciding — PUBLISHED means the post is live despite the error.
      const recheck = await this.pollOnce(containerId, accessToken);
      if (recheck === 'PUBLISHED') {
        return { status: 'published', externalPostId: containerId, detail };
      }
      return this.failureOutcome(err, item, detail, liveLimit);
    }
    detail.mediaId = mediaId;

    // ---- First comment: follow-up step, never fails the post ----
    let externalCommentId: string | undefined;
    let commentWarning: string | undefined;
    if (!isStory && item.first_comment && item.first_comment.trim().length > 0) {
      const comment = await this.postFirstCommentWithRetry(
        mediaId,
        accessToken,
        item.first_comment.trim(),
        item.id
      );
      externalCommentId = comment.commentId ?? undefined;
      commentWarning = comment.warning ?? undefined;
    }

    return {
      status: 'published',
      externalPostId: mediaId,
      ...(externalCommentId !== undefined ? { externalCommentId } : {}),
      ...(commentWarning ? { commentWarning } : {}),
      detail,
    };
  }

  // ------------------------------------------

  private validationFailure(message: string): PublishOutcome {
    return {
      status: 'failed',
      error: { kind: 'permanent', code: 'validation', message },
      detail: { platform: 'instagram' },
    };
  }

  /**
   * Reads the live per-destination quota and resolves it through the
   * contracts destination-override seam. Best effort: a failed read
   * never blocks a publish (the claim-side defaults still apply), and
   * an unreported total leaves the defaults untouched.
   */
  private async readLiveLimit(
    igUserId: string,
    accessToken: string
  ): Promise<{
    resolved: ReturnType<typeof resolvePublishLimit>;
    detail?: Record<string, unknown> | undefined;
  }> {
    try {
      const limit = await this.client.getContentPublishingLimit({
        igUserId,
        accessToken,
      });
      const override: PublishLimitOverride | undefined =
        limit.totalCount !== undefined
          ? {
              publishedPosts: {
                maxCount: limit.totalCount,
                windowSeconds: 24 * 3600,
              },
            }
          : undefined;
      return {
        resolved: resolvePublishLimit('instagram', override),
        detail: {
          ...(limit.usage !== undefined ? { usage: limit.usage } : {}),
          ...(limit.totalCount !== undefined
            ? { totalCount: limit.totalCount }
            : {}),
        },
      };
    } catch {
      return { resolved: resolvePublishLimit('instagram') };
    }
  }

  private async createContainerForItem(
    item: DatabaseUnifiedQueueItemRow,
    options: InstagramPlatformOptions,
    igUserId: string,
    accessToken: string,
    isStory: boolean
  ): Promise<string> {
    const kind = item.kind;
    const format = item.platform_format?.toLowerCase() ?? '';

    if (kind === 'carousel') {
      const items = this.carouselItems(item, options);
      const childIds: string[] = [];
      for (const child of items) {
        const childContainer = await this.client.createContainer({
          igUserId,
          accessToken,
          ...(child.mediaType === 'video'
            ? { mediaType: 'REELS' as const, videoUrl: child.mediaUrl }
            : { imageUrl: child.mediaUrl }),
          isCarouselItem: true,
        });
        childIds.push(childContainer.containerId);
        await this.waitForChild(childContainer.containerId, accessToken);
      }
      const parent = await this.client.createContainer({
        igUserId,
        accessToken,
        mediaType: 'CAROUSEL',
        children: childIds,
        caption: item.caption,
        ...(options.collaborators?.length
          ? { collaborators: [...options.collaborators] }
          : {}),
      });
      return parent.containerId;
    }

    if (isStory) {
      const isVideo = this.itemLooksLikeVideo(item);
      const container = await this.client.createContainer({
        igUserId,
        accessToken,
        mediaType: 'STORIES',
        ...(isVideo
          ? { videoUrl: this.requireMediaUrl(item) }
          : { imageUrl: this.requireMediaUrl(item) }),
      });
      return container.containerId;
    }

    if (kind === 'video' || format === 'reel' || format === 'reels') {
      const container = await this.client.createContainer({
        igUserId,
        accessToken,
        mediaType: 'REELS',
        videoUrl: this.requireMediaUrl(item),
        caption: item.caption,
        ...(options.shareToFeed !== undefined
          ? { shareToFeed: options.shareToFeed }
          : {}),
        ...(options.coverUrl ? { coverUrl: options.coverUrl } : {}),
        ...(options.collaborators?.length
          ? { collaborators: [...options.collaborators] }
          : {}),
        ...(options.trialParams
          ? { trialParams: { ...options.trialParams } }
          : {}),
      });
      return container.containerId;
    }

    // Single photo (image kind, or a media-bearing fallback).
    const container = await this.client.createContainer({
      igUserId,
      accessToken,
      imageUrl: this.requireMediaUrl(item),
      caption: item.caption,
      ...(options.collaborators?.length
        ? { collaborators: [...options.collaborators] }
        : {}),
    });
    return container.containerId;
  }

  private carouselItems(
    item: DatabaseUnifiedQueueItemRow,
    options: InstagramPlatformOptions
  ): InstagramCarouselItem[] {
    if (options.carouselItems?.length) return options.carouselItems;
    const raw = (item.platform_options as Record<string, unknown>)?.media_urls;
    if (Array.isArray(raw)) {
      const items = raw
        .filter((u): u is string => typeof u === 'string')
        .map((mediaUrl) => ({
          mediaUrl,
          mediaType: (/\.(?:mp4|mov)(?:\?|$)/i.test(mediaUrl)
            ? 'video'
            : 'image') as 'image' | 'video',
        }));
      if (items.length >= 2) return items;
    }
    throw new ValidationError(
      'A carousel post needs at least two photos or videos. Add the items and try again.'
    );
  }

  private itemLooksLikeVideo(item: DatabaseUnifiedQueueItemRow): boolean {
    if (item.kind === 'video') return true;
    const url = (item.media_url ?? '').split('?')[0]?.toLowerCase() ?? '';
    return /\.(?:mp4|mov)$/.test(url);
  }

  private requireMediaUrl(item: DatabaseUnifiedQueueItemRow): string {
    if (!item.media_url) {
      throw new ValidationError('This post is missing its photo or video. Add the media and try again.');
    }
    return item.media_url;
  }

  /** Polls one container read; returns the raw status or null on error. */
  private async pollOnce(
    containerId: string,
    accessToken: string
  ): Promise<string | null> {
    try {
      const status = await this.client.getContainerStatus({
        containerId,
        accessToken,
      });
      return status.statusCode;
    } catch {
      return null;
    }
  }

  /** Waits for a carousel child container to finish processing. */
  private async waitForChild(
    containerId: string,
    accessToken: string
  ): Promise<void> {
    for (let attempt = 0; attempt < this.maxPolls; attempt++) {
      const status = await this.client.getContainerStatus({
        containerId,
        accessToken,
      });
      if (status.statusCode === 'FINISHED' || status.statusCode === 'PUBLISHED') {
        return;
      }
      if (status.statusCode === 'ERROR' || status.statusCode === 'EXPIRED') {
        throw new ValidationError(
          'Instagram could not prepare one of the carousel items. Check the media and try again.'
        );
      }
      if (attempt < this.maxPolls - 1) await this.sleep(this.pollIntervalMs);
    }
  }

  private async pollUntilFinished(
    containerId: string,
    accessToken: string
  ): Promise<'finished' | 'published' | 'retry' | 'failed'> {
    for (let attempt = 0; attempt < this.maxPolls; attempt++) {
      let statusCode: string;
      try {
        const status = await this.client.getContainerStatus({
          containerId,
          accessToken,
        });
        statusCode = status.statusCode;
      } catch (err) {
        const classified = classifyInstagramError(err);
        return classified.kind === 'permanent' ? 'failed' : 'retry';
      }
      if (statusCode === 'FINISHED') return 'finished';
      if (statusCode === 'PUBLISHED') return 'published';
      if (statusCode === 'ERROR' || statusCode === 'EXPIRED') return 'failed';
      if (attempt < this.maxPolls - 1) await this.sleep(this.pollIntervalMs);
    }
    return 'retry';
  }

  private async postFirstCommentWithRetry(
    mediaId: string,
    accessToken: string,
    message: string,
    itemId: string
  ): Promise<{ commentId: string | null; warning: string | null }> {
    let attempt = 1;
    for (;;) {
      try {
        const res = await this.client.postComment({ mediaId, accessToken, message });
        return { commentId: res.commentId, warning: null };
      } catch (err) {
        if (attempt >= FIRST_COMMENT_MAX_ATTEMPTS) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[InstagramPublisher] First comment failed for queue item ${itemId} (media ${mediaId}):`,
            err
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
   * D5 live-cap enforcement: when the platform-reported usage reaches
   * the resolved cap (the live total overrides the claim-side default
   * through the destination-override seam), the post defers for an hour
   * instead of publishing into a certain rejection. Best effort — an
   * unreadable quota (no usage reported) never blocks a publish.
   * Settles via the `deferred` outcome (spec 139): the deferral does
   * NOT consume retry budget — hitting the cap is not the post's fault.
   */
  private publishingLimitOutcome(liveLimit: {
    resolved: ReturnType<typeof resolvePublishLimit>;
    detail?: Record<string, unknown> | undefined;
  }): PublishOutcome | null {
    const maxCount = liveLimit.resolved?.publishedPosts?.maxCount;
    const usage = liveLimit.detail?.usage;
    if (maxCount === undefined || typeof usage !== 'number' || usage < maxCount) {
      return null;
    }
    return {
      status: 'deferred',
      error: {
        kind: 'retryable',
        code: 'publishing_limit_reached',
        message:
          'This Instagram account has reached its publishing limit for now. The post will be tried again later.',
      },
      retryDelaySeconds: 3600,
      detail: {
        platform: 'instagram',
        ...(liveLimit.detail ? { publishingLimit: liveLimit.detail } : {}),
      },
    };
  }

  private failureOutcome(
    err: unknown,
    item: DatabaseUnifiedQueueItemRow,
    detail: Record<string, unknown> | undefined,
    liveLimit?: {
      resolved: ReturnType<typeof resolvePublishLimit>;
      detail?: Record<string, unknown> | undefined;
    }
  ): PublishOutcome {
    const classified = classifyInstagramError(err);
    const canRetry =
      classified.kind === 'retryable' && item.retry_count < (item.max_retries ?? 3);
    const delay =
      classified.retryDelaySeconds ?? retryDelay(item.retry_count);
    return {
      status: canRetry ? 'retry' : 'failed',
      error: classified,
      ...(canRetry ? { retryDelaySeconds: delay } : {}),
      ...(classified.kind === 'auth'
        ? { targetAccountStatus: 'expired' as const }
        : {}),
      detail: {
        ...(detail ?? { platform: 'instagram' }),
        ...(liveLimit?.detail ? { publishingLimit: liveLimit.detail } : {}),
      },
    };
  }
}
