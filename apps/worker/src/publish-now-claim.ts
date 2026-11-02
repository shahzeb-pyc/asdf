import {
  InternalError,
  PublishQueueMessageSchema,
  PUBLISH_LANE_FAST,
  routePublishLaneForItem,
  type PublishLane,
} from '@fbuploadpro/contracts';
// Note: the heavy lane is selected by the else branch below, so
// PUBLISH_LANE_HEAVY is intentionally not imported here.
import { captureWorkerError, type PostHogEnv } from './analytics.js';
import {
  SEND_BATCH_CHUNK_SIZE,
  type ClaimerDbClient,
  type ClaimerQueues,
  type PublishQueueMessage,
} from './claimer.js';

// ==========================================
// Publish-now immediate claim tick
// (20261102140000: Publish Now goes out EXTRA, never as a slot post)
// ==========================================
//
// A Publish Now click marks its queue row with
// `publish_now_requested_at` (both publish-now routes set it). Once
// per tick, this tick claims marked rows directly through the
// `claim_publish_now_items` RPC — independent of posting slots — and
// enqueues them to the publish lanes. The claim itself flips the row
// to `publishing` BEFORE any Facebook call (claim-before-call), so a
// second tick can never claim the same row again, and the queue row
// stops offering Publish now the moment it is claimed (the row
// renders the button only while `queued`).
//
// The slot claim excludes marked rows, so a marked row can never
// consume a posting slot — even if this tick is down, the row waits
// for this path instead of silently becoming a normal slot post.
// Non-Facebook publish-now keeps the existing due-claim behavior;
// this tick is Facebook-only by construction (the RPC hardcodes it).
//
// The tick ONLY claims and enqueues — it never publishes, exactly
// like the slot-claim and due-based claim ticks.

/** Rows claimed per tick. User-initiated traffic, bounded per tick. */
export const PUBLISH_NOW_CLAIM_LIMIT = 100;

export interface PublishNowClaimTickDeps {
  db: ClaimerDbClient;
  queues: ClaimerQueues;
  env?: PostHogEnv;
  limit?: number;
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export interface PublishNowClaimTickResult {
  claimed: number;
  enqueuedFast: number;
  enqueuedHeavy: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function runPublishNowClaimTick(
  deps: PublishNowClaimTickDeps
): Promise<PublishNowClaimTickResult> {
  const limit = deps.limit ?? PUBLISH_NOW_CLAIM_LIMIT;
  const result: PublishNowClaimTickResult = {
    claimed: 0,
    enqueuedFast: 0,
    enqueuedHeavy: 0,
  };

  const { data, error } = await deps.db.rpc('claim_publish_now_items', {
    p_limit: limit,
  });
  if (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    captureWorkerError(
      deps.env ?? {},
      err,
      { site: 'runPublishNowClaimTick', kind: 'claim_rpc_error' },
      deps.waitUntil
    );
    throw err;
  }
  if (!Array.isArray(data)) {
    throw new InternalError(
      'claim_publish_now_items returned a non-array payload'
    );
  }

  const pendingByLane = new Map<PublishLane, PublishQueueMessage[]>();
  for (const row of data) {
    if (!isRecord(row)) continue;
    const itemId = row.id;
    const kind = row.kind;
    const platformFormat = row.platform_format;
    if (typeof itemId !== 'string' || typeof kind !== 'string') continue;
    const lane = routePublishLaneForItem({
      platform: 'facebook',
      kind: kind as 'text' | 'image' | 'video' | 'story' | 'carousel',
      platform_format: typeof platformFormat === 'string' ? platformFormat : null,
    });
    const parsed = PublishQueueMessageSchema.safeParse({
      itemId,
      platform: 'facebook',
      lane,
    });
    if (!parsed.success) continue;
    const list = pendingByLane.get(lane) ?? [];
    list.push(parsed.data);
    pendingByLane.set(lane, list);
    result.claimed += 1;
  }

  for (const [lane, messages] of pendingByLane) {
    const queue = lane === PUBLISH_LANE_FAST ? deps.queues.fast : deps.queues.heavy;
    if (!queue) {
      throw new InternalError(`Queue producer binding for lane "${lane}" is not configured`);
    }
    for (let i = 0; i < messages.length; i += SEND_BATCH_CHUNK_SIZE) {
      const chunk = messages.slice(i, i + SEND_BATCH_CHUNK_SIZE);
      await queue.sendBatch(chunk.map((body) => ({ body })));
      if (lane === PUBLISH_LANE_FAST) {
        result.enqueuedFast += chunk.length;
      } else {
        result.enqueuedHeavy += chunk.length;
      }
    }
  }

  if (result.claimed > 0) {
    console.info(
      `[publish-now-claim] tick claimed=${result.claimed} enqueuedFast=${result.enqueuedFast} enqueuedHeavy=${result.enqueuedHeavy}`
    );
  }
  return result;
}
