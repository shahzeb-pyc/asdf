import {
  DatabaseDestinationRowSchema,
  DatabaseSocialAccountRowSchema,
  DatabaseUnifiedQueueItemRowSchema,
  decryptToken,
  encryptToken,
  fetchAllFacebookPages,
  InternalError,
  ValidationError,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type Platform,
  type PublishLane,
  type PublishOutcome,
  type PublisherRegistry,
  type SettleQueueItemOutcomeUnifiedArgs,
} from '@fbuploadpro/contracts';
import { captureWorkerError, type PostHogEnv } from './analytics.js';
import { recordHeartbeat } from './heartbeat.js';
import type { PublishQueueMessage } from './claimer.js';

// ==========================================
// Queue consumers (spec 121 Scope 5) + DLQ consumers (Scope 6)
// ==========================================
//
// Publish consumers run per queue message: load the CURRENT row state
// (a cancelled/edited/settled item is honoured, never published from a
// stale message), decrypt the stored tokens, call the registered
// platform `Publisher`, and settle through the unified
// `settle_queue_item_outcome` RPC — which writes a `publish_logs` row on
// every attempt.
//
// Consumers contain ZERO token-refresh calls (spec 121 D6): an
// auth-classified outcome settles `failed` with the account-expired
// cascade carried in the settle args; the separate token-refresh job is
// the sole owner of token rotation. The one exception is audit BG5's
// publish-time page-token re-discovery: a single re-fetch of a page
// token from the live user token on a 190, which spends no refresh
// grant and never rotates the user token.
//
// Error semantics: an unexpected throw (publisher bug, DB failure,
// decrypt failure, settle failure) is NOT caught-and-acked. The message
// stays un-acked, the batch handler rethrows, and Cloudflare Queues
// retries the message with backoff until it lands in the lane DLQ.
//
// Batch handling (spec 139 B12): messages within one batch are
// processed with bounded concurrency — cap equal to the batch size —
// because batch items are independent (each loads and settles its own
// queue row) and serial processing wasted the batch window on summed
// per-item Graph latency. See `mapWithBoundedConcurrency`.
//
// Spec 139 publish-safety defences layered on top of that contract:
//   - Idempotency: an item already carrying `external_post_id` is
//     settled `published` from the stored ids, never re-published.
//   - Readiness: destination/account state is re-read before every
//     publish; a destination in cooldown or no longer claimable, or a
//     non-active account, defers the item back to `queued`.
//   - DLQ: only an item still in `publishing` is settled failed; every
//     other status is a no-op (the recovery sweep may have reclaimed
//     it, or another path already settled it).

export const PUBLISH_FAST_QUEUE_NAME = 'publish-fast';
export const PUBLISH_HEAVY_QUEUE_NAME = 'publish-heavy';
export const PUBLISH_FAST_DLQ_NAME = 'publish-fast-dlq';
export const PUBLISH_HEAVY_DLQ_NAME = 'publish-heavy-dlq';

/** Fallback backoff for a `retry` outcome with no publisher-supplied delay. */
export const DEFAULT_RETRY_DELAY_SECONDS = 300;

/** Error code settled onto items that exhaust queue retries into a DLQ. */
export const DLQ_ERROR_CODE = 'queue_dlq_exhausted';

/**
 * Deferral error codes (spec 139): a claimed item whose destination or
 * account is no longer publishable is settled back to `queued` instead
 * of being published. The codes land in the item's error fields and in
 * the publish-log row the settle RPC writes, so a deferral is auditable
 * rather than silent.
 */
export const DEFER_ACCOUNT_NOT_ACTIVE_CODE = 'account_not_active';
export const DEFER_DESTINATION_COOLDOWN_CODE = 'destination_cooldown';
export const DEFER_DESTINATION_NOT_ACTIVE_CODE = 'destination_not_active';

export interface ConsumerDbClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>
  ): Promise<{ data: unknown; error: unknown }>;
  from(table: string): RowQueryBuilder;
}

export interface RowQueryBuilder {
  select(columns: string): RowQueryBuilder;
  eq(column: string, value: unknown): RowQueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
  // Audit BG5: the stale page-token fallback persists a
  // re-discovered page token through the same supabase-style
  // chain the refresh job uses (update().eq() resolves to
  // { data, error }).
  update(values: Record<string, unknown>): {
    eq(column: string, value: unknown): Promise<{ data: unknown; error: unknown }>;
  };
}

