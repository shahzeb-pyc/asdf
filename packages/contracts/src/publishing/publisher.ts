import { z } from 'zod';
import type {
  DatabaseDestinationRow,
  DatabaseSocialAccountRow,
  DatabaseUnifiedQueueItemRow,
  Platform,
} from '../domain/database.js';

// ==========================================
// Publisher contract (spec 121 Scope.1, spec 119 §6)
// ==========================================
//
// Every platform publisher module (Facebook spec 122, Instagram/Threads
// spec 124, YouTube spec 125, TikTok spec 126, X spec 127) implements this
// one interface and registers into the registry below. Consumers dispatch
// purely through the registry, so settlement stays platform-agnostic: a
// publisher reports outcomes in the unified vocabulary defined here and
// the consumer maps them onto the unified `settle_queue_item_outcome` RPC
// arguments (`SettleQueueItemOutcomeUnifiedArgs`) without knowing which
// platform produced them.
//
// Error taxonomy: `mapError` classifies any platform failure into the
// three kinds settlement understands, mirroring today's dispatcher
// evaluation shape (see `GraphApiErrorEvaluation` / `DispatchOutcome` in
// the legacy contracts):
//   - `retryable` — transient (rate limit, 5xx, network): settle `retry`.
//   - `permanent` — the post can never succeed as-is: settle `failed`.
//   - `auth`      — token invalid/expired/revoked: settle `failed` and
//                   cascade the account to `expired` via the outcome's
//                   `targetAccountStatus`. Consumers never refresh tokens
//                   on an auth error (spec 121 D6) — the separate token
//                   refresh job is the sole owner of token rotation.

export type PublishErrorKind = 'retryable' | 'permanent' | 'auth';

export const PublishErrorKindSchema = z.enum(['retryable', 'permanent', 'auth']);

/**
 * Platform-agnostic classification of a publish failure. `code`/`subcode`
 * are strings because unified-schema error codes are TEXT (not every
 * platform's codes are numeric — see the spec 120 settle RPC).
 */
export const ClassifiedPublishErrorSchema = z.object({
  kind: PublishErrorKindSchema,
  code: z.string(),
  subcode: z.string().optional(),
  message: z.string(),
  /** Publisher-supplied backoff hint for retryable errors, in seconds. */
  retryDelaySeconds: z.number().nonnegative().optional(),
});

export type ClassifiedPublishError = z.infer<typeof ClassifiedPublishErrorSchema>;

/**
 * Decrypted tokens a publisher may use for one publish/refresh call.
 * Consumers and the refresh job decrypt the stored ciphertext (from
 * `social_accounts` / `destinations`) before calling; publishers never
 * see ciphertext and never persist tokens themselves.
 */
export interface PublisherTokenSet {
  /** Decrypted `social_accounts.encrypted_access_token`. */
  accessToken: string;
  /** Decrypted `social_accounts.encrypted_refresh_token`, when issued. */
  refreshToken?: string | null | undefined;
  /**
   * Decrypted `destinations.encrypted_destination_token`. Facebook Page
   * tokens live here; unused (null) on every other platform.
   */
  destinationToken?: string | null | undefined;
  /** ISO timestamp of access-token expiry, when the platform reports one. */
  tokenExpiresAt?: string | null | undefined;
}

/**
 * Result of a successful token refresh. The refresh job persists this as
 * one atomic update to `social_accounts` before any API call uses the new
 * tokens (spec 121 Scope.9) — critical for X, whose refresh tokens are
 * single-use and rotating.
 */
export interface RefreshedTokenSet {
  accessToken: string;
  /** New refresh token when the platform rotated it (X); otherwise the existing one or null. */
  refreshToken?: string | null | undefined;
  /** ISO timestamp of the new access token's expiry, when known. */
  tokenExpiresAt?: string | null | undefined;
}

/**
 * The outcome of one publish attempt, in the unified settlement
 * vocabulary. Mirrors `SettleQueueItemOutcomeUnifiedArgs` field-for-field
 * (plus `detail`) so a consumer can settle without platform knowledge:
 *   - `published` → RPC outcome `published`
 *   - `retry`     → RPC outcome `queued` (retry), error from `error`;
 *                   the item's retry_count ADVANCES (a real attempt failed)
 *   - `failed`    → RPC outcome `failed`, error from `error`
 *   - `deferred`  → RPC outcome `deferred`, error from `error` (the
 *                   deferral's reason); the item returns to `queued`
 *                   after `retryDelaySeconds` and its retry_count is
 *                   left UNCHANGED — a deferral is not the item's fault
 *                   (platform cap reached, platform-wide pause such as
 *                   X's 402), so it must never consume retry budget
 *                   (spec 139 defer outcome, Shahzeb 2026-10-24).
 */
