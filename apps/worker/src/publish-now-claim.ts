import { InternalError } from '@fbuploadpro/contracts';
import { captureWorkerError, type PostHogEnv } from './analytics.js';
import {
  enqueueClaimedRows,
  type ClaimerDbClient,
  type ClaimerQueues,
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

  // Shared with the slot-claim tick: validates, lanes, and
  // sendBatches the claimed rows.
  const enqueued = await enqueueClaimedRows(data, 'facebook', deps.queues);
  result.claimed += enqueued.claimed;
  result.enqueuedFast += enqueued.enqueuedFast;
  result.enqueuedHeavy += enqueued.enqueuedHeavy;

  if (result.claimed > 0) {
    console.info(
      `[publish-now-claim] tick claimed=${result.claimed} enqueuedFast=${result.enqueuedFast} enqueuedHeavy=${result.enqueuedHeavy}`
    );
  }
  return result;
}
