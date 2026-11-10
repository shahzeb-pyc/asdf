import {
  ADU_GENERIC_BACKEND_MESSAGE,
  ADU_INVALID_TOKEN_DECISION,
  ADU_MAX_PUBLISH_RETRIES,
  ADU_SKIP_FAILED_24H,
  ADU_STALE_PUBLISHING_SECONDS,
  evaluateAduPublishError,
  FB_RATE_LIMITED_COOLDOWN_MS,
  InternalError,
  localTimeInTimezone,
  type AduPublishErrorDecision,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherRegistry,
  type PublishOutcome,
} from '@fbuploadpro/contracts';
import { decryptToken } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workspaceCanPublishForDestination } from './entitlement.js';

/**
 * ADU worker tick — schedule intake + reel publish, on the minute tick.
 *
 * This is deliberately separate from the unified queue claimer: ADU
 * jobs live in adu_posting_jobs (not queue_items), with their own
 * schedule-slot dedupe, retry budget (max 5) and Graph-ID recording.
 * Publishing reuses the EXISTING publishers from the registry — no
 * publisher is duplicated here. The publisher is chosen per job by
 * destination platform (Facebook jobs → Facebook, Threads jobs →
 * Threads, Instagram jobs → Instagram); see the Publish section below.
 *
 * Safety: if the ADU tables do not exist yet (migration unapplied),
 * the first query fails and the tick returns { skipped: true } without
 * throwing, so the normal claim tick and heartbeat are never broken by
 * an unapplied ADU migration. Every other failure is caught by the
 * caller (handleScheduled) and logged, never swallowed silently here
 * except the missing-table case.
 */

export interface AduTickDb {
  from: SupabaseClient['from'];
}

export interface AduTickResult {
  skipped?: boolean;
  intakeJobsCreated: number;
  intakeCompleted: number;
  published: number;
  failed: number;
  retried: number;
}

interface AduConfigRow {
  id: string;
  workspace_id: string;
  destination_id: string;
  timezone: string;
  posts_per_day: number;
  posting_times: string[];
  status: string;
  sync_status: string;
}

function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01';
}

/**
 * Formats a publish outcome's failure for the adu_posting_jobs row.
 *
 * The queue settles the outcome's `detail` — the failing phase, HTTP
 * status, Facebook's raw body, and both upload attempts — into
 * publish_logs.detail, but ADU has no publish_logs row, and this tick
 * used to store only `outcome.error` here. The real reason was dropped
 * and the row kept only the bare HTTP status (code `unknown`, message
 * "Facebook Graph API error: HTTP 400") — the exact signature of the
 * 115 failed ADU posts diagnosed 2026-11-08. The detail is folded
 * into last_error_message instead: no migration, the row already has
 * the two text columns, and the Failed Posts Reasons UI reads them
 * unchanged. Classification is untouched — code, kind, and the auth
 * cascade all still read outcome.error; this only appends the
 * diagnostic the publisher already computed.
 */
function aduFailureFields(
  outcome: PublishOutcome,
  fallback: { code: string | null; message: string | null },
): { code: string | null; message: string | null } {
  const error = outcome.error;
  const code = error?.code ?? fallback.code;
  let message = error?.message ?? fallback.message;
  const parts: string[] = [];
  const detail = outcome.detail;
  if (detail !== undefined) {
    if (typeof detail.phase === 'string' && detail.phase.length > 0) {
      parts.push(`phase=${detail.phase}`);
    }
    if (typeof detail.httpStatus === 'number') {
      parts.push(`http=${detail.httpStatus}`);
    }
    if (error?.subcode !== undefined) parts.push(`subcode=${error.subcode}`);
    if (typeof detail.rawBody === 'string' && detail.rawBody.length > 0) {
      // Single line: a raw Facebook body must never span lines in the
      // stored reason (same 500-char truncation the client applies).
      parts.push(`body=${detail.rawBody.replace(/[\r\n]+/g, ' ')}`);
    }
    if (Array.isArray(detail.attempts)) {
      const summary = detail.attempts
        .map((attempt: unknown) => {
          const record = attempt as Record<string, unknown>;
          const mode = typeof record.mode === 'string' ? record.mode : '?';
          const status =
            typeof record.httpStatus === 'number' ? String(record.httpStatus) : 'unknown';
          return `${mode}:${status}`;
        })
        .join(',');
      parts.push(`attempts=[${summary}]`);
    }
  } else if (error?.subcode !== undefined) {
    parts.push(`subcode=${error.subcode}`);
  }
  if (parts.length > 0 && message !== null) message += ` [${parts.join(' ')}]`;
  return { code, message };
}

// Bounded page size for every tick scan: no tick query ever loads a
// whole table. Keyset pagination (order by id, gt last id) is used so
// rows that change status mid-tick cannot shift the page window and
// get skipped, the way offset paging would skip them.
export const ADU_TICK_PAGE_SIZE = 500;

// Retention for adu_posting_jobs (SEND BACK fix): the table used to
// grow forever — the old worker retention cleans only queue_items /
// publish_logs. Settled jobs older than this window are deleted once
// per tick. What is preserved: every pending/publishing job, every
// job younger than the window (so Failed Posts Reasons, which shows
// the latest 50 failed jobs per config, always has its recent
// failures), and all adu_reels rows (never pruned here).
export const ADU_JOB_RETENTION_DAYS = 90;

