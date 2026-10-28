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
 * Concurrency note: there is no "processing" state. The shipped
 * clients never send the same key concurrently (the composer
 * queues sequentially; publish-now sends one request per tap), so
 * the protection target is the sequential retry — the response-lost
 * case. The unique constraint still guarantees at most one stored
 * result per key.
 */

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