export interface ConsumerDeps {
  db: ConsumerDbClient;
  registry: PublisherRegistry;
  masterKey?: string | undefined;
  env?: PostHogEnv;
}

export interface DlqConsumerDeps {
  db: ConsumerDbClient;
  env?: PostHogEnv;
}

function isPublishQueueMessage(body: unknown): body is PublishQueueMessage {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as Partial<PublishQueueMessage>;
  return (
    typeof candidate.itemId === 'string' &&
    typeof candidate.platform === 'string' &&
    typeof candidate.lane === 'string'
  );
}

async function loadRowById(
  db: ConsumerDbClient,
  table: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from(table).select('*').eq('id', id).maybeSingle();
  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return (data as Record<string, unknown> | null) ?? null;
}

/** Mark an error as already captured so batch-level wrappers do not double-report it. */
function markCaptured(err: unknown): void {
  if (err && typeof err === 'object') {
    (err as { __workerCaptured?: boolean }).__workerCaptured = true;
  }
}

function isCaptured(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && (err as { __workerCaptured?: boolean }).__workerCaptured
  );
}

/** Structural shape of the contracts row schemas this module validates with. */
interface RowSchema<T> {
  safeParse(
    data: unknown
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

/**
 * Boundary validation (spec 139 B15): a row loaded from the database is
 * validated ONCE, at load, against its contracts schema. A malformed
 * row fails LOUDLY — PostHog capture plus a typed `ValidationError` —
 * and is never silently skipped or cast into shape: on the publish path
 * the message stays un-acked for queue retry, and on the DLQ path the
 * arrival stays loud (see `processDlqMessage`).
 */
function validateLoadedRow<T>(
  schema: RowSchema<T>,
  table: string,
  id: string,
  raw: Record<string, unknown>,
  env: PostHogEnv
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const validationError = new ValidationError(
      `Malformed ${table} row failed boundary validation (id=${id})`,
      { table, id, issues: result.error.issues }
    );
    captureWorkerError(env, validationError, {
      site: 'consumers',
      kind: 'row_validation_failed',
      table,
      rowId: id,
    });
    markCaptured(validationError);
    throw validationError;
  }
  return result.data;
}

async function loadQueueItemRow(
  db: ConsumerDbClient,
  id: string,
  env: PostHogEnv
): Promise<DatabaseUnifiedQueueItemRow | null> {
  const raw = await loadRowById(db, 'queue_items', id);
  return raw ? validateLoadedRow(DatabaseUnifiedQueueItemRowSchema, 'queue_items', id, raw, env) : null;
}

async function loadDestinationRow(
  db: ConsumerDbClient,
  id: string,
  env: PostHogEnv
): Promise<DatabaseDestinationRow | null> {
  const raw = await loadRowById(db, 'destinations', id);
  return raw ? validateLoadedRow(DatabaseDestinationRowSchema, 'destinations', id, raw, env) : null;
}

async function loadSocialAccountRow(
  db: ConsumerDbClient,
  id: string,
  env: PostHogEnv
): Promise<DatabaseSocialAccountRow | null> {
  const raw = await loadRowById(db, 'social_accounts', id);
  return raw
    ? validateLoadedRow(DatabaseSocialAccountRowSchema, 'social_accounts', id, raw, env)
    : null;
}

/**
 * Audit BG5 — stale page-token re-discovery (publish-time fallback).
 *
 * A stored page token can go stale while the user token is still
 * alive (page re-auth, permission change), and today that surfaces
 * only as a failed post with a 190 that also flips the whole
 * account to expired — even though the account itself is fine.
 * On a 190 the consumer re-discovers the page list from the live
 * user token and, when the page is there with a fresh token,
 * retries the publish once with it. This is NOT a token refresh
 * (spec 121 D6): no refresh grant is spent, the user token is
 * never rotated, and the refresh job remains the sole owner of
 * rotation/lapse. It is a single re-fetch of a page token from
 * an already-valid user token.
 *
 * Returns null whenever re-discovery is impossible: Graph
 * failure, the page absent from the list (including a truncated
 * list — a partial list is never treated as "page gone"), or an
 * empty token. Null means the original 190 failure stands and
 * settles loudly; it is never swallowed into a retry or skip.
 */
export async function rediscoverFacebookPageToken(
  userToken: string,
  pageId: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<string | null> {
  try {
    const pages = await fetchAllFacebookPages(
      userToken,
      'id,access_token',
      5,
      fetchFn
    );
    // Guarded: String(undefined) is the truthy string "undefined",
    // so a page without an id must never match by stringification.
    const match = pages.find((p) => {
      if (!p.id) return false;
      return String(p.id) === pageId;
    });
    const token = match?.access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch (err) {
    console.error(
      `[consumer] BG5 page-token re-discovery failed for page ${pageId}:`,
      err
    );
    return null;
  }
}

/** Counts-only heartbeat write; the consumer DB handle is the supabase client at runtime. */
async function writeHeartbeatCounts(
  db: ConsumerDbClient,
  record: { settled?: number; dlqFast?: number; dlqHeavy?: number }
): Promise<void> {
  await recordHeartbeat(db as never, { success: true, countsOnly: true, ...record });
}

/**
 * Settle args as sent by this consumer. The contracts
 * `SettleQueueItemOutcomeUnifiedArgs` does not carry `p_detail` yet (a
 * parallel spec 139 PR adds it to the contracts type and the settle RPC
 * together); until then the consumer threads a publisher's
 * `PublishOutcome.detail` through this narrowly-typed optional field.
 * It is only present when the publisher actually supplied `detail` —
 * no current publisher does — so the RPC payload is unchanged today
 * and activates with no further consumer change once the RPC accepts it.
 */
export type SettleArgsWithDetail = SettleQueueItemOutcomeUnifiedArgs & {
  p_detail?: Record<string, unknown> | null;
};

async function callSettleRpc(
  db: ConsumerDbClient,
  args: SettleArgsWithDetail
): Promise<void> {
  const { error } = await db.rpc(
    'settle_queue_item_outcome',
    args as unknown as Record<string, unknown>
  );
  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  // Publish-path flag maintenance (publisher-driven scheduling):
  // every settle changes the queued set for the destination
  // (published, deferred back to queued, retried, failed), so the
  // unmatched-posts flag is recomputed here. Best-effort: a refresh
  // failure is logged, never allowed to fail the settle — the next
  // slot/enqueue/publish event refreshes the flag again.
  try {
    const { error: refreshError } = await db.rpc('refresh_destination_unmatched_flag', {
      p_destination_id: args.p_destination_id,
    });
    if (refreshError) {
      console.error(
        `[settle] unmatched-flag refresh failed for destination ${args.p_destination_id}:`,
        refreshError
      );
    }
  } catch (err) {
    console.error(
      `[settle] unmatched-flag refresh threw for destination ${args.p_destination_id}:`,
      err
    );
  }
}

/**
 * Maps a publisher's unified `PublishOutcome` onto the 16-arg unified
 * `settle_queue_item_outcome` RPC (migration 20261022120000 §6b, TEXT
 * error codes):
 *   - `published` → outcome `published`; platform post/comment ids are
 *     passed in the RPC's id fields (they land on the queue item and in
 *     the `publish_logs` row the RPC writes).
 *   - `retry` → outcome `queued` with the publisher's retry delay
 *     (falling back to the error's backoff hint, then the default).
 *   - `deferred` → outcome `deferred` with the publisher's deferral
 *     delay; the stored retry count does NOT advance — deferrals
 *     (platform caps, platform-wide pauses) are not the item's fault.
 *   - `failed` → outcome `failed`; an `auth`-classified error with no
 *     explicit account status still cascades the account to `expired`
 *     via `p_target_account_status` — settled by the RPC, never by a
 *     consumer-side refresh attempt.
 *
 * `p_retry_count` convention (matching the RPC, which derives the log's
 * attempt number as `p_retry_count + 1` and stores `p_retry_count` as
 * the item's new retry count on retry/failed outcomes): published
 * passes the item's current count so the logged attempt number is
 * exact; retry/failed pass the incremented count so the stored retry
 * count advances. Deferred passes the item's current count — and the
 * RPC's `deferred` branch ignores the value for the stored count
 * entirely (it never writes retry_count), so a deferral cannot consume
 * retry budget even if a future caller passes the wrong number.
 *
 * `detail` threading (spec 139): a publisher's `PublishOutcome.detail`
 * (platform session state for `publish_logs.detail`) is carried into
 * `p_detail` whenever the publisher supplied one — see
 * `SettleArgsWithDetail` for why the field is consumer-local for now.
 */
export function mapPublishOutcomeToSettleArgs(
  item: DatabaseUnifiedQueueItemRow,
  outcome: PublishOutcome
): SettleArgsWithDetail {
  const base: SettleArgsWithDetail = {
    p_queue_item_id: item.id,
    p_workspace_id: item.workspace_id,
    p_destination_id: item.destination_id,
    p_outcome_status: 'failed',
    p_external_post_id: outcome.externalPostId ?? null,
    p_external_comment_id: outcome.externalCommentId ?? null,
    p_retry_count: item.retry_count,
    p_retry_delay_seconds: DEFAULT_RETRY_DELAY_SECONDS,
    p_error_code: outcome.error?.code ?? null,
    p_error_subcode: outcome.error?.subcode ?? null,
    p_error_message: outcome.error?.message ?? null,
    p_comment_warning: outcome.commentWarning ?? null,
    p_target_destination_status: outcome.targetDestinationStatus ?? null,
    p_target_account_status: outcome.targetAccountStatus ?? null,
    p_destination_cooldown_seconds: outcome.destinationCooldownSeconds ?? null,
    p_rate_usage_pct:
      outcome.rateUsagePct !== undefined ? Math.round(outcome.rateUsagePct) : null,
    ...(outcome.detail !== undefined ? { p_detail: outcome.detail } : {}),
  };

  if (outcome.status === 'published') {
    return { ...base, p_outcome_status: 'published' };
  }

  if (outcome.status === 'retry') {
    return {
      ...base,
      p_outcome_status: 'queued',
      p_retry_count: item.retry_count + 1,
      p_retry_delay_seconds:
        outcome.retryDelaySeconds ??
        outcome.error?.retryDelaySeconds ??
        DEFAULT_RETRY_DELAY_SECONDS,
    };
  }

  if (outcome.status === 'deferred') {
    return {
      ...base,
      p_outcome_status: 'deferred',
      p_retry_count: item.retry_count,
      p_retry_delay_seconds:
        outcome.retryDelaySeconds ??
        outcome.error?.retryDelaySeconds ??
        DEFAULT_RETRY_DELAY_SECONDS,
    };
  }

  return {
    ...base,
    p_outcome_status: 'failed',
    p_retry_count: item.retry_count + 1,
    p_target_account_status:
      outcome.targetAccountStatus ??
      (outcome.error?.kind === 'auth' ? 'expired' : null),
  };
}

/** Settle args for a DLQ arrival: `failed` with the DLQ reason. */
export function buildDlqSettleArgs(
  item: DatabaseUnifiedQueueItemRow,
  queueName: string,
  attempts: number
): SettleQueueItemOutcomeUnifiedArgs {
  return {
    p_queue_item_id: item.id,
    p_workspace_id: item.workspace_id,
    p_destination_id: item.destination_id,
    p_outcome_status: 'failed',
    p_external_post_id: null,
    p_external_comment_id: null,
    p_retry_count: item.retry_count + 1,
    p_retry_delay_seconds: DEFAULT_RETRY_DELAY_SECONDS,
    p_error_code: DLQ_ERROR_CODE,
    p_error_subcode: null,
    p_error_message:
      `Publish message exhausted queue retries (${attempts} attempt${attempts === 1 ? '' : 's'}) ` +
      `and was moved to ${queueName}; settled as failed.`,
    p_comment_warning: null,
    p_target_destination_status: null,
    p_target_account_status: null,
    p_destination_cooldown_seconds: null,
    p_rate_usage_pct: null,
  };
}

/** Why a claimed item must not be published right now (spec 139). */
export interface PublishDeferral {
  code: string;
  message: string;
  retryDelaySeconds: number;
}

/**
 * Re-checks destination/account state at publish time (spec 139),
 * mirroring the claim RPC's eligibility rules exactly: the claimer only
 * claims an item when its account is `active` and its destination is
 * claimable — `active`, or `rate_limited` once its
 * `next_allowed_publish_at` cooldown has elapsed — with no cooldown in
 * the future. State can change between claim and consume (a sibling
 * publish trips a rate limit and imposes a cooldown, the destination
 * is disconnected, the account expires), so the consumer re-reads both
 * rows and re-applies the same test before spending a platform call.
 *
 * Returns the deferral to settle, or null when publishing may proceed.
 * Check order: account first (the most fundamental blocker), then the
 * cooldown (the binding constraint for a `rate_limited` destination),
 * then destination claimability.
 */
export function evaluatePublishReadiness(
  destination: DatabaseDestinationRow,
  account: DatabaseSocialAccountRow,
  now: Date = new Date()
): PublishDeferral | null {
  if (account.status !== 'active') {
    return {
      code: DEFER_ACCOUNT_NOT_ACTIVE_CODE,
      message:
        `Social account ${account.id} is "${account.status}", not active; ` +
        'deferred without publishing.',
      retryDelaySeconds: DEFAULT_RETRY_DELAY_SECONDS,
    };
  }

  // Audit BG4 remainder: a Facebook token whose expiry date has passed
  // is lapsed even if the refresh job has not flipped the status yet.
  // Defer (never claim-and-fail-terminally on a Graph 190) so the
  // item returns to the slot pool via the BG3 settle rule. Other
  // platforms keep the status-only rule (their tokens may be
  // refreshable), mirroring the claim RPC predicate.
  if (
    account.platform === 'facebook' &&
    account.token_expires_at !== null &&
    new Date(account.token_expires_at).getTime() <= now.getTime()
  ) {
    return {
      code: DEFER_ACCOUNT_NOT_ACTIVE_CODE,
      message:
        `Social account ${account.id} token expired at ` +
        `${account.token_expires_at}; deferred without publishing.`,
      retryDelaySeconds: DEFAULT_RETRY_DELAY_SECONDS,
    };
  }

  const nextAllowedAt = destination.next_allowed_publish_at
    ? new Date(destination.next_allowed_publish_at)
    : null;
  const nextAllowedMs =
    nextAllowedAt && !Number.isNaN(nextAllowedAt.getTime())
      ? nextAllowedAt.getTime()
      : null;
  if (nextAllowedMs !== null && nextAllowedMs > now.getTime()) {
    return {
      code: DEFER_DESTINATION_COOLDOWN_CODE,
      message:
        `Destination ${destination.id} is in cooldown until ` +
        `${destination.next_allowed_publish_at}; deferred without publishing.`,
      retryDelaySeconds: Math.max(
        1,
        Math.ceil((nextAllowedMs - now.getTime()) / 1000)
      ),
    };
  }

  const cooldownElapsed = nextAllowedMs !== null && nextAllowedMs <= now.getTime();
  const claimable =
    destination.status === 'active' ||
    (destination.status === 'rate_limited' && cooldownElapsed);
  if (!claimable) {
    return {
      code: DEFER_DESTINATION_NOT_ACTIVE_CODE,
      message:
        `Destination ${destination.id} is "${destination.status}", not ` +
        'claimable; deferred without publishing.',
      retryDelaySeconds: DEFAULT_RETRY_DELAY_SECONDS,
    };
  }

  return null;
}

/**
 * Settle args for a readiness deferral: back to `queued` via the
 * settle RPC's `deferred` outcome (spec 139 defer outcome), so the
 * claimer re-claims the item once it is due AND eligible again (the
 * claim RPC re-applies the same eligibility test, so a still-ineligible
 * item is never hot-looped). Audit BG3 (owner decision 2026-10-30):
 * for platform `facebook` the settle RPC resets `scheduled_time` to
 * NULL on defer/retry, so the row returns to the slot pool and is
 * picked up only by `claim_posting_slot_item` at a later posting slot
 * — never by the due claimer at an unscheduled time. Deliberate differences from a `retry`
 * settle:
 *   - the RPC's deferred branch does NOT write `retry_count` — no
 *     publish attempt was made, so no retry budget is consumed (the
 *     stored count is unchanged whatever is passed here; claim-time
 *     D5 deferral likewise reschedules without touching the count).
 *   - the delay is the deferral's own: for a cooldown it is the exact
 *     time until `next_allowed_publish_at`, so the item becomes due in
 *     step with the destination becoming eligible.
 */
export function buildDeferSettleArgs(
  item: DatabaseUnifiedQueueItemRow,
  deferral: PublishDeferral
): SettleArgsWithDetail {
  return {
    p_queue_item_id: item.id,
    p_workspace_id: item.workspace_id,
    p_destination_id: item.destination_id,
    p_outcome_status: 'deferred',
    p_external_post_id: null,
    p_external_comment_id: null,
    p_retry_count: item.retry_count,
    p_retry_delay_seconds: deferral.retryDelaySeconds,
    p_error_code: deferral.code,
    p_error_subcode: null,
    p_error_message: deferral.message,
    p_comment_warning: null,
    p_target_destination_status: null,
    p_target_account_status: null,
    p_destination_cooldown_seconds: null,
    p_rate_usage_pct: null,
  };
}

/**
 * Maps `items` through `task` with at most `concurrency` tasks in
 * flight at once, resolving with one settled result per item IN INPUT
 * ORDER — `Promise.allSettled` semantics: a rejecting task is captured
 * in its own result slot and never aborts, skips, or delays the tasks
 * beside it. Implemented as a small worker pool over a shared index,
 * so there are no chunk barriers: a slow item occupies only its own
 * slot, never the whole batch.
 */
export async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  if (items.length === 0) {
    return results;
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      try {
        const value = await task(item);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.allSettled(runners);
  return results;
}

type ProcessResult = 'settled' | 'skipped';

async function processPublishMessage(
  message: Message<PublishQueueMessage>,
  deps: ConsumerDeps
): Promise<ProcessResult> {
  const body = message.body;
  if (!isPublishQueueMessage(body)) {
    throw new ValidationError('Malformed publish queue message body');
  }

  const item = await loadQueueItemRow(deps.db, body.itemId, deps.env ?? {});
  if (!item) {
    console.warn(`[consumer] queue item ${body.itemId} no longer exists; skipping`);
    return 'skipped';
  }

  // Current state is honoured: anything no longer in `publishing`
  // (cancelled, edited back to queued, already settled) is skipped.
  if (item.status !== 'publishing') {
    return 'skipped';
  }

  // Idempotency guard (spec 139): a previous attempt already published
  // this item — its platform post id is on the row — but its settle
  // failed, leaving the item in `publishing`; this redelivery must NOT
  // publish again. Settle `published` from the stored ids instead.
  // The guard runs before destination/account loading on purpose: the
  // post exists even if its destination has since been removed, and
  // settling it must not depend on rows the publish no longer needs.
  const existingPostId = item.external_post_id;
  if (existingPostId) {
    await callSettleRpc(
      deps.db,
      mapPublishOutcomeToSettleArgs(item, {
        status: 'published',
        externalPostId: existingPostId,
        externalCommentId: item.external_comment_id,
      })
    );
    return 'settled';
  }

  const destination = await loadDestinationRow(deps.db, item.destination_id, deps.env ?? {});
  if (!destination) {
    throw new InternalError(`Destination ${item.destination_id} for queue item ${item.id} not found`);
  }

  const account = await loadSocialAccountRow(deps.db, destination.account_id, deps.env ?? {});
  if (!account) {
    throw new InternalError(`Social account ${destination.account_id} for queue item ${item.id} not found`);
  }

  // State re-check (spec 139): destination/account state may have
  // changed since the claim. Publishing into that state would burn a
  // platform call against a destination that cannot accept it, so
  // defer the item back to `queued` and settle — the caller acks any
  // 'settled' result, so the message is never hot-retried; the item
  // becomes claimable again only when it is due and eligible.
  const deferral = evaluatePublishReadiness(destination, account);
  if (deferral) {
    await callSettleRpc(deps.db, buildDeferSettleArgs(item, deferral));
    return 'settled';
  }

  const publisher = deps.registry.get(item.platform);
  if (!publisher) {
    throw new InternalError(`No publisher registered for platform "${item.platform}"`);
  }

  if (!deps.masterKey) {
    throw new InternalError('TOKEN_ENCRYPTION_KEY is not configured');
  }
  const masterKey = deps.masterKey;

  const tokens = {
    accessToken: await decryptToken(account.encrypted_access_token, masterKey),
    refreshToken: account.encrypted_refresh_token
      ? await decryptToken(account.encrypted_refresh_token, masterKey)
      : null,
    destinationToken: destination.encrypted_destination_token
      ? await decryptToken(destination.encrypted_destination_token, masterKey)
      : null,
    tokenExpiresAt: account.token_expires_at ?? null,
  };

  let outcome = await publisher.publish(item, destination, tokens);

  // Audit BG5: a 190 against the stored page token is retried
  // ONCE with a token re-discovered from the live user token.
  // Only a 190, only Facebook, only one attempt. When
  // re-discovery fails the original failure settles unchanged
  // (fail loud, including its account-expired cascade); when it
  // succeeds the fresh token is persisted best-effort so the
  // next publish does not repeat the dance, and the retry's
  // outcome — published or failed — is what settles. A persist
  // failure never blocks the retry: the in-memory fresh token
  // still saves this post.
  if (
    item.platform === 'facebook' &&
    outcome.status === 'failed' &&
    outcome.error?.code === '190' &&
    tokens.accessToken
  ) {
    const freshToken = await rediscoverFacebookPageToken(
      tokens.accessToken,
      destination.external_destination_id
    );
    if (freshToken) {
      try {
        const encrypted = await encryptToken(freshToken, masterKey);
        const { error: updateError } = await deps.db
          .from('destinations')
          .update({ encrypted_destination_token: encrypted })
          .eq('id', destination.id);
        if (updateError) {
          console.error(
            `[consumer] BG5 failed to persist re-discovered page token for destination ${destination.id}:`,
            updateError
          );
        }
      } catch (err) {
        console.error(
          `[consumer] BG5 failed to persist re-discovered page token for destination ${destination.id}:`,
          err
        );
      }
      outcome = await publisher.publish(item, destination, {
        ...tokens,
        destinationToken: freshToken,
      });
    }
  }

  await callSettleRpc(deps.db, mapPublishOutcomeToSettleArgs(item, outcome));
  return 'settled';
}

/**
 * Handles one publish-lane batch (publish-fast / publish-heavy).
 * Messages that settle or are legitimately skipped are acked; a message
 * whose processing throws stays un-acked and the handler rethrows after
 * the batch so Cloudflare Queues retries it with backoff.
 *
 * Intra-batch concurrency (spec 139 B12): messages are processed
 * CONCURRENTLY with the cap set to the batch size — every message in
 * the batch may be in flight at once, and the batch itself is the
 * bound (Cloudflare caps the batch via `max_batch_size` in
 * wrangler.toml — 10 publish-fast, 5 publish-heavy — which is
 * unchanged). Per-item semantics are identical to the previous serial
 * loop: each item's error is captured and logged in its own handler,
 * the settled count is aggregated once at the end, and the first
 * failure IN BATCH ORDER is rethrown only after every message has
 * finished processing — one item's failure never aborts, skips, or
 * delays the settlement of the others.
 */
export async function handlePublishBatch(
  batch: MessageBatch<PublishQueueMessage>,
  deps: ConsumerDeps
): Promise<void> {
  const results = await mapWithBoundedConcurrency(
    batch.messages,
    batch.messages.length,
    async (
      message
    ): Promise<{ settled: boolean; failed: boolean; error?: unknown }> => {
      try {
        const result = await processPublishMessage(message, deps);
        message.ack();
        return { settled: result === 'settled', failed: false };
      } catch (err) {
        if (!isCaptured(err)) {
          captureWorkerError(deps.env ?? {}, err, {
            site: 'handlePublishBatch',
            kind: 'publish_message_failed',
            queue: batch.queue,
            messageId: message.id,
          });
        }
        console.error(
          `[consumer] publish message ${message.id} failed; leaving un-acked for queue retry:`,
          err
        );
        return { settled: false, failed: true, error: err };
      }
    }
  );

  let settled = 0;
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.settled) settled++;
      if (result.value.failed) failures.push(result.value.error);
    } else {
      // Defensive: the per-message task above captures its own errors,
      // so a rejected slot should be unreachable — but never let one
      // vanish: it counts as a failure and is rethrown below.
      failures.push(result.reason);
    }
  }

  if (settled > 0) {
    await writeHeartbeatCounts(deps.db, { settled });
  }

  if (failures.length > 0) {
    throw failures[0];
  }
}

/**
 * Processes one DLQ message. Returns whether the item was actually
 * settled — the caller counts only real settlements toward the
 * heartbeat DLQ counters (spec 139).
 */
async function processDlqMessage(
  message: Message<PublishQueueMessage>,
  queueName: string,
  deps: DlqConsumerDeps
): Promise<boolean> {
  const env = deps.env ?? {};
  const body = message.body as Partial<PublishQueueMessage> | undefined;
  if (!body || typeof body.itemId !== 'string') {
    captureWorkerError(env, new Error('DLQ message with malformed body'), {
      site: 'handleDlqBatch',
      kind: 'malformed_dlq_message',
      queue: queueName,
    });
    console.error(`[dlq] malformed message ${message.id} on ${queueName}; acking`);
    return false;
  }

  let item: DatabaseUnifiedQueueItemRow;
  try {
    const loaded = await loadQueueItemRow(deps.db, body.itemId, env);
    if (!loaded) {
      captureWorkerError(
        env,
        new Error(`DLQ message references missing queue item ${body.itemId}`),
        { site: 'handleDlqBatch', kind: 'dlq_item_missing', queue: queueName }
      );
      console.error(`[dlq] queue item ${body.itemId} not found (${queueName}); acking`);
      return false;
    }
    item = loaded;
  } catch (err) {
    // A boundary-validation failure was already captured at the load
    // site with the row context; other load failures capture here.
    if (!isCaptured(err)) {
      captureWorkerError(env, err, {
        site: 'handleDlqBatch',
        kind: 'dlq_item_load_failed',
        queue: queueName,
      });
    }
    console.error(`[dlq] failed to load queue item ${body.itemId} (${queueName}):`, err);
    return false;
  }

  // Every DLQ arrival is loud: a PostHog exception, whether the item
  // still needs settlement or already reached a terminal state.
  captureWorkerError(
    env,
    new Error(
      `Publish message for queue item ${item.id} landed in ${queueName} after exhausting retries`
    ),
    {
      site: 'handleDlqBatch',
      kind: 'dlq_arrival',
      queue: queueName,
      queueItemId: item.id,
      platform: item.platform satisfies Platform,
      attempts: message.attempts,
    }
  );

  // Race guard (spec 139): settle ONLY an item still in `publishing`.
  // Anything else has already been dealt with — `queued` means the
  // stuck-publishing recovery sweep reclaimed it (or it was edited
  // back and will be claimed afresh), and `published` / `failed` /
  // `cancelled` are terminal. Settling those here would fail a live
  // item or write a second publish log for an already-settled one.
  if (item.status !== 'publishing') {
    return false;
  }

  try {
    await callSettleRpc(
      deps.db,
      buildDlqSettleArgs(item, queueName, message.attempts)
    );
    return true;
  } catch (err) {
    // Loud, but acked anyway (handled by the caller): a DLQ message must
    // not loop forever. The stuck-`publishing` recovery sweep remains
    // the backstop for the item itself.
    captureWorkerError(env, err, {
      site: 'handleDlqBatch',
      kind: 'dlq_settlement_failed',
      queue: queueName,
      queueItemId: item.id,
    });
    console.error(`[dlq] settlement failed for queue item ${item.id} (${queueName}):`, err);
    return false;
  }
}

/**
 * Handles one DLQ batch (publish-fast-dlq / publish-heavy-dlq): settles
 * each item still in `publishing` `failed` with the DLQ reason, raises
 * a PostHog exception per arrival, counts only actual settlements
 * toward the heartbeat DLQ counters, and acks every message after its
 * settlement attempt.
 */
export async function handleDlqBatch(
  batch: MessageBatch<PublishQueueMessage>,
  deps: DlqConsumerDeps
): Promise<void> {
  const queueName = batch.queue;
  const lane: PublishLane =
    queueName === PUBLISH_HEAVY_DLQ_NAME ? 'publish-heavy' : 'publish-fast';

  // Same intra-batch concurrency as the publish lanes (spec 139 B12):
  // cap = batch size, per-item semantics unchanged — each message is
  // acked after its own settlement attempt, whatever its outcome.
  const results = await mapWithBoundedConcurrency(
    batch.messages,
    batch.messages.length,
    async (message): Promise<boolean> => {
      try {
        return await processDlqMessage(message, queueName, deps);
      } catch (err) {
        if (!isCaptured(err)) {
          captureWorkerError(deps.env ?? {}, err, {
            site: 'handleDlqBatch',
            kind: 'unexpected',
            queue: queueName,
          });
        }
        console.error(`[dlq] unexpected error processing message ${message.id}:`, err);
        return false;
      } finally {
        message.ack();
      }
    }
  );
  const settledCount = results.reduce(
    (count, result) => count + (result.status === 'fulfilled' && result.value ? 1 : 0),
    0
  );

  // Heartbeat DLQ counters count actual settlements only (spec 139):
  // a batch of stale arrivals that settled nothing must not inflate
  // the DLQ counts the health tier watches.
  if (settledCount > 0) {
    await writeHeartbeatCounts(
      deps.db,
      lane === 'publish-fast' ? { dlqFast: settledCount } : { dlqHeavy: settledCount }
    );
  }
}

/** Dispatches a queue batch by queue name (the worker's `queue()` handler). */
export async function handleQueueBatch(
  batch: MessageBatch<PublishQueueMessage>,
  deps: ConsumerDeps & DlqConsumerDeps
): Promise<void> {
  switch (batch.queue) {
    case PUBLISH_FAST_QUEUE_NAME:
    case PUBLISH_HEAVY_QUEUE_NAME:
      return handlePublishBatch(batch, deps);
    case PUBLISH_FAST_DLQ_NAME:
    case PUBLISH_HEAVY_DLQ_NAME:
      return handleDlqBatch(batch, deps);
    default:
      console.error(`[consumer] unknown queue "${batch.queue}"; leaving batch un-acked`);
      throw new InternalError(`Unknown queue: ${batch.queue}`);
  }
}
