import type {
  FacebookAccountStatus,
  FacebookPageStatus,
  PostFormat,
  QueueItemStatus,
} from '@fbuploadpro/contracts';

/**
 * Wire mappings between the unified schema (spec 119/120) and the
 * Facebook wire vocabulary the tenant API contracts still speak
 * (`packages/contracts/src/domain/facebook.ts` + `queue.ts`).
 *
 * Since the Phase 7 drop (migration 20261024130000) the Facebook Page
 * section's API routes read and write ONLY the unified tables
 * (`social_accounts`, `destinations`, `posting_slots`, `queue_items`);
 * these maps are the single translation point between the two
 * vocabularies. The forward direction follows spec 120 §7's documented
 * backfill CASE maps; the reverse direction is its inverse where one
 * exists and the documented lossy choice where it does not:
 *
 * - destinations.status 'error' reads back as 'invalid_token',
 *   unless the row carries the checkpoint marker below, in which
 *   case it reads back as 'page_checkpoint'. Rows backfilled from
 *   pre-unification checkpoint pages carry no marker and still read
 *   as 'invalid_token' — spec 120 §7c's accepted lossy direction.
 * - destinations.status 'rate_limited' reads back as 'fb_rate_limited'.
 * - social_accounts.status 'revoked' and 'error' read back as
 *   'disconnected' (the wire account vocabulary has no other bucket).
 * - Page pause has no unified status: a paused page is stored as
 *   status 'disconnected' with `metadata.fb_status = 'paused'`, and
 *   the marker is what reads back as 'paused'. Rows backfilled from
 *   pre-unification paused pages carry no marker and read as
 *   'disconnected' — spec 120 §7c's accepted lossy direction.
 */

export type UnifiedAccountStatus = 'active' | 'expired' | 'revoked' | 'error';
export type UnifiedDestinationStatus =
  | 'active'
  | 'rate_limited'
  | 'disconnected'
  | 'error';
export type UnifiedQueueItemStatus =
  | 'queued'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

export const PAUSED_MARKER_KEY = 'fb_status';
export const PAUSED_MARKER_VALUE = 'paused';
/**
 * Checkpoint marker, same pattern as the paused marker: a checkpoint
 * page is stored as status 'error' (the destinations vocabulary has
 * no checkpoint value) with `metadata.fb_status = 'checkpoint'`,
 * and the marker is what reads back as 'page_checkpoint'. Without
 * the marker, 'error' still reads as 'invalid_token'.
 */
export const CHECKPOINT_MARKER_VALUE = 'checkpoint';

export function unifiedAccountStatusToWire(
  status: string | null | undefined
): FacebookAccountStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'expired':
      return 'expired';
    default:
      // 'revoked' | 'error' | anything unexpected
      return 'disconnected';
  }
}

export function wireAccountStatusToUnified(
  status: FacebookAccountStatus
): UnifiedAccountStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'expired':
      return 'expired';
    case 'disconnected':
      return 'revoked';
  }
}

export function unifiedDestinationStatusToWire(
  status: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined
): FacebookPageStatus {
  if (
    status === 'disconnected' &&
    metadata?.[PAUSED_MARKER_KEY] === PAUSED_MARKER_VALUE
  ) {
    return 'paused';
  }
  if (
    status === 'error' &&
    metadata?.[PAUSED_MARKER_KEY] === CHECKPOINT_MARKER_VALUE
  ) {
    return 'page_checkpoint';
  }
  switch (status) {
    case 'active':
      return 'active';
    case 'rate_limited':
      return 'fb_rate_limited';
    case 'error':
      return 'invalid_token';
    default:
      // 'disconnected' | anything unexpected
      return 'disconnected';
  }
}

/**
 * The destinations write for a wire page status: the status column
 * value plus whether the paused marker must be set (true), cleared
 * (false), or left as-is (null — e.g. token-only refreshes).
 */
export function wirePageStatusToUnified(status: FacebookPageStatus): {
  status: UnifiedDestinationStatus;
  pausedMarker: boolean | null;
} {
  switch (status) {
    case 'active':
      return { status: 'active', pausedMarker: false };
    case 'paused':
      return { status: 'disconnected', pausedMarker: true };
    case 'fb_rate_limited':
      return { status: 'rate_limited', pausedMarker: false };
    case 'page_checkpoint':
    case 'invalid_token':
      return { status: 'error', pausedMarker: false };
    case 'disconnected':
      return { status: 'disconnected', pausedMarker: false };
  }
}

/** SQL CASE fragment mapping destinations.status to the wire page status. */
export const DESTINATION_STATUS_TO_WIRE_SQL = `CASE
  WHEN d.status = 'disconnected' AND d.metadata->>'fb_status' = 'paused' THEN 'paused'
  WHEN d.status = 'error' AND d.metadata->>'fb_status' = 'checkpoint' THEN 'page_checkpoint'
  WHEN d.status = 'active' THEN 'active'
  WHEN d.status = 'rate_limited' THEN 'fb_rate_limited'
  WHEN d.status = 'error' THEN 'invalid_token'
  ELSE 'disconnected'
END`;

/** SQL CASE fragment mapping social_accounts.status to the wire account status. */
export const ACCOUNT_STATUS_TO_WIRE_SQL = `CASE
  WHEN sa.status = 'active' THEN 'active'
  WHEN sa.status = 'expired' THEN 'expired'
  ELSE 'disconnected'
END`;

/**
 * The wire post format for a unified queue row: `platform_format`
 * when it carries one ('reel'), otherwise the row's `kind`. Mirrors
 * the composer enqueue mapping (reel → kind 'video' +
 * platform_format 'reel'; every other format stores a null
 * platform_format).
 */
export function unifiedQueueRowToPostFormat(
  kind: string | null | undefined,
  platformFormat: string | null | undefined
): PostFormat {
  if (platformFormat === 'reel') return 'reel';
  switch (kind) {
    case 'video':
      return 'video';
    case 'image':
      return 'image';
    case 'story':
      return 'story';
    case 'text':
      return 'text';
    default:
      return 'image';
  }
}

/** Inverse of the composer enqueue format mapping (format → kind + platform_format). */
export function wireFormatToUnifiedKind(format: PostFormat): {
  kind: 'text' | 'image' | 'video' | 'story';
  platformFormat: string | null;
} {
  if (format === 'reel') return { kind: 'video', platformFormat: 'reel' };
  if (format === 'video') return { kind: 'video', platformFormat: null };
  if (format === 'image') return { kind: 'image', platformFormat: null };
  if (format === 'story') return { kind: 'story', platformFormat: null };
  return { kind: 'text', platformFormat: null };
}

/**
 * Queue item status across the vocabularies. The unified table has
 * no 'skipped': pre-unification skipped items were backfilled to
 * 'cancelled', and a wire write of 'skipped' lands as 'cancelled'.
 */
export function wireQueueStatusToUnified(
  status: QueueItemStatus
): UnifiedQueueItemStatus {
  return status === 'skipped' ? 'cancelled' : status;
}

export function unifiedQueueStatusToWire(
  status: string | null | undefined
): QueueItemStatus {
  switch (status) {
    case 'queued':
    case 'publishing':
    case 'published':
    case 'failed':
    case 'cancelled':
      return status;
    default:
      return 'failed';
  }
}