export const PublishOutcomeSchema = z.object({
  status: z.enum(['published', 'retry', 'failed', 'deferred']),
  /** Platform post id (`queue_items.external_post_id`) on success. */
  externalPostId: z.string().optional(),
  /** First-comment id (`queue_items.external_comment_id`) when one was posted. */
  externalCommentId: z.string().nullable().optional(),
  /**
   * Non-fatal warning on a published post (e.g. the post went live but
   * its first comment failed) — settled as the publish log's
   * comment warning, exactly like today's Facebook flow.
   */
  commentWarning: z.string().optional(),
  /** Classified failure; present whenever `status` is `retry`, `failed`, or `deferred` (as the deferral's reason). */
  error: ClassifiedPublishErrorSchema.optional(),
  /** Backoff before a `retry` or `deferred` outcome becomes due again, in seconds. */
  retryDelaySeconds: z.number().nonnegative().optional(),
  /**
   * Platform session state for `publish_logs.detail`: IG/Threads
   * container ids, YouTube upload session id, provider name/post ref for
   * Post-for-Me platforms, X media ids. Persisted from the first attempt
   * so a retry can resume instead of restarting (spec 119 §11).
   */
  detail: z.record(z.unknown()).optional(),
  /** Destination status side effect for settlement (e.g. `rate_limited`). */
  targetDestinationStatus: z
    .enum(['active', 'rate_limited', 'disconnected', 'error'])
    .optional(),
  /**
   * Spec 155: the Facebook detail marker for settlement (`metadata.fb_status`
   * on the destination) — the wire status's detail, e.g. `missing_permission`.
   * Undefined means "leave the marker alone" (publisher has no opinion);
   * null means "clear it" (e.g. the destination flipped back to active or
   * to rate-limited, whose anchor lives in `rate_limited_at`). Consumers
   * apply it AFTER a successful settle, through the
   * `apply_destination_fb_status_marker` RPC (a single-statement jsonb
   * merge — the settle RPC does not know the marker); a marker write
   * failure is logged loudly and never blocks the settle; the coarse
   * status from the settle is always right even when the marker write
   * fails.
   */
  targetDestinationFbStatus: z
    .enum([
      'checkpoint',
      'invalid_token',
      'page_not_accessible',
      'missing_page_access',
      'missing_permission',
      'check_developer_app',
      'account_suspended',
      '2fa_required_on_BM',
    ])
    .nullable()
    .optional(),
  /** Account status side effect for settlement (`expired` on auth errors). */
  targetAccountStatus: z.enum(['active', 'expired', 'revoked', 'error']).optional(),
  /** Latest per-destination rate usage (0–100), when the platform reports it. */
  rateUsagePct: z.number().min(0).max(100).optional(),
});

export type PublishOutcome = z.infer<typeof PublishOutcomeSchema>;

/**
 * The shared publisher contract. `publish` reports platform failures as
 * `PublishOutcome`s rather than throwing; it throws only for unexpected
 * errors (bugs, transport failures outside the platform API), which the
 * consumer treats as a queue-level retry (spec 121 Scope.5).
 */
export interface Publisher {
  readonly platform: Platform;

  publish(
    item: DatabaseUnifiedQueueItemRow,
    destination: DatabaseDestinationRow,
    tokens: PublisherTokenSet
  ): Promise<PublishOutcome>;

  /**
   * Refreshes the account's tokens. Called ONLY by the token refresh job
   * (spec 121 D6); consumers and the claimer never call this. Provider-
   * managed platforms (YouTube/TikTok via Post for Me) hold no tokens of
   * ours — their implementations return the supplied tokens unchanged.
   */
  refreshTokens(
    account: DatabaseSocialAccountRow,
    tokens: PublisherTokenSet
  ): Promise<RefreshedTokenSet>;

  /** Classifies any error thrown by the platform client. Pure and total: never throws. */
  mapError(err: unknown): ClassifiedPublishError;
}

// ==========================================
// Publisher registry (spec 121 Scope.1)
// ==========================================
//
// Deliberately minimal: platform specs construct their publisher and call
// `register` once at worker startup; consumers `get` by the queue item's
// denormalized `platform`. No factory machinery — construction is each
// platform module's own business.

export class PublisherRegistry {
  private readonly publishers = new Map<Platform, Publisher>();

  /** Registers a publisher under its own `platform`. Throws on a duplicate platform. */
  register(publisher: Publisher): void {
    if (this.publishers.has(publisher.platform)) {
      throw new Error(
        `A publisher is already registered for platform "${publisher.platform}"`
      );
    }
    this.publishers.set(publisher.platform, publisher);
  }

  get(platform: Platform): Publisher | undefined {
    return this.publishers.get(platform);
  }

  has(platform: Platform): boolean {
    return this.publishers.has(platform);
  }

  /** Platforms with a registered publisher, in registration order. */
  platforms(): Platform[] {
    return [...this.publishers.keys()];
  }
}

export function createPublisherRegistry(): PublisherRegistry {
  return new PublisherRegistry();
}