const ADU_SETTLED_JOB_STATUSES = [
  'published',
  'failed_to_publish',
  'publish_error',
  'integrity_error',
];

/** The terminally-failed job statuses: a reel with one of these jobs is terminal. */
const ADU_TERMINAL_FAILED_JOB_STATUSES = [
  'failed_to_publish',
  'publish_error',
  'integrity_error',
];

/**
 * Marks a reel terminally failed after its job settles terminally, so
 * it stops blocking the config completing. A reel-update failure is
 * logged loudly (code + reel + job) and does NOT fail the tick — the
 * job row already settled, and the §3.5 Pending formula plus the
 * completed-check exclusion below cover the reel until it is fixed.
 * Guarded to 'processing' so a race can never flip a posted reel.
 */
async function markAduReelFailed(
  supabase: SupabaseClient,
  reelId: string,
  jobId: string,
): Promise<void> {
  const { error } = await supabase
    .from('adu_reels')
    .update({ status: 'failed' })
    .eq('id', reelId)
    .eq('status', 'processing');
  if (error) {
    console.error(
      `ADU terminal reel update failed: reel=${reelId} job=${jobId} code=${error.code ?? 'unknown'} ${error.message}`,
    );
  }
}

/**
 * Invalid-token cascade: flip every currently-'active' destination
 * under the account to 'error', and every currently-'active' ADU
 * config under those destinations to 'invalid_token'. Rows already in
 * an error / paused / rate-limited / checkpoint status keep their own
 * status — their own recovery path applies. Keyset pages of 500; a
 * load failure is logged loudly and stops the cascade, never the tick.
 * (At most one config per destination — unique index on
 * destination_id — so one config page covers one destination page.)
 */
async function cascadeInvalidToken(
  supabase: SupabaseClient,
  accountId: string,
): Promise<void> {
  let lastDestinationId: string | null = null;
  for (;;) {
    let destQuery = supabase
      .from('destinations')
      .select('id')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .order('id', { ascending: true })
      .limit(ADU_TICK_PAGE_SIZE);
    if (lastDestinationId) destQuery = destQuery.gt('id', lastDestinationId);
    const { data: destBatch, error: destError } = await destQuery;
    if (destError) {
      console.error(
        `ADU invalid-token cascade destination load failed: account=${accountId} code=${destError.code ?? 'unknown'}`,
      );
      return;
    }
    const dests = (destBatch ?? []) as Array<{ id: string }>;
    if (dests.length === 0) break;
    for (const dest of dests) {
      const { error } = await supabase
        .from('destinations')
        .update({ status: 'error' })
        .eq('id', dest.id)
        .eq('status', 'active');
      if (error) {
        console.error(
          `ADU invalid-token cascade destination flip failed: destination=${dest.id} code=${error.code ?? 'unknown'}`,
        );
      }
    }
    let lastConfigId: string | null = null;
    for (;;) {
      let configQuery = supabase
        .from('adu_configs')
        .select('id')
        .in(
          'destination_id',
          dests.map((d) => d.id),
        )
        .eq('status', 'active')
        .order('id', { ascending: true })
        .limit(ADU_TICK_PAGE_SIZE);
      if (lastConfigId) configQuery = configQuery.gt('id', lastConfigId);
      const { data: configBatch, error: configError } = await configQuery;
      if (configError) {
        console.error(
          `ADU invalid-token cascade config load failed: account=${accountId} code=${configError.code ?? 'unknown'}`,
        );
        break;
      }
      const configs = (configBatch ?? []) as Array<{ id: string }>;
      for (const config of configs) {
        const { error } = await supabase
          .from('adu_configs')
          .update({ status: 'invalid_token' })
          .eq('id', config.id)
          .eq('status', 'active');
        if (error) {
          console.error(
            `ADU invalid-token cascade config flip failed: config=${config.id} code=${error.code ?? 'unknown'}`,
          );
        }
      }
      if (configs.length < ADU_TICK_PAGE_SIZE) break;
      lastConfigId = configs[configs.length - 1]!.id;
    }
    if (dests.length < ADU_TICK_PAGE_SIZE) break;
    lastDestinationId = dests[dests.length - 1]!.id;
  }
}

/**
 * Applies one mapper decision (spec §3.1): the config status (stamping
 * `rate_limited_at` when the status is `fb_rate_limited` — the dedicated
 * 3-day recovery anchor), the destination / account flips, the
 * invalid-token cascade, and the team log for app-bug codes. Every flip
 * failure is logged loudly and the tick continues: a failed flip must
 * never lose the job settlement that follows. This REPLACES the old
 * `kind === 'auth'` account flip — the mapper subsumes it.
 */
