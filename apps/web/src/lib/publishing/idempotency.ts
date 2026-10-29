import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_RETENTION_SECONDS,
  IdempotencyKeySchema,
  type IdempotencyAction,
} from '@fbuploadpro/contracts';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import type { ConnectDbClient } from '@/lib/connect/persist';
import { getRouteSupabase, isLegacyClient } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';

/**
 * Server-side half of publishing idempotency keys (contract in
 * packages/contracts/src/publishing/idempotency.ts).
 *
 * Flow, per publishing mutation:
 *   1. After auth, read the `Idempotency-Key` header. Absent = the
 *      old behaviour (no replay possible). Present but not a UUID =
 *      400: a malformed key is a client bug, rejected fail-loud
 *      rather than silently treated as "no key".
 *   2. Look up (workspace, user, action, key). A hit inside the
 *      24-hour window returns the STORED response without
 *      re-executing — this is what makes a response-lost retry safe.
 *      Expired rows are pruned on lookup, scoped to the caller.
 *   3. On success only, store (status, body). Error responses are
 *      never stored: a failed request retried with the same key must
 *      execute fresh (a fixed body deserves a real attempt, not a
 *      replayed 400).
 *
 * Error handling is deliberately asymmetric, and getting it
 * backwards reintroduces the bug:
 *   - A LOOKUP failure throws: the request has not executed yet, so
 *     failing it (500) is safe and loud.
 *   - A STORE failure is logged and swallowed: the request already
 *     succeeded, so failing the response would make the client
 *     retry — the exact duplicate this exists to prevent.
 *   - A PRUNE failure is logged and swallowed: housekeeping must
 *     never fail a request (expired rows are also excluded by the
 *     lookup's own expiry filter, so a missed prune is inert).
 *
 * Concurrency note (updated 2026-10-29): there IS now a
 * "processing" state for the destination-queue route, because the
 * composer can send the same key twice concurrently — the queueing
 * lock used to switch on only after an awaited pre-check, so a
 * second click in that window started a second loop, and both
 * lookups missed (neither result stored yet) before both inserted.
 * claimIdempotencyResult inserts a sentinel row (status 102,
 * 5-minute expiry) under the same unique constraint BEFORE the
 * queue insert; a concurrent same-key request sees the conflict
 * and gets 409 instead of a second row. completeIdempotencyResult
 * turns the sentinel into the real result with an UPDATE (never an
 * upsert, which would DO NOTHING against the existing sentinel and
 * leave it processing forever). A sentinel that survives a crashed
 * request expires in 5 minutes and is pruned on the next lookup, so
 * a stuck key never blocks retries forever — and the queue-by-key
 * lookup in the route heals a result whose store failed, so an
 * expired sentinel can never turn into a duplicate either.
 */

export const IDEMPOTENCY_PROCESSING_STATUS = 102;
export const IDEMPOTENCY_PROCESSING_TTL_SECONDS = 5 * 60;

export type IdempotencyClaimResult = 'claimed' | 'already-processing';

export interface IdempotencyScope {
  workspaceId: string;
  userId: string;
  action: IdempotencyAction;
  key: string;
}

export interface StoredIdempotencyResult {
  status: number;
  body: unknown;
}

/** Thrown when the idempotency store cannot be read before execution. */
export class IdempotencyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyStoreError';
  }
}

/**
 * Read and validate the idempotency key header. `key` is null when
 * the header is absent; `invalid` is true when it is present but
 * not a UUID.
 */
export function parseIdempotencyKeyHeader(headers: {
  get(name: string): string | null;
}): { key: string | null; invalid: boolean } {
  const raw = headers.get(IDEMPOTENCY_KEY_HEADER);
  if (raw === null) return { key: null, invalid: false };
  const parsed = IdempotencyKeySchema.safeParse(raw.trim());
  if (!parsed.success) return { key: null, invalid: true };
  return { key: parsed.data, invalid: false };
}

interface IdempotencyRowRaw {
  response_status: number;
  response_body: unknown;
}

async function pruneExpiredIdempotencyKeys(
  client: ConnectDbClient | null | undefined,
  workspaceId: string,
  userId: string
): Promise<void> {
  if (isLegacyClient(client ?? undefined)) {
    await (client as DatabaseClient).query(
      `DELETE FROM idempotency_keys
       WHERE workspace_id = $1 AND user_id = $2 AND expires_at < now()`,
      [workspaceId, userId]
    );
    return;
  }
  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) return;
  await supabase
    .from('idempotency_keys')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .lt('expires_at', new Date().toISOString());
}

