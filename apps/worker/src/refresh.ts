import {
  DatabaseSocialAccountRowSchema,
  decryptToken,
  encryptToken,
  getTokenRefreshConfig,
  InternalError,
  isTokenRefreshDue,
  PLATFORM_TOKEN_REFRESH_CONFIG,
  ValidationError,
  type DatabaseSocialAccountRow,
  type Platform,
  type Publisher,
  type PublisherRegistry,
  type PublisherTokenSet,
  type RefreshedTokenSet,
} from '@fbuploadpro/contracts';
import { captureWorkerError, captureWorkerEvent, type PostHogEnv } from './analytics.js';

// ==========================================
// Token refresh job (spec 121 Scope 9, D6 DECIDED)
// ==========================================
//
// A SEPARATE scheduled job (cron `*/15 * * * *`, see wrangler.toml) that
// is the ONLY writer of rotated/refreshed tokens in the worker. The
// claimer and the queue consumers contain zero token-refresh calls: an
// auth error at publish time settles the account `expired` via the
// settle RPC, it never triggers a refresh-and-retry (D6).
//
// Per-connection single-flight lease (columns from the sibling spec 121
// migration 20261022130000, PR #649 — this code targets those columns at
// runtime and does not ship the migration): BEFORE any platform call,
// the job acquires the lease with ONE conditional update —
//
//   UPDATE social_accounts
//   SET refresh_lease_owner = <run-scoped uuid>,
//       refresh_lease_expires_at = <acquisition time> + REFRESH_LEASE_TTL_MS
//   WHERE id = <account id>
//     AND (refresh_lease_owner IS NULL OR refresh_lease_expires_at < <acquisition time>)
//
// The acquisition time is read from the wall clock AT THE MOMENT of
// the acquire (`new Date()` inside `tryAcquireLease`), never from the
// cycle-start snapshot: in a long cycle a lease minted from the stale
// snapshot would be part-expired on arrival, letting a concurrent run
// steal it mid-refresh and double-spend a rotating refresh token.
//
// Exactly one concurrent run can affect the row, so exactly one run can
// spend a given refresh token. A run that affects 0 rows skips the
// account silently (counted as skipped-lease). Every later write in the
// cycle (persist, expire, release) is additionally guarded by
// `refresh_lease_owner = <run id>`, so a run can only ever touch its
// own lease.
//
// Atomic persist invariant: on a successful refresh the job writes
// {new encrypted access token, new encrypted refresh token, new
// token_expires_at, lease released} as ONE update, before any other
// code can use the new tokens. X's refresh tokens are single-use and
// rotating, which makes the window between the platform call and this
// persist the known-loss window: if the worker crashes (or the persist
// itself fails) after the platform spent the old refresh token, the
// database still stores that now-spent token. The lease is left to
// expire (REFRESH_LEASE_TTL_MS) rather than being released, and the
// next run that re-acquires the lease retries with the spent token,
// receives `invalid_grant`, and marks the account `expired` for
// re-authentication. That is inherent to single-use rotation — the
// connection is honestly dead at the platform — not a state this job
// can recover from or should hide.
//
// Failure semantics:
//   - Refresh failure classified `auth` (or code `invalid_grant`) via
//     the publisher's `mapError`: the account is set `status='expired'`
//     in one update that also releases the lease, a PostHog $exception
//     is raised, and the job never retry-loops — later scans only read
//     `status='active'` rows, so an expired account is never revisited.
//   - Any other refresh failure (retryable or otherwise non-auth): the
//     lease is released, the stored tokens are left untouched, the
//     failure is captured to PostHog (`refresh_transient_failed`), and
//     the account is counted deferred — the next scheduled run retries.
//   - A token DECRYPT failure is classified separately from platform
//     refresh failures (`refresh_decrypt_failed` + the error class):
//     the publisher is never called, because the failure is in our own
//     stored ciphertext / key, not at the platform — a corrupt
//     ciphertext must be distinguishable from a platform outage. Its
//     retry semantics are otherwise the transient ones above (lease
//     released, tokens untouched, counted deferred).
//   - A persist failure after a successful platform refresh is logged
//     loudly + captured to PostHog and counted deferred; the lease is
//     deliberately NOT released (its expiry is the backstop) — see the
//     crash-window note above for what the next run then observes.
//   - DB errors on the scan or on a lease acquire (e.g. the lease
//     columns are not migrated yet) ABORT the cycle with a thrown
//     error after a loud log + PostHog capture. The job never treats a
//     schema/DB failure as a platform auth failure, so it can never
//     silently mark accounts `expired` because of its own plumbing.
//
// Scan: BOUNDED and due-windowed (spec 139). The query carries a
// due-window predicate — `token_expires_at <= cycle now + horizon`,
// where the horizon is the widest per-platform refresh threshold in
// the contracts config (currently the 7-day long-lived / lapse
// threshold) — so rows that cannot possibly be due are never read.
// (Rows with no recorded expiry are excluded by the same predicate:
// `isTokenRefreshDue` never fires without an expiry.) Pages are
// fetched keyset-style, ordered by `id` with a `id > last-seen`
// cursor, REFRESH_SCAN_PAGE_SIZE rows at a time, and a cycle stops
// after REFRESH_SCAN_MAX_ACCOUNTS_PER_CYCLE scanned rows; anything
// beyond the bound is picked up by a later cycle. Per-account due-ness
// is still decided in code by `isTokenRefreshDue` (the query window is
// the superset across platforms; the per-platform thresholds and the
// minimum-age rule are finer than any single SQL predicate).
//
// Backlog signal (spec 139 residue, CTO ceiling #1): stopping AT the
// cap is ambiguous — the due window may be exactly exhausted, or a
// backlog may extend past the cap and defer silently cycle after
// cycle. When a cycle ends at the cap, the job probes ONE row past
// the last scanned id under the same window predicates. A hit sets
// `scanTruncated` on the result and fires the backlog signal on the
// channels this job already reports through — a structured warn log
// line with the cycle counts and a PostHog `refresh_backlog_beyond_cap`
// event (refresh deliberately owns no heartbeat row; see index.ts) —
// so a backlog outgrowing the cap is visible the cycle it happens,
// not discovered when tokens start lapsing. A probe failure is itself
// captured + logged; it never aborts a cycle whose refresh work
// already succeeded, and it never fabricates a truncation claim.
//
// Scan scope: `social_accounts` only. `destinations` carries
// `encrypted_destination_token` but the unified schema gives it NO
// expiry signal (no token_expires_at column and no expiry key defined
// in `metadata`), so there is nothing truthful to compute due-ness
// from for destination tokens — Facebook Page tokens ride on the
// account-level user token, whose lapse is detected on the account
// row. The destinations lease columns exist for a future
// destination-scoped refresher; this job does not invent a column.
//
// Due-ness: computed with the contracts `isTokenRefreshDue(platform,
// snapshot, now)`. The snapshot needs `tokenIssuedAt` for the
// Instagram/Threads minimum-age rule (token must be >= 24 h old), but
// `social_accounts` has no issued-at column, so it is DERIVED as
// `token_expires_at - accessTokenLifetimeSeconds` when the platform
// config fixes a lifetime (Instagram/Threads: 60 days; X: ~2 h), and
// falls back to the row's `updated_at` (the last write to the row,
// which includes the last refresh persist) when it does not. The
// derivation is conservative in the safe direction: with the 7-day
// refresh threshold against a 60-day lifetime, a due token is ~53+
// days old under either derivation, far past the 24 h minimum age.
//
// Facebook is lapse-detection only (contracts strategy
// 'lapse-detection'): there is no refresh grant to spend, so this job
// NEVER calls a publisher for a Facebook account — even if one were
// registered. `isTokenRefreshDue` opens the lapse check once expiry is
// within the 7-day threshold, but the status flip fires only when
// `token_expires_at` has actually passed: a still-valid token inside
// the window stays `active` and is re-checked on later runs. The flip
// is a conditional update on `status='active'`, which is idempotent
// and race-safe on its own, so Facebook rows deliberately do NOT take
// the lease.
//
// Platforms with no registered publisher (ALL platforms in this PR —
// the registry is empty until specs 122/124–127 land) are skipped
// before any lease or platform call: the job runs cleanly and reports
// zero refreshed. Provider-managed platforms (YouTube/TikTok) are
// never due per the contracts config.