async function applyAduPublishErrorDecision(
  supabase: SupabaseClient,
  opts: {
    decision: AduPublishErrorDecision;
    configId: string;
    destinationId: string;
    accountId: string;
    jobId: string;
    now: Date;
    errorCode: string | null;
    errorSubcode: string | null;
    errorMessage: string | null;
    detail: Record<string, unknown> | undefined;
  },
): Promise<void> {
  const { decision } = opts;
  if (decision.aduStatus) {
    const configUpdate: Record<string, unknown> = {
      status: decision.aduStatus,
      updated_at: opts.now.toISOString(),
    };
    if (decision.aduStatus === 'fb_rate_limited') {
      configUpdate.rate_limited_at = opts.now.toISOString();
    }
    const { error } = await supabase
      .from('adu_configs')
      .update(configUpdate)
      .eq('id', opts.configId);
    if (error) {
      console.error(
        `ADU config status flip failed: config=${opts.configId} job=${opts.jobId} status=${decision.aduStatus} code=${error.code ?? 'unknown'}`,
      );
    }
  }
  if (decision.destinationStatus) {
    const { error } = await supabase
      .from('destinations')
      .update({ status: decision.destinationStatus })
      .eq('id', opts.destinationId);
    if (error) {
      console.error(
        `ADU destination status flip failed: destination=${opts.destinationId} job=${opts.jobId} status=${decision.destinationStatus} code=${error.code ?? 'unknown'}`,
      );
    }
  }
  if (decision.accountStatus) {
    const { error } = await supabase
      .from('social_accounts')
      .update({ status: decision.accountStatus })
      .eq('id', opts.accountId);
    if (error) {
      console.error(
        `ADU account status flip failed: account=${opts.accountId} job=${opts.jobId} status=${decision.accountStatus} code=${error.code ?? 'unknown'}`,
      );
    }
  }
  if (decision.cascadeInvalidToken) {
    await cascadeInvalidToken(supabase, opts.accountId);
  }
  if (decision.userMessage === 'generic-backend') {
    // App bug (190/2069032, 3): the user sees only the generic message;
    // the full diagnostic goes here, to the team log.
    const detail = opts.detail;
    const phase = typeof detail?.phase === 'string' ? detail.phase : 'unknown';
    const http =
      typeof detail?.httpStatus === 'number' ? String(detail.httpStatus) : 'unknown';
    const body = typeof detail?.rawBody === 'string' ? detail.rawBody : '';
    console.error(
      `[adu-tick] app-bug publish failure: job=${opts.jobId} config=${opts.configId} code=${opts.errorCode ?? 'unknown'} subcode=${opts.errorSubcode ?? 'unknown'} phase=${phase} http=${http} message=${opts.errorMessage ?? ''}${body ? ` body=${body}` : ''}`,
    );
  }
}

/**
 * Settles the stored job reason for a failure: when the mapper says
 * 'generic-backend', the stored message is ONLY the generic message —
 * the real reason (with its diagnostic detail) must never be
 * user-visible for app-bug codes. Every other failure stores the real
 * reason with its detail, as before.
 */
function aduSettlementFailure(
  failure: { code: string | null; message: string | null },
  decision: AduPublishErrorDecision | null,
): { code: string | null; message: string | null } {
  if (decision?.userMessage === 'generic-backend') {
    return { code: failure.code, message: ADU_GENERIC_BACKEND_MESSAGE };
  }
  return failure;
}