/** A sentinel row is a claim, not a result: it must never replay. */
function isProcessingRow(row: IdempotencyRowRaw): boolean {
  if (row.response_status === IDEMPOTENCY_PROCESSING_STATUS) return true;
  const body = row.response_body;
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>).processing === true
  );
}

/**
 * Return the stored result for this key, or null when there is
 * none (or it expired). Throws IdempotencyStoreError when the
 * store cannot be read — callers must fail the request, not
 * execute blindly.
 */
export async function lookupIdempotencyResult(
  client: ConnectDbClient | null | undefined,
  scope: IdempotencyScope
): Promise<StoredIdempotencyResult | null> {
  try {
    await pruneExpiredIdempotencyKeys(client, scope.workspaceId, scope.userId);
  } catch (err) {
    // Housekeeping only — the lookup below still excludes expired
    // rows, so a missed prune is inert. Logged loudly, never fatal.
    logServerError('[idempotency] Failed to prune expired keys', err, {
      source: 'idempotency',
      workspaceId: scope.workspaceId,
      userId: scope.userId,
    });
  }

  try {
    if (isLegacyClient(client ?? undefined)) {
      const rows = (await (client as DatabaseClient).query(
        `SELECT response_status, response_body
         FROM idempotency_keys
         WHERE workspace_id = $1 AND user_id = $2 AND action = $3
           AND idempotency_key = $4 AND expires_at > now()
         LIMIT 1`,
        [scope.workspaceId, scope.userId, scope.action, scope.key]
      )) as IdempotencyRowRaw[];
      const row = rows.at(0);
      if (!row) return null;
      if (isProcessingRow(row)) return null;
      return { status: row.response_status, body: row.response_body };
    }

    const supabase = getRouteSupabase(client ?? undefined);
    if (!supabase) {
      throw new IdempotencyStoreError('Idempotency store unavailable');
    }
    const { data, error } = await supabase
      .from('idempotency_keys')
      .select('response_status, response_body')
      .eq('workspace_id', scope.workspaceId)
      .eq('user_id', scope.userId)
      .eq('action', scope.action)
      .eq('idempotency_key', scope.key)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as IdempotencyRowRaw;
    if (isProcessingRow(row)) return null;
    return { status: row.response_status, body: row.response_body };
  } catch (err) {
    if (err instanceof IdempotencyStoreError) throw err;
    throw new IdempotencyStoreError(
      `Failed to read idempotency key: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  }
}

/**
 * Store a successful response for this key. Never throws: the
 * request already succeeded, so failing here would make the client
 * retry — the duplicate this exists to prevent. Failures are
 * logged loudly instead.
 */
export async function storeIdempotencyResult(
  client: ConnectDbClient | null | undefined,
  scope: IdempotencyScope,
  result: StoredIdempotencyResult
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + IDEMPOTENCY_RETENTION_SECONDS * 1000
  ).toISOString();
  try {
    if (isLegacyClient(client ?? undefined)) {
      await (client as DatabaseClient).query(
        `INSERT INTO idempotency_keys (
           workspace_id, user_id, action, idempotency_key,
           response_status, response_body, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (workspace_id, user_id, action, idempotency_key)
         DO NOTHING`,
        [
          scope.workspaceId,
          scope.userId,
          scope.action,
          scope.key,
          result.status,
          JSON.stringify(result.body),
          expiresAt,
        ]
      );
      return;
    }
    const supabase = getRouteSupabase(client ?? undefined);
    if (!supabase) return;
    const { error } = await supabase.from('idempotency_keys').upsert(
      {
        workspace_id: scope.workspaceId,
        user_id: scope.userId,
        action: scope.action,
        idempotency_key: scope.key,
        response_status: result.status,
        response_body: result.body,
        expires_at: expiresAt,
      },
      {
        onConflict: 'workspace_id,user_id,action,idempotency_key',
        ignoreDuplicates: true,
      }
    );
    if (error) throw error;
  } catch (err) {
    // See the module doc: a store failure after success must never
    // fail the response — that would cause the retry duplicate.
    logServerError('[idempotency] Failed to store idempotency result', err, {
      source: 'idempotency',
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      action: scope.action,
    });
  }
}

/**
 * Atomically claim a key BEFORE executing. Returns 'claimed' when
 * this caller owns the key, 'already-processing' when another
 * in-flight request already claimed it. Throws
 * IdempotencyStoreError when the store cannot be read/written —
 * callers must fail, not execute blindly, because executing without
 * a claim is exactly the duplicate path.
 */
export async function claimIdempotencyResult(
  client: ConnectDbClient | null | undefined,
  scope: IdempotencyScope
): Promise<IdempotencyClaimResult> {
  const expiresAt = new Date(
    Date.now() + IDEMPOTENCY_PROCESSING_TTL_SECONDS * 1000
  ).toISOString();
  try {
    if (isLegacyClient(client ?? undefined)) {
      const rows = (await (client as DatabaseClient).query(
        `INSERT INTO idempotency_keys (
           workspace_id, user_id, action, idempotency_key,
           response_status, response_body, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (workspace_id, user_id, action, idempotency_key)
         DO NOTHING RETURNING id`,
        [
          scope.workspaceId,
          scope.userId,
          scope.action,
          scope.key,
          IDEMPOTENCY_PROCESSING_STATUS,
          JSON.stringify({ processing: true }),
          expiresAt,
        ]
      )) as Array<{ id: string }>;
      return rows.length > 0 ? 'claimed' : 'already-processing';
    }
    const supabase = getRouteSupabase(client ?? undefined);
    if (!supabase) {
      throw new IdempotencyStoreError('Idempotency store unavailable');
    }
    const { data, error } = await supabase
      .from('idempotency_keys')
      .insert({
        workspace_id: scope.workspaceId,
        user_id: scope.userId,
        action: scope.action,
        idempotency_key: scope.key,
        response_status: IDEMPOTENCY_PROCESSING_STATUS,
        response_body: { processing: true },
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (error) {
      const code = (error as { code?: unknown }).code;
      if (code === '23505') return 'already-processing';
      throw error;
    }
    return data ? 'claimed' : 'already-processing';
  } catch (err) {
    if (err instanceof IdempotencyStoreError) throw err;
    throw new IdempotencyStoreError(
      `Failed to claim idempotency key: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  }
}

/**
 * Turn a claimed sentinel into the real result. Returns true when
 * the claim was completed. Never throws: a completion failure after
 * success must not fail the response — the route's queue-by-key
 * lookup heals the missing result on the next retry, and the
 * sentinel expires in 5 minutes in the worst case.
 */
export async function completeIdempotencyResult(
  client: ConnectDbClient | null | undefined,
  scope: IdempotencyScope,
  result: StoredIdempotencyResult
): Promise<boolean> {
  const expiresAt = new Date(
    Date.now() + IDEMPOTENCY_RETENTION_SECONDS * 1000
  ).toISOString();
  try {
    if (isLegacyClient(client ?? undefined)) {
      const rows = (await (client as DatabaseClient).query(
        `UPDATE idempotency_keys
         SET response_status = $1, response_body = $2::jsonb, expires_at = $3
         WHERE workspace_id = $4 AND user_id = $5 AND action = $6
           AND idempotency_key = $7 AND response_status = $8
         RETURNING id`,
        [
          result.status,
          JSON.stringify(result.body),
          expiresAt,
          scope.workspaceId,
          scope.userId,
          scope.action,
          scope.key,
          IDEMPOTENCY_PROCESSING_STATUS,
        ]
      )) as Array<{ id: string }>;
      return rows.length > 0;
    }
    const supabase = getRouteSupabase(client ?? undefined);
    if (!supabase) return false;
    const { data, error } = await supabase
      .from('idempotency_keys')
      .update({
        response_status: result.status,
        response_body: result.body,
        expires_at: expiresAt,
      })
      .eq('workspace_id', scope.workspaceId)
      .eq('user_id', scope.userId)
      .eq('action', scope.action)
      .eq('idempotency_key', scope.key)
      .eq('response_status', IDEMPOTENCY_PROCESSING_STATUS)
      .select('id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    logServerError('[idempotency] Failed to complete idempotency claim', err, {
      source: 'idempotency',
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      action: scope.action,
    });
    return false;
  }
}