/** Cron expression for the token-refresh job (wrangler.toml triggers). */
export const TOKEN_REFRESH_CRON = '*/15 * * * *';

/** Cron expression for the claimer tick (wrangler.toml triggers). */
export const CLAIM_TICK_CRON = '* * * * *';

/** How long a per-connection refresh lease is held before another run may take it over. */
export const REFRESH_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Due-window horizon for the scan query, in seconds: the widest
 * `refreshWhenExpiringWithinSeconds` across the contracts per-platform
 * config (currently 7 days — Instagram/Threads/Facebook). Derived from
 * the config, not restated, so widening a platform threshold widens
 * the scan window with it.
 */
export const REFRESH_DUE_WINDOW_SECONDS = Math.max(
  ...Object.values(PLATFORM_TOKEN_REFRESH_CONFIG).map(
    (config) => config.refreshWhenExpiringWithinSeconds ?? 0
  )
);

/** Rows fetched per scan page (keyset pagination on `id`). */
export const REFRESH_SCAN_PAGE_SIZE = 100;

/** Per-cycle work bound: a cycle scans at most this many due-window rows. */
export const REFRESH_SCAN_MAX_ACCOUNTS_PER_CYCLE = 500;

/**
 * PostHog event fired when a cycle's scan is truncated by the
 * per-cycle cap with eligible accounts still beyond it (spec 139
 * residue). Stateless per cycle: a later cycle that covers the
 * backlog fires nothing, which is what "cleared" means for it.
 */