export async function runAduTick(options: {
  db: AduTickDb;
  registry: PublisherRegistry;
  masterKey: string;
  now: Date;
}): Promise<AduTickResult> {
  const { db, registry, masterKey, now } = options;
  const result: AduTickResult = {
    intakeJobsCreated: 0,
    intakeCompleted: 0,
    published: 0,
    failed: 0,
    retried: 0,
  };
  const supabase = db as unknown as SupabaseClient;

  // --- Rate-limit auto-recovery ---------------------------------------
  // Configs in fb_rate_limited whose rate_limited_at anchor is 3+
  // days old flip back to active; the user does nothing. Keyset pages
  // of ADU_TICK_PAGE_SIZE; a load failure that is not a missing table
  // throws, a missing table is a clean skip (same rule as the stale
  // reset below). A failed flip is logged loudly and the tick goes on.
  // The anchor is cleared so a later rate limit starts a fresh clock.
  {
    const recoverBefore = new Date(
      now.getTime() - FB_RATE_LIMITED_COOLDOWN_MS,
    ).toISOString();
    let lastRecoveredId: string | null = null;
    for (;;) {
      let recoveryQuery = supabase
        .from('adu_configs')
        .select('id')
        .eq('status', 'fb_rate_limited')
        .lt('rate_limited_at', recoverBefore)
        .order('id', { ascending: true })
        .limit(ADU_TICK_PAGE_SIZE);
      if (lastRecoveredId) recoveryQuery = recoveryQuery.gt('id', lastRecoveredId);
      const { data: recoveryBatch, error: recoveryError } = await recoveryQuery;
      if (recoveryError) {
        if (isMissingTable(recoveryError)) return { ...result, skipped: true };
        throw new InternalError(
          `ADU rate-limit recovery load failed: ${recoveryError.code ?? 'unknown'} ${recoveryError.message}`,
        );
      }
      const batch = (recoveryBatch ?? []) as Array<{ id: string }>;
      for (const row of batch) {
        const { error: recoverError } = await supabase
          .from('adu_configs')
          .update({
            status: 'active',
            rate_limited_at: null,
            updated_at: now.toISOString(),
          })
          .eq('id', row.id)
          .eq('status', 'fb_rate_limited');
        if (recoverError) {
          console.error(
            `ADU rate-limit recovery failed: config=${row.id} code=${recoverError.code ?? 'unknown'}`,
          );
        }
      }
      if (batch.length < ADU_TICK_PAGE_SIZE) break;
      lastRecoveredId = batch[batch.length - 1]!.id;
    }
  }

  // Stale publishing jobs (>300s) go back to pending_publish.
  // Fail loud: a stale-load failure that is NOT a missing table is
  // thrown to the caller's capture (code + message), never silently
  // skipped — the old code fell through with staleJobs === null and
  // skipped the reset for that tick without a trace. A missing table
  // (migration unapplied) is still a clean skip, as before.
  // The updated_at column + set_updated_at() trigger this path reads
  // come from migration 20261031000000_adu_posting_jobs_updated_at.sql
  // (the original ADU table migration omitted the column): without
  // them the stale select errors on an unknown column, so that
  // migration must be applied together with the ADU table migrations.
  const staleAt = new Date(now.getTime() - ADU_STALE_PUBLISHING_SECONDS * 1000).toISOString();
  {
    let lastStaleId: string | null = null;
    for (;;) {
      let staleQuery = supabase
        .from('adu_posting_jobs')
        .select('id, updated_at')
        .eq('status', 'publishing')
        .lt('updated_at', staleAt)
        .order('id', { ascending: true })
        .limit(ADU_TICK_PAGE_SIZE);
      if (lastStaleId) staleQuery = staleQuery.gt('id', lastStaleId);
      const { data: staleBatch, error: staleError } = await staleQuery;
      if (staleError) {
        if (isMissingTable(staleError)) return { ...result, skipped: true };
        throw new InternalError(
          `ADU stale job load failed: ${staleError.code ?? 'unknown'} ${staleError.message}`,
        );
      }
      const batch = (staleBatch ?? []) as Array<{ id: string }>;
      for (const job of batch) {
        // Guarded reset: between the stale select and this update the
        // job may have settled (published/failed) or been re-touched
        // by a publish still running past 300s. Resetting it blindly
        // would flip a settled job back to pending_publish and have
        // it published a second time. Only reset a job that is STILL
        // publishing and STILL stale.
        const { error: resetError } = await supabase
          .from('adu_posting_jobs')
          .update({ status: 'pending_publish' })
          .eq('id', job.id)
          .eq('status', 'publishing')
          .lt('updated_at', staleAt);
        if (resetError) {
          console.error(
            `ADU stale reset failed: job=${job.id} code=${resetError.code ?? 'unknown'}`,
          );
        }
      }
      if (batch.length < ADU_TICK_PAGE_SIZE) break;
      lastStaleId = batch[batch.length - 1]!.id;
    }
  }

  // --- Intake ---------------------------------------------------------
  // Configs are loaded in keyset pages of ADU_TICK_PAGE_SIZE. They
  // cannot be filtered to due configs in the database: each config
  // has its own timezone, so "due now" is computed per config below.
  // Keyset paging (not offset) keeps every config reachable even
  // when a config completes mid-tick and leaves the active set.
  const configPages: AduConfigRow[][] = [];
  {
    let lastConfigId: string | null = null;
    for (;;) {
      let configQuery = supabase
        .from('adu_configs')
        .select('*')
        .eq('status', 'active')
        .eq('sync_status', 'synced')
        .order('id', { ascending: true })
        .limit(ADU_TICK_PAGE_SIZE);
      if (lastConfigId) configQuery = configQuery.gt('id', lastConfigId);
      const { data: configBatch, error: configError } = await configQuery;
      if (configError) {
        if (isMissingTable(configError)) return { ...result, skipped: true };
        throw new InternalError(
          `ADU intake config load failed: ${configError.code ?? 'unknown'} ${configError.message}`,
        );
      }
      const batch = (configBatch ?? []) as unknown as AduConfigRow[];
      configPages.push(batch);
      if (batch.length < ADU_TICK_PAGE_SIZE) break;
      lastConfigId = batch[batch.length - 1]!.id;
    }
  }
  for (const configs of configPages) {
  for (const raw of configs ?? []) {
    const config = raw as unknown as AduConfigRow;
    if (config.posts_per_day <= 0) continue;
    const localTime = localTimeInTimezone(now, config.timezone);
    if (!config.posting_times.includes(localTime)) continue;
    // Skip rule: >10 download failures in the last 24h. Every intake
    // query error is checked: the old code destructured data only, so
    // a transient database error read as an empty result — a config
    // with nothing "busy" was then marked completed permanently, and
    // a failed-count error silently disabled the >10-failures guard.
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { count: failed24h, error: failedCountError } = await supabase
      .from('adu_reels')
      .select('id', { count: 'exact', head: true })
      .eq('config_id', config.id)
      .eq('status', 'download_failed')
      .gte('created_at', dayAgo);
    if (failedCountError) {
      throw new InternalError(
        `ADU intake failed-count load failed: ${failedCountError.code ?? 'unknown'} ${failedCountError.message}`,
      );
    }
    if ((failed24h ?? 0) > ADU_SKIP_FAILED_24H) continue;

    const slotAt = new Date(now);
    slotAt.setSeconds(0, 0);
    const { data: oldest, error: oldestError } = await supabase
      .from('adu_reels')
      .select('*')
      .eq('config_id', config.id)
      .eq('status', 'downloaded')
      .not('media_url', 'is', null)
      .order('downloaded_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (oldestError) {
      throw new InternalError(`ADU intake oldest load failed: ${oldestError.code ?? 'unknown'} ${oldestError.message}`);
    }
    if (!oldest) {
      // A reel whose job terminally failed is terminal like a posted
      // reel — it must not block the config completing. Settlement
      // writes the reel 'failed' (see markAduReelFailed), but a crash
      // between the job update and the reel update leaves the reel
      // 'processing' with a terminally-failed job; exclude those reels
      // from the busy check by their job rows (one bounded page — the
      // exclusion only matters for crash-window rows). PostgREST has
      // no "rows WITHOUT a matching embedded row" filter, so the
      // exclusion is a second query, not an embedded filter.
      const { data: terminalFailed, error: terminalFailedError } = await supabase
        .from('adu_posting_jobs')
        .select('reel_id')
        .eq('config_id', config.id)
        .in('status', ADU_TERMINAL_FAILED_JOB_STATUSES)
        .limit(ADU_TICK_PAGE_SIZE);
      if (terminalFailedError) {
        throw new InternalError(
          `ADU intake terminal-failed load failed: ${terminalFailedError.code ?? 'unknown'} ${terminalFailedError.message}`,
        );
      }
      const terminalReelIds = ((terminalFailed ?? []) as Array<{ reel_id: string }>).map(
        (row) => row.reel_id,
      );
      let busyQuery = supabase
        .from('adu_reels')
        .select('id')
        .eq('config_id', config.id)
        .in('status', ['pending', 'processing']);
      if (terminalReelIds.length > 0) {
        busyQuery = busyQuery.not('id', 'in', `(${terminalReelIds.join(',')})`);
      }
      const { data: busy, error: busyError } = await busyQuery.limit(1);
      if (busyError) {
        throw new InternalError(`ADU intake busy load failed: ${busyError.code ?? 'unknown'} ${busyError.message}`);
      }
      const { data: busyJobs, error: busyJobsError } = await supabase
        .from('adu_posting_jobs')
        .select('id')
        .eq('config_id', config.id)
        .in('status', ['pending_publish', 'publishing'])
        .limit(1);
      if (busyJobsError) {
        throw new InternalError(`ADU intake busy-job load failed: ${busyJobsError.code ?? 'unknown'} ${busyJobsError.message}`);
      }
      // Only mark completed on a VERIFIED empty result: all three
      // queries succeeded and found nothing downloadable and nothing
      // busy. An error above throws instead of completing.
      if ((!busy || busy.length === 0) && (!busyJobs || busyJobs.length === 0)) {
        await supabase
          .from('adu_configs')
          .update({ status: 'completed', updated_at: now.toISOString() })
          .eq('id', config.id);
        result.intakeCompleted += 1;
      }
      continue;
    }
    // Claim the reel BEFORE inserting the job: the old post-insert
    // status update was unchecked, so when it failed the reel stayed
    // 'downloaded' and the next slot intaken it again (same video
    // posted twice). A lost claim (0 rows) means another tick took
    // this reel — skip, never insert a second job for it.
    const { data: claimedReel, error: claimReelError } = await supabase
      .from('adu_reels')
      .update({ status: 'processing' })
      .eq('id', (oldest as { id: string }).id)
      .eq('status', 'downloaded')
      .select('id');
    if (claimReelError) {
      throw new InternalError(`ADU intake reel claim failed: ${claimReelError.code ?? 'unknown'} ${claimReelError.message}`);
    }
    if (!claimedReel || claimedReel.length === 0) continue;
    const { error: insertError } = await supabase.from('adu_posting_jobs').insert({
      config_id: config.id,
      reel_id: (oldest as { id: string }).id,
      schedule_slot_at: slotAt.toISOString(),
      status: 'pending_publish',
    });
    if (insertError) {
      // Release the claim so the reel stays intakable; without this
      // it would sit in 'processing' forever after a failed insert.
      // A failed release is logged loudly: a reel stranded in
      // 'processing' blocks the config (intake only selects
      // 'downloaded', and 'processing' counts as busy), so a silent
      // release failure would wedge the config with no trace.
      const { error: releaseError } = await supabase
        .from('adu_reels')
        .update({ status: 'downloaded' })
        .eq('id', (oldest as { id: string }).id);
      if (releaseError) {
        console.error(
          `ADU intake reel claim release failed: reel=${(oldest as { id: string }).id} code=${releaseError.code ?? 'unknown'} ${releaseError.message}`,
        );
      }
      if (insertError.code === '23505') continue; // already intaken for this slot
      throw new InternalError(`ADU intake insert failed: ${insertError.message}`);
    }
    result.intakeJobsCreated += 1;
  }
  }

  // --- Retention ------------------------------------------------------
  // One DELETE statement, bounded by the 90-day window and the settled
  // statuses — never a row transfer, never a full-table scan of live
  // jobs. It runs before publishing so it is not skipped on ticks
  // where no publisher is registered. A retention failure is logged
  // (code only) and does not fail the tick's publish work, but it is
  // never silent.
  {
    const cutoff = new Date(
      now.getTime() - ADU_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: pruneError } = await supabase
      .from('adu_posting_jobs')
      .delete()
      .in('status', ADU_SETTLED_JOB_STATUSES)
      .lt('created_at', cutoff);
    if (pruneError) {
      console.error(`ADU retention prune failed: code=${pruneError.code ?? 'unknown'}`);
    }
  }

  // --- Publish --------------------------------------------------------
  // Publisher dispatch is PER JOB, by the job's destination platform.
  // Facebook ADU jobs keep the Facebook publisher; Threads ADU jobs
  // (a Threads destination, from the Threads section) use the Threads
  // publisher already registered in the worker registry. The old code
  // hard-coded Facebook here, which would have published every Threads
  // job through the Facebook publisher. A job whose platform has no
  // registered publisher is left pending with a loud error instead of
  // being dropped or mis-published (handled below, after the
  // destination is loaded).
  const { data: jobs, error: jobError } = await supabase
    .from('adu_posting_jobs')
    .select('*, adu_reels(*)')
    .eq('status', 'pending_publish')
    .order('created_at', { ascending: true })
    .limit(100);
  if (jobError) {
    if (isMissingTable(jobError)) return { ...result, skipped: true };
    throw new InternalError(`ADU publish job load failed: ${jobError.message}`);
  }
  for (const rawJob of jobs ?? []) {
    const job = rawJob as Record<string, unknown> & {
      id: string;
      config_id: string;
      reel_id: string;
      publish_retries: number;
      graph_post_id?: string | null;
      adu_reels?: Record<string, unknown> | null;
    };
    if (job.publish_retries > ADU_MAX_PUBLISH_RETRIES) {
      await supabase
        .from('adu_posting_jobs')
        .update({
          status: 'failed_to_publish',
          last_error_code: 'publish_retries_exhausted',
          last_error_message: 'Publish retries exhausted.',
        })
        .eq('id', job.id);
      await markAduReelFailed(supabase, job.reel_id, job.id);
      result.failed += 1;
      continue;
    }
    // Idempotency: a job already carrying a Graph post id settles
    // published from the stored id, never re-publishes.
    if (job.graph_post_id) {
      await supabase
        .from('adu_posting_jobs')
        .update({
          status: 'published',
          published_at: now.toISOString(),
          // A job that failed before must not keep showing its old
          // error once it has published.
          last_error_code: null,
          last_error_message: null,
        })
        .eq('id', job.id);
      result.published += 1;
      continue;
    }
    // Entitlement pause (audit fix 2026-11-01; S2 count gate): when
    // the owning workspace has no active paid period, or is at cap
    // for the config's destination platform without the destination
    // registered, the job is NOT claimed and NOT published — it
    // stays pending_publish for a later tick, so renewal (or
    // registration) resumes it without any missed-slot flood
    // (ADU jobs are not slot-based; they publish as soon as the
    // entitlement returns). The workspace comes from the config,
    // which the claim below would load anyway; loading it first
    // costs one query per job and keeps the gate ahead of the
    // claim, where it belongs. A failed lookup fails closed.
    {
      const { data: gateConfigRow } = await supabase
        .from('adu_configs')
        .select('workspace_id, status, destination_id')
        .eq('id', job.config_id)
        .maybeSingle();
      const gateConfig = gateConfigRow as
        | { workspace_id?: string; status?: string; destination_id?: string }
        | null;
      const gateWorkspaceId = gateConfig?.workspace_id;
      // Publish-loop gate: only 'active' configs publish. A config in
      // any error / paused / completed status leaves its jobs
      // pending_publish — no publish, no retry increment — until it
      // recovers. Same shape as the entitlement gate below.
      if (gateConfig?.status !== 'active') {
        console.error(
          `[adu-tick] job=${job.id} skipped: config status is ${gateConfig?.status ?? 'unknown'}; leaving pending_publish`,
        );
        continue;
      }
      // S2: the destination row gives the platform and the key
      // (external_destination_id ?? id). A missing destination row
      // fails closed — the job stays pending_publish, exactly as
      // the publish loop's destination-missing failure below.
      const gateDestinationId = gateConfig?.destination_id;
      let gateDestinationRow: unknown = null;
      if (gateDestinationId) {
        const { data } = await supabase
          .from('destinations')
          .select('platform, external_destination_id')
          .eq('id', gateDestinationId)
          .maybeSingle();
        gateDestinationRow = data;
      }
      const gateDestination = gateDestinationRow as {
        platform?: string;
        external_destination_id?: string | null;
      } | null;
      const entitled =
        gateWorkspaceId && gateDestination?.platform && gateDestinationId
          ? await workspaceCanPublishForDestination(
              supabase,
              gateWorkspaceId,
              gateDestination.platform,
              gateDestination.external_destination_id ?? gateDestinationId,
              now
            )
          : false;
      if (!entitled) {
        console.error(
          `[adu-tick] job=${job.id} paused: owning workspace cannot publish for this destination (no active period or at cap); leaving pending_publish`
        );
        continue;
      }
    }
    // Claim-only-if-still-pending: the publish loop selects jobs and
    // then publishes them, so two ticks could otherwise select the
    // same job and publish it twice. An empty claim means another
    // tick took it — skip, never publish from a stale row. The claim
    // UPDATE also refreshes updated_at via the set_updated_at()
    // trigger (migration 20261031000000_adu_posting_jobs_updated_at),
    // so a just-claimed job is not stale for the reset above even if
    // its publish runs long — only a job untouched for >300s resets.
    const { data: claimed, error: claimError } = await supabase
      .from('adu_posting_jobs')
      .update({ status: 'publishing' })
      .eq('id', job.id)
      .eq('status', 'pending_publish')
      .select('id');
    if (claimError) {
      throw new InternalError(`ADU publish claim failed: ${claimError.code ?? 'unknown'} ${claimError.message}`);
    }
    if (!claimed || claimed.length === 0) continue;
    const { data: configRow } = await supabase
      .from('adu_configs')
      .select('destination_id')
      .eq('id', job.config_id)
      .maybeSingle();
    const destinationId = (configRow as { destination_id?: string } | null)?.destination_id;
    if (!destinationId) {
      await supabase
        .from('adu_posting_jobs')
        .update({ status: 'publish_error', last_error_code: 'destination_missing', last_error_message: 'Destination not found.' })
        .eq('id', job.id);
      await markAduReelFailed(supabase, job.reel_id, job.id);
      result.failed += 1;
      continue;
    }
    const { data: destination } = await supabase
      .from('destinations')
      .select('*')
      .eq('id', destinationId)
      .maybeSingle();
    if (!destination) {
      await supabase
        .from('adu_posting_jobs')
        .update({ status: 'publish_error', last_error_code: 'destination_missing', last_error_message: 'Destination not found.' })
        .eq('id', job.id);
      await markAduReelFailed(supabase, job.reel_id, job.id);
      result.failed += 1;
      continue;
    }
    const dest = destination as unknown as DatabaseDestinationRow;
    const { data: account } = await supabase
      .from('social_accounts')
      .select('*')
      .eq('id', dest.account_id)
      .maybeSingle();
    if (!account) {
      await supabase
        .from('adu_posting_jobs')
        .update({ status: 'publish_error', last_error_code: 'account_missing', last_error_message: dest.platform === 'threads' ? 'Threads account not found.' : dest.platform === 'instagram' ? 'Instagram account not found.' : 'Facebook account not found.' })
        .eq('id', job.id);
      await markAduReelFailed(supabase, job.reel_id, job.id);
      result.failed += 1;
      continue;
    }
    const acc = account as unknown as DatabaseSocialAccountRow;
    const publisher = registry.get(dest.platform);
    if (!publisher) {
      await supabase
        .from('adu_posting_jobs')
        .update({ status: 'pending_publish', last_error_code: 'publisher_not_registered', last_error_message: `No publisher is registered for ${dest.platform}.` })
        .eq('id', job.id);
      result.retried += 1;
      continue;
    }
    if (acc.status !== 'active' || dest.status === 'disconnected' || dest.status === 'error') {
      await supabase
        .from('adu_posting_jobs')
        .update({ status: 'pending_publish', last_error_code: 'destination_not_active', last_error_message: 'Destination or account is not active.' })
        .eq('id', job.id);
      result.retried += 1;
      continue;
    }
    const reel = job.adu_reels ?? {};
    const item = {
      id: job.id,
      workspace_id: dest.workspace_id,
      destination_id: destinationId,
      platform: dest.platform,
      kind: 'video',
      // Facebook reels keep 'reel'; Threads has no reel format — a
      // Threads video post is format 'video' (the Threads publisher
      // keys off kind, not this field, but the stored item must not
      // claim a Facebook format).
      platform_format: dest.platform === 'threads' ? 'video' : 'reel',
      caption: typeof reel.caption === 'string' ? reel.caption : '',
      title: null,
      first_comment: null,
      media_item_id: null,
      media_url: typeof reel.media_url === 'string' ? reel.media_url : null,
      media_storage_key: typeof reel.media_object_key === 'string' ? reel.media_object_key : null,
      link_url: null,
      platform_options: {},
      scheduled_time: now.toISOString(),
      slot_id: null,
      status: 'publishing',
      claimed_at: now.toISOString(),
      retry_count: job.publish_retries,
      max_retries: ADU_MAX_PUBLISH_RETRIES,
      error_code: null,
      error_subcode: null,
      error_message: null,
      external_post_id: null,
      external_comment_id: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    } as unknown as DatabaseUnifiedQueueItemRow;
    let outcome;
    try {
      outcome = await publisher.publish(item, dest, {
        accessToken: await decryptToken(acc.encrypted_access_token, masterKey),
        refreshToken: acc.encrypted_refresh_token
          ? await decryptToken(acc.encrypted_refresh_token, masterKey)
          : null,
        destinationToken: dest.encrypted_destination_token
          ? await decryptToken(dest.encrypted_destination_token, masterKey)
          : null,
      });
    } catch (err) {
      outcome = {
        status: 'retry' as const,
        error: {
          kind: 'retryable' as const,
          code: 'publisher_threw',
          message: err instanceof Error ? err.message : 'Publisher threw.',
        },
      };
    }
    // Record the Graph post id early, before settlement, so a crash
    // mid-publish can be reconciled instead of double-posting.
    if (outcome.externalPostId) {
      await supabase
        .from('adu_posting_jobs')
        .update({ graph_post_id: outcome.externalPostId })
        .eq('id', job.id);
    }
    // ADU error mapping (spec §3.1): on every publish failure the
    // mapper is the single decision point for config / destination /
    // account flips and for the user-visible message. The publisher
    // outcome's targetDestinationStatus / targetAccountStatus belong
    // to the Pages queue settle path and are NOT read here. The error
    // facts come from outcome.error (string code/subcode) plus the
    // diagnostic HTTP status in outcome.detail.
    const mappedDecision =
      outcome.status === 'published'
        ? null
        : evaluateAduPublishError({
            code: outcome.error?.code ?? null,
            subcode: outcome.error?.subcode ?? null,
            message: outcome.error?.message ?? null,
            httpStatus:
              outcome.detail !== undefined &&
              typeof outcome.detail.httpStatus === 'number'
                ? outcome.detail.httpStatus
                : undefined,
          });
    // An auth-kind failure with no numeric Graph code carries no facts
    // the mapper can branch on (Threads/Instagram auth errors arrive
    // as code 'auth'; the old test fake uses 'invalid_token'). Fail
    // closed to the invalid-token decision — the old kind==='auth'
    // flip — instead of leaving a dead token active. Whenever numeric
    // facts exist the mapper's decision stands (e.g. 190/459 stays a
    // checkpoint — the publisher now classifies it 'permanent' per
    // spec 155 item 5, so the auth flip never fires for it).
    const hasNumericCode =
      outcome.error?.code !== undefined && /^\d+$/.test(outcome.error.code.trim());
    const aduDecision =
      mappedDecision !== null &&
      mappedDecision.aduStatus === null &&
      outcome.error?.kind === 'auth' &&
      !hasNumericCode
        ? ADU_INVALID_TOKEN_DECISION
        : mappedDecision;
    if (aduDecision) {
      await applyAduPublishErrorDecision(supabase, {
        decision: aduDecision,
        configId: job.config_id,
        destinationId,
        accountId: dest.account_id,
        jobId: job.id,
        now,
        errorCode: outcome.error?.code ?? null,
        errorSubcode: outcome.error?.subcode ?? null,
        errorMessage: outcome.error?.message ?? null,
        detail: outcome.detail,
      });
    }
    if (outcome.status === 'published') {
      await supabase
        .from('adu_posting_jobs')
        .update({
          status: 'published',
          graph_post_id: outcome.externalPostId ?? job.graph_post_id ?? null,
          published_at: now.toISOString(),
          // A job that failed before (and was retried) must not keep
          // showing its old error once it has published.
          last_error_code: null,
          last_error_message: null,
        })
        .eq('id', job.id);
      await supabase
        .from('adu_reels')
        .update({ status: 'posted' })
        .eq('id', job.reel_id);
      result.published += 1;
    } else if (outcome.status === 'retry' || outcome.status === 'deferred') {
      const retries = outcome.status === 'retry' ? job.publish_retries + 1 : job.publish_retries;
      if (retries > ADU_MAX_PUBLISH_RETRIES) {
        const failure = aduSettlementFailure(
          aduFailureFields(outcome, {
            code: 'publish_retries_exhausted',
            message: 'Publish retries exhausted.',
          }),
          aduDecision,
        );
        await supabase
          .from('adu_posting_jobs')
          .update({
            status: 'failed_to_publish',
            publish_retries: retries,
            last_error_code: failure.code,
            last_error_message: failure.message,
          })
          .eq('id', job.id);
        await markAduReelFailed(supabase, job.reel_id, job.id);
        result.failed += 1;
      } else {
        const failure = aduSettlementFailure(
          aduFailureFields(outcome, { code: null, message: null }),
          aduDecision,
        );
        await supabase
          .from('adu_posting_jobs')
          .update({
            status: 'pending_publish',
            publish_retries: retries,
            last_error_code: failure.code,
            last_error_message: failure.message,
          })
          .eq('id', job.id);
        result.retried += 1;
      }
    } else {
      const failure = aduSettlementFailure(
        aduFailureFields(outcome, {
          code: 'publish_failed',
          message: 'Publish failed.',
        }),
        aduDecision,
      );
      await supabase
        .from('adu_posting_jobs')
        .update({
          status: 'failed_to_publish',
          publish_retries: job.publish_retries + 1,
          last_error_code: failure.code,
          last_error_message: failure.message,
        })
        .eq('id', job.id);
      await markAduReelFailed(supabase, job.reel_id, job.id);
      result.failed += 1;
    }
  }

  return result;
}
