import { z } from 'zod';

// ==========================================
// Publishing idempotency keys
// ==========================================
//
// The response-lost hole: a publishing request can succeed on the
// server while its response never reaches the client (dropped
// connection, crashed tab). The client, having seen only a failure,
// retries — and without idempotency the retry executes AGAIN. For
// an enqueue that means a duplicate queued post, and therefore a
// duplicate publish.
//
// The fix is a client-generated key per logical action, remembered
// by the server:
//
//   - One key per post block for queueing (the composer sends the
//     same block's key on every retry of that block, so a replayed
//     enqueue returns the ORIGINAL queue item instead of a second
//     row). One key per request for other publishing actions
//     (publish-now, retry).
//   - Keys travel in the `Idempotency-Key` request header, never in
//     the body, so no existing request schema changes shape.
//   - The server stores (workspace, user, action, key) → the executed
//     response for 24 hours. A retry inside that window returns the
//     stored response without re-executing. An expired key behaves
//     as a new request; a key from another workspace or user never
//     replays (the namespace is part of the lookup, not just the
//     key string).
//   - Keys are UUIDs. Anything else is a client bug and is rejected
//     fail-loud (400) rather than silently treated as "no key".
//
// What this deliberately does NOT cover: concurrent double-submits
// of the same key. The shipped clients never send the same key
// concurrently (the composer queues sequentially; publish-now sends
// one request per tap), so the protection target is the sequential
// retry — the response-lost case. The unique constraint on
// (workspace, user, action, key) still guarantees at most one
// stored result per key.

/** The request header carrying the idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** How long the server remembers a key's result (24 hours). */
export const IDEMPOTENCY_RETENTION_SECONDS = 24 * 60 * 60;

/** A key must be a UUID — anything else is rejected, never ignored. */
export const IdempotencyKeySchema = z.string().uuid();

/**
 * The publishing actions that honour idempotency keys. Every
 * client-invoked publishing mutation is listed here; the worker's
 * claim path is server-side, not client-retried, and is excluded.
 */
export const IdempotencyActionSchema = z.enum([
  'destination-queue',
  'publish-now',
  'instagram-publish-now',
  'destination-publish-now',
  'destination-retry',
  'threads-publish-now',
  // Billing submissions (audit fix 2026-11-01): a retried checkout
  // after a dropped response replays the stored response instead of
  // creating a second pending payment. One action per submission
  // route, so a bank key can never replay a crypto response.
  'billing-bank',
  'billing-crypto',
  'billing-zero-due',
]);

export type IdempotencyAction = z.infer<typeof IdempotencyActionSchema>;