export const REFRESH_BACKLOG_EVENT = 'refresh_backlog_beyond_cap';

/** Optional scan-bound overrides (tests use these to exercise pagination cheaply). */
export interface RefreshCycleOptions {
  pageSize?: number;
  maxAccountsPerCycle?: number;
}

function saneBound(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export interface RefreshEnv extends PostHogEnv {
  TOKEN_ENCRYPTION_KEY?: string;
}

/** One DB result from the refresh job's Supabase-shaped client. */
export interface RefreshDbResult {
  data: unknown;
  error: unknown;
}

export interface RefreshSelectQuery extends PromiseLike<RefreshDbResult> {
  eq(column: string, value: unknown): RefreshSelectQuery;
  lte(column: string, value: unknown): RefreshSelectQuery;
  gt(column: string, value: unknown): RefreshSelectQuery;
  order(column: string, options: { ascending: boolean }): RefreshSelectQuery;
  limit(count: number): RefreshSelectQuery;
}

export interface RefreshUpdateQuery extends PromiseLike<RefreshDbResult> {
  eq(column: string, value: unknown): RefreshUpdateQuery;
  or(filter: string): RefreshUpdateQuery;
  select(columns?: string): RefreshUpdateQuery;
}

export interface RefreshTableQuery {
  select(columns: string): RefreshSelectQuery;
  update(values: Record<string, unknown>): RefreshUpdateQuery;
}

/**
 * The slice of the Supabase client the refresh job uses. Every update
 * ends in `.select('id')` so the affected-row count is observable —
 * that count IS the lease protocol's win/lose signal.
 */
export interface RefreshDbClient {
  from(table: string): RefreshTableQuery;
}

/** Structured per-cycle counters (logged on every run). */
export interface RefreshCycleResult {
  /** Due-window accounts returned by the bounded, paginated scan. */
  scanned: number;
  /** Scanned accounts that were eligible and due (incl. lapsed Facebook). */
  due: number;
  /** Accounts whose tokens were refreshed and atomically persisted. */
  refreshed: number;
  /** Due accounts skipped because another live run holds the lease. */
  skippedLease: number;
  /** Due accounts deferred to the next run (transient failure / persist failure). */
  deferredTransient: number;
  /** Accounts flipped to `status='expired'` (auth failure or Facebook lapse). */
  expired: number;
  /** The effective per-cycle scan cap this cycle ran under. */
  scanCap: number;
  /**
   * True when the scan stopped at `scanCap` AND the one-row probe past
   * the last scanned id confirmed more due-window accounts remain
   * unscanned — the backlog exceeds one cycle's coverage and the
   * remainder defers to later cycles (see the backlog-signal note in
   * the header). False whenever the scan exhausted the due window,
   * including when it ends exactly at the cap with nothing behind it.
   */
  scanTruncated: boolean;
}

/** Social-account row fields the refresh job reads (subset of the full row). */
interface RefreshAccountRow extends DatabaseSocialAccountRow {
  refresh_lease_owner?: string | null;
  refresh_lease_expires_at?: string | null;
}

function dbError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function runUpdate(
  db: RefreshDbClient,
  build: (table: RefreshTableQuery) => RefreshUpdateQuery
): Promise<Record<string, unknown>[]> {
  const { data, error } = await build(db.from('social_accounts'));
  if (error) throw dbError(error);
  return (Array.isArray(data) ? data : []) as Record<string, unknown>[];
}

/** Derives the snapshot's issued-at for the minimum-age rule (see header). */
function deriveTokenIssuedAt(row: RefreshAccountRow, platform: Platform): string | null {
  const config = getTokenRefreshConfig(platform);
  if (row.token_expires_at && config.accessTokenLifetimeSeconds !== null) {
    const expiresMs = new Date(row.token_expires_at).getTime();
    if (!Number.isNaN(expiresMs)) {
      return new Date(expiresMs - config.accessTokenLifetimeSeconds * 1000).toISOString();
    }
  }
  return row.updated_at;
}

/**
 * Boundary validation (spec 139 B15): every scanned `social_accounts`
 * row is validated ONCE, at load, against the contracts row schema. A
 * malformed row is a schema/DB failure of the job's own plumbing —
 * captured to PostHog and thrown as a typed `ValidationError`, aborting
 * the cycle loudly (the same semantics as a scan DB error). It is never
 * silently skipped, and it can never be misread as a platform auth
 * failure, so no account is marked `expired` because of it. The refresh
 * lease columns are this job's own bookkeeping (not part of the
 * contracts row) and ride along unvalidated.
 */
function validateScanAccountRow(raw: Record<string, unknown>, env: RefreshEnv): RefreshAccountRow {
  const result = DatabaseSocialAccountRowSchema.safeParse(raw);
  if (!result.success) {
    const validationError = new ValidationError(
      'Malformed social_accounts row failed boundary validation',
      { issues: result.error.issues }
    );
    captureWorkerError(env, validationError, {
      site: 'runRefreshCycle',
      kind: 'scan_row_validation_failed',
      accountId: typeof raw.id === 'string' ? raw.id : null,
    });
    console.error(
      '[refresh] malformed social_accounts row failed boundary validation; aborting cycle:',
      result.error.issues
    );
    throw validationError;
  }
  return {
    ...result.data,
    refresh_lease_owner: typeof raw.refresh_lease_owner === 'string' ? raw.refresh_lease_owner : null,
    refresh_lease_expires_at:
      typeof raw.refresh_lease_expires_at === 'string' ? raw.refresh_lease_expires_at : null,
  };
}

function isDue(row: RefreshAccountRow, now: Date): boolean {
  return isTokenRefreshDue(
    row.platform,
    { tokenExpiresAt: row.token_expires_at, tokenIssuedAt: deriveTokenIssuedAt(row, row.platform) },
    now
  );
}

/**
 * Acquires the per-connection lease; true when this run won the row.
 *
 * Expiry AND the takeover comparison are computed from the actual
 * acquisition moment (`new Date()` here), NOT from the cycle-start
 * snapshot — see the header note on part-expired leases.
 */
async function tryAcquireLease(
  db: RefreshDbClient,
  accountId: string,
  runId: string
): Promise<boolean> {
  const acquiredAt = new Date();
  const leaseExpiresAt = new Date(acquiredAt.getTime() + REFRESH_LEASE_TTL_MS).toISOString();
  const nowIso = acquiredAt.toISOString();
  const rows = await runUpdate(db, (table) =>
    table
      .update({ refresh_lease_owner: runId, refresh_lease_expires_at: leaseExpiresAt })
      .eq('id', accountId)
      .or(`refresh_lease_owner.is.null,refresh_lease_expires_at.lt.${nowIso}`)
      .select('id')
  );
  return rows.length > 0;
}

/** Releases this run's lease without touching tokens or status. */
async function releaseLease(
  db: RefreshDbClient,
  accountId: string,
  runId: string
): Promise<void> {
  await runUpdate(db, (table) =>
    table
      .update({ refresh_lease_owner: null, refresh_lease_expires_at: null })
      .eq('id', accountId)
      .eq('refresh_lease_owner', runId)
      .select('id')
  );
}

/**
 * Expiry propagation (Facebook Accounts audit, BG2/BG4): flip an
 * expired account's 'active' destinations to 'error' — the existing
 * destination status for a broken token, so no new page status is
 * introduced. Idempotent (active-only), so re-running it is safe, and
 * paused (disconnected + fb_status marker), plain disconnected,
 * already-'error', and 'rate_limited' destinations are untouched by
 * construction. Best-effort by design: a failure here is logged and
 * never thrown, because the database trigger (companion migration)
 * fires on the account flip itself and makes the same flip — this
 * helper exists so propagation also happens before that migration
 * is applied, and so the job's own tests can observe it.
 */
export async function propagateExpiredDestinations(
  db: RefreshDbClient,
  accountId: string
): Promise<number> {
  const { data, error } = await db
    .from('destinations')
    .update({ status: 'error' })
    .eq('account_id', accountId)
    .eq('status', 'active')
    .select('id');
  if (error) throw dbError(error);
  return Array.isArray(data) ? data.length : 0;
}

async function propagateExpiredDestinationsBestEffort(
  db: RefreshDbClient,
  accountId: string
): Promise<void> {
  try {
    await propagateExpiredDestinations(db, accountId);
  } catch (err) {
    console.error(
      `[refresh] failed to propagate expired destinations for account ${accountId}:`,
      err
    );
  }
}

/** Flips a lease-holding account to `expired` and releases the lease in one update. */
async function markExpiredHoldingLease(
  db: RefreshDbClient,
  accountId: string,
  runId: string
): Promise<void> {
  await runUpdate(db, (table) =>
    table
      .update({ status: 'expired', refresh_lease_owner: null, refresh_lease_expires_at: null })
      .eq('id', accountId)
      .eq('refresh_lease_owner', runId)
      .select('id')
  );
  await propagateExpiredDestinationsBestEffort(db, accountId);
}

/**
 * Facebook lapse flip: a pure status change, conditional on the row
 * still being `active`, so concurrent runs converge without a lease.
 */
async function markFacebookLapsed(db: RefreshDbClient, accountId: string): Promise<boolean> {
  const rows = await runUpdate(db, (table) =>
    table.update({ status: 'expired' }).eq('id', accountId).eq('status', 'active').select('id')
  );
  if (rows.length > 0) {
    await propagateExpiredDestinationsBestEffort(db, accountId);
  }
  return rows.length > 0;
}

interface RefreshAccountContext {
  db: RefreshDbClient;
  registry: PublisherRegistry;
  env: RefreshEnv;
  masterKey: string;
  runId: string;
  result: RefreshCycleResult;
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

async function refreshOneAccount(
  ctx: RefreshAccountContext,
  row: RefreshAccountRow,
  publisher: Publisher
): Promise<void> {
  const { db, env, masterKey, runId, result } = ctx;

  let acquired: boolean;
  try {
    acquired = await tryAcquireLease(db, row.id, runId);
  } catch (err) {
    // A lease-acquire failure is the job's own plumbing (e.g. lease
    // columns not yet migrated) — fail the whole cycle loudly rather
    // than misreading it as anything about this account.
    captureWorkerError(env, err, { site: 'runRefreshCycle', kind: 'lease_acquire_failed', accountId: row.id, platform: row.platform });
    console.error(`[refresh] lease acquire failed for account ${row.id} (${row.platform}); aborting cycle:`, err);
    throw err;
  }
  if (!acquired) {
    result.skippedLease++;
    return;
  }

  // Decrypt is its OWN step, classified separately from platform
  // refresh failures: a failure here means our stored ciphertext (or
  // key) is bad — the publisher is never called and its `mapError`
  // never sees the error. Retry semantics stay the transient ones:
  // lease released, stored tokens untouched, counted deferred.
  let tokens: PublisherTokenSet;
  try {
    tokens = {
      accessToken: await decryptToken(row.encrypted_access_token, masterKey),
      refreshToken: row.encrypted_refresh_token
        ? await decryptToken(row.encrypted_refresh_token, masterKey)
        : null,
      tokenExpiresAt: row.token_expires_at ?? null,
    };
  } catch (err) {
    captureWorkerError(env, err, { site: 'runRefreshCycle', kind: 'refresh_decrypt_failed', accountId: row.id, platform: row.platform, errorClass: errorClass(err) });
    console.error(
      `[refresh] account ${row.id} (${row.platform}) token decrypt failed (${errorClass(err)}); refresh deferred, publisher not called:`,
      err
    );
    try {
      await releaseLease(db, row.id, runId);
    } catch (releaseErr) {
      captureWorkerError(env, releaseErr, { site: 'runRefreshCycle', kind: 'lease_release_failed', accountId: row.id, platform: row.platform });
      console.error(`[refresh] failed to release lease for account ${row.id} (${row.platform}) after decrypt failure:`, releaseErr);
    }
    result.deferredTransient++;
    return;
  }

  let refreshedTokens: RefreshedTokenSet;
  try {
    refreshedTokens = await publisher.refreshTokens(row, tokens);
  } catch (err) {
    const classified = publisher.mapError(err);
    const isAuthFailure =
      classified.kind === 'auth' || classified.code.toLowerCase().includes('invalid_grant');
    if (isAuthFailure) {
      try {
        await markExpiredHoldingLease(db, row.id, runId);
      } catch (expireErr) {
        captureWorkerError(env, expireErr, { site: 'runRefreshCycle', kind: 'mark_expired_failed', accountId: row.id, platform: row.platform });
        console.error(`[refresh] failed to mark account ${row.id} (${row.platform}) expired after auth failure:`, expireErr);
        throw expireErr;
      }
      result.expired++;
      captureWorkerError(env, err, { site: 'runRefreshCycle', kind: 'refresh_auth_failed', accountId: row.id, platform: row.platform, code: classified.code });
      console.error(
        `[refresh] account ${row.id} (${row.platform}) marked expired: token refresh failed with auth error ${classified.code}: ${classified.message}`
      );
      return;
    }
    // Transient / non-auth failure: release the lease, leave the stored
    // tokens untouched, capture to PostHog (this branch was previously
    // console-only, so transient platform failures were invisible in
    // error tracking), and let the next scheduled run retry.
    captureWorkerError(env, err, { site: 'runRefreshCycle', kind: 'refresh_transient_failed', accountId: row.id, platform: row.platform, code: classified.code, classifiedKind: classified.kind, errorClass: errorClass(err) });
    try {
      await releaseLease(db, row.id, runId);
    } catch (releaseErr) {
      captureWorkerError(env, releaseErr, { site: 'runRefreshCycle', kind: 'lease_release_failed', accountId: row.id, platform: row.platform });
      console.error(`[refresh] failed to release lease for account ${row.id} (${row.platform}) after transient failure:`, releaseErr);
    }
    result.deferredTransient++;
    console.warn(
      `[refresh] account ${row.id} (${row.platform}) refresh deferred (${classified.kind}/${classified.code}): ${classified.message}`
    );
    return;
  }

  // Atomic persist: new tokens + new expiry + lease release in ONE
  // update, owner-guarded, before any other code can use the tokens.
  try {
    const encryptedAccessToken = await encryptToken(refreshedTokens.accessToken, masterKey);
    const encryptedRefreshToken = refreshedTokens.refreshToken
      ? await encryptToken(refreshedTokens.refreshToken, masterKey)
      : row.encrypted_refresh_token;
    const rows = await runUpdate(db, (table) =>
      table
        .update({
          encrypted_access_token: encryptedAccessToken,
          encrypted_refresh_token: encryptedRefreshToken,
          token_expires_at: refreshedTokens.tokenExpiresAt ?? row.token_expires_at,
          refresh_lease_owner: null,
          refresh_lease_expires_at: null,
        })
        .eq('id', row.id)
        .eq('refresh_lease_owner', runId)
        .select('id')
    );
    if (rows.length === 0) {
      throw new InternalError('persist matched no row — the refresh lease was lost before persist');
    }
  } catch (err) {
    // The platform may already have spent the old refresh token (X
    // rotation): see the crash-window note in the header. Loud, counted
    // deferred, lease left to expire as the backstop — never expired
    // here on a guess.
    captureWorkerError(env, err, { site: 'runRefreshCycle', kind: 'refresh_persist_failed', accountId: row.id, platform: row.platform });
    console.error(
      `[refresh] CRITICAL: failed to persist refreshed tokens for account ${row.id} (${row.platform}) after a successful platform refresh:`,
      err
    );
    result.deferredTransient++;
    return;
  }

  result.refreshed++;
}

/**
 * Runs one token-refresh cycle: scan active social accounts, refresh
 * the due ones through their registered publisher under the
 * per-connection lease, and lapse-detect Facebook accounts.
 */
export async function runRefreshCycle(
  db: RefreshDbClient,
  registry: PublisherRegistry,
  env: RefreshEnv,
  now: Date = new Date(),
  options: RefreshCycleOptions = {}
): Promise<RefreshCycleResult> {
  const masterKey = env.TOKEN_ENCRYPTION_KEY;
  if (!masterKey) {
    throw new InternalError('TOKEN_ENCRYPTION_KEY is not configured; cannot run token refresh cycle');
  }

  const result: RefreshCycleResult = {
    scanned: 0,
    due: 0,
    refreshed: 0,
    skippedLease: 0,
    deferredTransient: 0,
    expired: 0,
    scanCap: saneBound(options.maxAccountsPerCycle, REFRESH_SCAN_MAX_ACCOUNTS_PER_CYCLE),
    scanTruncated: false,
  };
  const runId = crypto.randomUUID();

  const pageSize = saneBound(options.pageSize, REFRESH_SCAN_PAGE_SIZE);
  const maxAccountsPerCycle = result.scanCap;
  // Due-window predicate: only rows expiring within the widest
  // platform refresh horizon can be due this cycle (see header).
  const dueBeforeIso = new Date(now.getTime() + REFRESH_DUE_WINDOW_SECONDS * 1000).toISOString();

  let cursor: string | null = null;
  while (result.scanned < maxAccountsPerCycle) {
    const pageLimit = Math.min(pageSize, maxAccountsPerCycle - result.scanned);
    let query = db
      .from('social_accounts')
      .select('*')
      .eq('status', 'active')
      .lte('token_expires_at', dueBeforeIso);
    if (cursor !== null) {
      query = query.gt('id', cursor);
    }
    const { data, error } = await query.order('id', { ascending: true }).limit(pageLimit);
    if (error) {
      captureWorkerError(env, error, { site: 'runRefreshCycle', kind: 'scan_failed' });
      console.error('[refresh] failed to scan social_accounts; aborting cycle:', error);
      throw dbError(error);
    }
    const rawRows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
    const rows = rawRows.map((raw) => validateScanAccountRow(raw, env));
    if (rows.length === 0) break;
    result.scanned += rows.length;
    const lastRow = rows[rows.length - 1];
    if (lastRow) cursor = lastRow.id;

    for (const row of rows) {
      const config = getTokenRefreshConfig(row.platform);

      if (config.strategy === 'lapse-detection') {
        // Facebook: no refresh call ever. The flip fires only once the
        // token has actually lapsed (see header).
        if (!isDue(row, now)) continue;
        if (!row.token_expires_at || new Date(row.token_expires_at).getTime() > now.getTime()) {
          continue;
        }
        result.due++;
        if (await markFacebookLapsed(db, row.id)) {
          result.expired++;
          console.warn(`[refresh] facebook account ${row.id} marked expired: user token lapsed`);
        }
        continue;
      }

      // Refreshable platforms need a stored refresh token to spend.
      if (!row.encrypted_refresh_token) continue;
      if (!isDue(row, now)) continue;
      result.due++;

      const publisher = registry.get(row.platform);
      if (!publisher) continue; // No module registered yet — by design (specs 122/124–127).

      await refreshOneAccount({ db, registry, env, masterKey, runId, result }, row, publisher);
    }

    if (rows.length < pageLimit) break;
  }

  // Backlog probe (see the header's backlog-signal note): reaching
  // this point with `scanned` at the cap means every page came back
  // full — the window may or may not continue past the last scanned
  // id. One keyset probe row settles it. (A short or empty page breaks
  // the loop with `scanned` strictly below the cap, so the probe runs
  // exactly when truncation is possible.)
  if (result.scanned >= maxAccountsPerCycle && cursor !== null) {
    try {
      const { data, error } = await db
        .from('social_accounts')
        .select('id')
        .eq('status', 'active')
        .lte('token_expires_at', dueBeforeIso)
        .gt('id', cursor)
        .order('id', { ascending: true })
        .limit(1);
      if (error) throw dbError(error);
      result.scanTruncated = Array.isArray(data) && data.length > 0;
    } catch (err) {
      captureWorkerError(env, err, {
        site: 'runRefreshCycle',
        kind: 'refresh_backlog_probe_failed',
        scanned: result.scanned,
        scanCap: maxAccountsPerCycle,
      });
      console.error(
        '[refresh] backlog probe failed; whether the scan was truncated is unknown for this cycle:',
        err
      );
    }
  }

  if (result.scanTruncated) {
    console.warn(
      `[refresh] BACKLOG beyond per-cycle scan cap: scanned=${result.scanned} cap=${maxAccountsPerCycle} ` +
        `due=${result.due} refreshed=${result.refreshed} deferred-transient=${result.deferredTransient} expired=${result.expired} — ` +
        `eligible due-window accounts remain unscanned and defer to later cycles`
    );
    captureWorkerEvent(env, REFRESH_BACKLOG_EVENT, {
      site: 'runRefreshCycle',
      scanned: result.scanned,
      scanCap: maxAccountsPerCycle,
      due: result.due,
      refreshed: result.refreshed,
      skippedLease: result.skippedLease,
      deferredTransient: result.deferredTransient,
      expired: result.expired,
    });
  }

  console.info(
    `[refresh] cycle scanned=${result.scanned} due=${result.due} refreshed=${result.refreshed} ` +
      `skipped-lease=${result.skippedLease} deferred-transient=${result.deferredTransient} expired=${result.expired} ` +
      `scan-truncated=${result.scanTruncated}`
  );
  return result;
}
