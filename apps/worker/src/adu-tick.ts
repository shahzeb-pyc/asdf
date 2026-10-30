import {
  ADU_MAX_PUBLISH_RETRIES,
  ADU_SKIP_FAILED_24H,
  ADU_STALE_PUBLISHING_SECONDS,
  InternalError,
  localTimeInTimezone,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherRegistry,
} from '@fbuploadpro/contracts';
import { decryptToken } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

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
      const { data: busy, error: busyError } = await supabase
        .from('adu_reels')
        .select('id')
        .eq('config_id', config.id)
        .in('status', ['pending', 'processing'])
        .limit(1);
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
      result.failed += 1;
      continue;
    }
    // Idempotency: a job already carrying a Graph post id settles
    // published from the stored id, never re-publishes.
    if (job.graph_post_id) {
      await supabase
        .from('adu_posting_jobs')
        .update({ status: 'published', published_at: now.toISOString() })
        .eq('id', job.id);
      result.published += 1;
      continue;
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
    if (outcome.status === 'published') {
      await supabase
        .from('adu_posting_jobs')
        .update({
          status: 'published',
          graph_post_id: outcome.externalPostId ?? job.graph_post_id ?? null,
          published_at: now.toISOString(),
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
        await supabase
          .from('adu_posting_jobs')
          .update({
            status: 'failed_to_publish',
            publish_retries: retries,
            last_error_code: outcome.error?.code ?? 'publish_retries_exhausted',
            last_error_message: outcome.error?.message ?? 'Publish retries exhausted.',
          })
          .eq('id', job.id);
        result.failed += 1;
      } else {
        await supabase
          .from('adu_posting_jobs')
          .update({
            status: 'pending_publish',
            publish_retries: retries,
            last_error_code: outcome.error?.code ?? null,
            last_error_message: outcome.error?.message ?? null,
          })
          .eq('id', job.id);
        result.retried += 1;
      }
    } else {
      await supabase
        .from('adu_posting_jobs')
        .update({
          status: 'failed_to_publish',
          publish_retries: job.publish_retries + 1,
          last_error_code: outcome.error?.code ?? 'publish_failed',
          last_error_message: outcome.error?.message ?? 'Publish failed.',
        })
        .eq('id', job.id);
      if (outcome.error?.kind === 'auth') {
        await supabase
          .from('social_accounts')
          .update({ status: 'expired' })
          .eq('id', dest.account_id);
      }
      result.failed += 1;
    }
  }

  return result;
}
