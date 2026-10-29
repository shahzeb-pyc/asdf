import {
  decryptToken,
  fetchTikwmApiUserPosts,
  isTikwmReelItem,
  isTikwmWatermarkedOnlyItem,
  resolveTikwmVideo,
  selectNewReels,
  type TikwmApiKeyPauseStore,
  type TikwmVideoItem,
} from '@fbuploadpro/contracts';
import { FacebookPublishClient } from './fb-client.js';
import { captureWorkerError, type PostHogEnv } from './analytics.js';

// ==========================================
// TikTok mirror checks (scaled: dispatcher + queue fan-out)
// ==========================================
//
// Every 10 minutes a tiny dispatcher cron hands out work: it
// scans mirrors due for their hourly check (next_check_at
// reached, NULL counts as due) in due order, in pages of 500,
// and enqueues one job per mirror (at most 1,700 per run —
// 6 runs/hour = 10,200/hour capacity) to the mirror-check
// queue, with per-message delays spacing jobs ~3/second so
// feed checks land at a steady ~180/minute instead of one
// 10,000-strong burst. Queue consumers then do the real work
// per mirror: fetch the TikTok account's feed from the PAID
// tikwmapi endpoint (key rotation with DB-persisted 30-day
// pauses, see contracts tikwmapi), resolve each NEW reel via
// the FREE tikwm POST endpoint (no-watermark URL + verbatim
// title), and post it to the linked Facebook page as a
// Facebook Reel, caption verbatim.
//
// One mirror's failure never blocks other mirrors: each job
// is independent, consumers run in parallel, and a message
// that exhausts queue retries lands in the dead-letter queue,
// whose consumer marks the mirror error. Per-mirror business
// failures (feed down, resolve failure, publish rejection)
// keep today's semantics — the mirror is marked error and
// the next hourly check retries it — while transport/DB
// failures that escape the per-mirror handler retry via
// queue semantics instead.
//
// Dedup (designed upfront, three layers):
//   1. Time: only items newer than last_posted_create_time.
//   2. Id: items already in mirror_posts are excluded.
//   3. Claim: the post row is inserted (status pending) BEFORE
//      calling Facebook; the unique (mirror_id, source_post_id)
//      constraint makes a second claim insert nothing, so
//      overlapping ticks can never double-post.
// Oldest-first posting keeps the Facebook page in TikTok order.
//
// Failure discipline (fail loud, self-healing):
//   - A failed post stays `pending` and the mirror goes to `error`
//     with last_error; the next tick retries it.
//   - A watermarked-only item gets a `skipped` row + mirror error
//     note; it is never posted.
//   - A tikwm failure marks the mirror `error` and continues with
//     the other mirrors.
//   - A tick that completes without new errors clears the mirror
//     error back to `active` (the history rows keep the record).
//   - Paused mirrors are never fetched or posted.
//
// Catch-up (owner decision 2026-10-29: "just the latest"):
//   Normal active ticks post ALL newer reels, oldest-first. A
//   CATCH-UP tick posts ONLY the newest reel; every older missed
//   reel gets a `skipped` row (reason: superseded) so history is
//   honest and those reels are never posted later. A tick is a
//   catch-up tick when either (a) the mirror was resumed from
//   paused (the web resume path sets catch_up_pending, cleared
//   after the first tick that successfully checks the feed), or
//   (b) the gap since the last successful check (last_checked_at,
//   stamped by every tick that completes the feed fetch — setup
//   counts, since setup verifies the feed) exceeds 2 hours, i.e.
//   hourly checks were missed. A feed failure does NOT clear the
//   flag: no catch-up happened, so the next tick retries as
//   catch-up. A catch-up tick with nothing new still clears the
//   flag — there is nothing left to catch up on.

/** Dispatcher cron: every 10 minutes it hands out the due slice. */
export const MIRROR_DISPATCH_CRON = '*/10 * * * *';

/** Queue carrying one job per mirror check, and its dead-letter queue. */
export const MIRROR_CHECK_QUEUE_NAME = 'mirror-check';
export const MIRROR_CHECK_DLQ_NAME = 'mirror-check-dlq';

/**
 * Due-scan page size. PostgREST silently truncates an unbounded
 * select at 1,000 rows, so the dispatcher NEVER fetches mirrors
 * without an explicit page bound — a single unbounded list would
 * silently skip every mirror past ~1,000.
 */
export const MIRROR_DISPATCH_BATCH_SIZE = 500;

/**
 * Max jobs enqueued per dispatcher run. 6 runs/hour × 1,700 =
 * 10,200/hour capacity, covering 10,000 mirrors; mirrors past
 * the cap stay due and are picked up by later runs (graceful
 * delay, never dropped).
 */
export const MIRROR_DISPATCH_PER_RUN_CAP = 1700;

/**
 * Dispatch pacing: jobs are sent with delaySeconds = floor(index
 * / 3), i.e. ~3 jobs/second, a steady ~180 feed checks/minute
 * at full load — inside the tikwmapi per-minute caps of every
 * paid plan (600/min and up), instead of a 10,000-strong burst.
 * delaySeconds supports up to 24h, so the ~566s max delay at
 * full load is well inside the limit.
 */
export const MIRROR_DISPATCH_JOBS_PER_SECOND = 3;

/** One feed fetch per check (bounded: a burst above this is not
 *  silently partial — items past the bound wait for next check,
 *  and the mirror's next_check_at still advances). */
export const MIRROR_FEED_COUNT = 30;

export interface MirrorTickMirror {
  id: string;
  workspaceId: string;
  sourcePlatform: string;
  sourceUsername: string;
  targetPlatform: string;
  targetExternalId: string;
  /** False when no destination row matches the target pair (the
   *  tick then errors loudly instead of posting). */
  targetFound: boolean;
  /** Resolved posting token, or null when the target row is gone
   *  or carries no token (the tick then errors loudly, never posts). */
  targetToken: string | null;
  status: string;
  /** Last successful feed check (setup counts: setup verifies the
   *  feed). Null before any check; the gap rule then does not
   *  apply — only the resume flag can mark such a tick catch-up. */
  lastCheckedAt: string | null;
  /** Set on resume (paused -> active); cleared after the first
   *  tick that successfully checks the feed (see header). */
  catchUpPending: boolean;
  lastPostedSourceId: string | null;
  lastPostedCreateTime: number | null;
}

export interface MirrorTickPostInput {
  sourcePostId: string;
  caption: string;
  videoUrl: string | null;
  coverUrl: string | null;
  sourceCreatedAt: string | null;
  status: 'posted' | 'failed' | 'skipped' | 'pending';
  publishedPostId?: string | null;
  error?: string | null;
}

export interface MirrorTickDeps {
  listKnownSourceIds: (mirrorId: string) => Promise<ReadonlySet<string>>;
  /** Insert a pending/claimed row; returns the row id, or null when
   *  the unique constraint says another tick claimed it first. */
  claimPost: (mirrorId: string, post: MirrorTickPostInput) => Promise<string | null>;
  updatePost: (
    postId: string,
    patch: { status: string; publishedPostId?: string | null; error?: string | null }
  ) => Promise<void>;
  updateMirror: (
    mirrorId: string,
    patch: {
      status?: string;
      catchUpPending?: boolean;
      lastPostedSourceId?: string | null;
      lastPostedCreateTime?: number | null;
      lastCheckedAt?: string;
      nextCheckAt?: string;
      lastError?: string | null;
    }
  ) => Promise<void>;
  fetchFeed: (username: string) => Promise<TikwmVideoItem[]>;
  /** Resolve one known video via the FREE tikwm POST endpoint to
   *  its no-watermark URL + verbatim title. Throws on failure. */
  resolveVideo: (params: {
    username: string;
    videoId: string;
  }) => Promise<{ playUrl: string; title: string }>;
  publishReel: (params: {
    pageId: string;
    pageToken: string;
    videoUrl: string;
    caption: string;
  }) => Promise<string>;
  env?: PostHogEnv | undefined;
  now?: Date | undefined;
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export interface MirrorCheckResult {
  posted: number;
  skipped: number;
  failed: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toIso(createTime: number | undefined): string | null {
  return typeof createTime === 'number' ? new Date(createTime * 1000).toISOString() : null;
}

/**
 * Process ONE mirror's hourly check (the queue consumer's unit
 * of work). This is the old runMirrorTick loop body with the
 * loop removed: every semantic is unchanged — catch-up rule,
 * watermark skips, resolve-then-claim, claim-then-publish,
 * stop-on-first-failure, and the final stamp (status, error,
 * last_checked_at, catch_up_pending, next_check_at = check
 * time + 1h). It never throws for per-mirror business
 * failures (they are stamped as mirror errors); only a
 * failure of the final stamp's own error capture is logged,
 * exactly as before. Transport/DB failures raised by
 * fetchMirror (consumer side, before this runs) still
 * propagate to queue retry semantics.
 */
export async function processMirrorCheck(
  deps: MirrorTickDeps,
  mirror: MirrorTickMirror
): Promise<MirrorCheckResult> {
  const now = deps.now ?? new Date();
  const nextCheckAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const result: MirrorCheckResult = { posted: 0, skipped: 0, failed: 0 };

  {
    let mirrorError: string | null = null;
    let feedFetched = false;
    let isCatchUp = false;
    try {
      const feed = await deps.fetchFeed(mirror.sourceUsername);
      const knownSourceIds = await deps.listKnownSourceIds(mirror.id);
      const newReels = selectNewReels(feed, {
        lastPostedSourceId: mirror.lastPostedSourceId,
        lastPostedCreateTime: mirror.lastPostedCreateTime,
        knownSourceIds,
      });
      // The feed was fetched: this is a successful check, whatever
      // happens to individual posts below.
      feedFetched = true;
      // Catch-up detection (owner rule): resumed mirrors, or a gap
      // since the last successful check over the 2-hour bound.
      // An unparseable stamp never triggers gap catch-up (fail
      // toward the normal tick, which posts rather than skips).
      const lastCheckedMs = mirror.lastCheckedAt
        ? Date.parse(mirror.lastCheckedAt)
        : Number.NaN;
      const gapCatchUp =
        !Number.isNaN(lastCheckedMs) &&
        now.getTime() - lastCheckedMs > 2 * 60 * 60 * 1000;
      isCatchUp = mirror.catchUpPending || gapCatchUp;

      // Watermarked-only items newer than the last post: record a
      // skipped row (claim-guarded) + mirror error note, never post.
      for (const item of feed) {
        if (!isTikwmWatermarkedOnlyItem(item)) continue;
        if (knownSourceIds.has(item.video_id)) continue;
        if (
          mirror.lastPostedCreateTime !== null &&
          typeof item.create_time === 'number' &&
          item.create_time <= mirror.lastPostedCreateTime
        ) {
          continue;
        }
        const claimedId = await deps.claimPost(mirror.id, {
          sourcePostId: item.video_id,
          caption: item.title ?? '',
          videoUrl: null,
          coverUrl: item.cover ?? null,
          sourceCreatedAt: toIso(item.create_time),
          status: 'skipped',
          error: 'Only a watermarked version is available for this reel, so it was not posted.',
        });
        if (claimedId) {
          result.skipped += 1;
          mirrorError =
            'A recent reel offers only a watermarked version and was skipped.';
        }
      }

      // Catch-up: post ONLY the newest reel. Every older missed
      // reel gets a `skipped` row (reason: superseded) so history
      // is honest and those reels are never posted later. The
      // claim guard keeps overlapping ticks from double-skipping.
      let reelsToPost = newReels;
      if (isCatchUp && newReels.length > 1) {
        const older = newReels.slice(0, -1);
        const newest = newReels[newReels.length - 1]!;
        for (const superseded of older) {
          if (!isTikwmReelItem(superseded) || !superseded.play) continue;
          const skippedId = await deps.claimPost(mirror.id, {
            sourcePostId: superseded.video_id,
            caption: superseded.title ?? '',
            videoUrl: superseded.play,
            coverUrl: superseded.cover ?? null,
            sourceCreatedAt: toIso(superseded.create_time),
            status: 'skipped',
            error:
              'Superseded by a newer reel during catch-up: after a pause or missed checks, only the latest reel is posted.',
          });
          if (skippedId) result.skipped += 1;
        }
        reelsToPost = [newest];
      }

      // Post new reels oldest-first (a catch-up tick posts only
      // the newest, above). Each reel is resolved via the FREE
      // tikwm POST endpoint (no-watermark URL + verbatim title)
      // before claiming; a resolve failure claims a pending row
      // with the error (mirror error, stop this mirror) — never
      // silently skipped, and the resolved URL is what posts.
      for (const reel of reelsToPost) {
        if (!isTikwmReelItem(reel) || !reel.play) continue;
        let resolved: { playUrl: string; title: string };
        try {
          resolved = await deps.resolveVideo({
            username: mirror.sourceUsername,
            videoId: reel.video_id,
          });
        } catch (err) {
          const message = errorMessage(err);
          const failedId = await deps.claimPost(mirror.id, {
            sourcePostId: reel.video_id,
            caption: reel.title ?? '',
            videoUrl: null,
            coverUrl: reel.cover ?? null,
            sourceCreatedAt: toIso(reel.create_time),
            status: 'pending',
            error: message,
          });
          if (failedId) {
            mirrorError = message;
            result.failed += 1;
          }
          break;
        }
        const caption = resolved.title || reel.title || '';
        const claimedId = await deps.claimPost(mirror.id, {
          sourcePostId: reel.video_id,
          caption,
          videoUrl: resolved.playUrl,
          coverUrl: reel.cover ?? null,
          sourceCreatedAt: toIso(reel.create_time),
          status: 'pending',
        });
        if (!claimedId) continue; // Overlapping tick claimed it first.
        if (!mirror.targetToken) {
          const message = mirror.targetFound
            ? 'This target has no posting token. Reconnect the target and try again.'
            : 'This target is no longer connected. Reconnect it and try again.';
          await deps.updatePost(claimedId, {
            status: 'pending',
            error: message,
          });
          mirrorError = message;
          result.failed += 1;
          break;
        }
        try {
          const postId = await deps.publishReel({
            pageId: mirror.targetExternalId,
            pageToken: mirror.targetToken,
            videoUrl: resolved.playUrl,
            caption,
          });
          await deps.updatePost(claimedId, {
            status: 'posted',
            publishedPostId: postId,
            error: null,
          });
          await deps.updateMirror(mirror.id, {
            lastPostedSourceId: reel.video_id,
            lastPostedCreateTime: typeof reel.create_time === 'number' ? reel.create_time : null,
          });
          result.posted += 1;
        } catch (err) {
          const message = errorMessage(err);
          await deps.updatePost(claimedId, { status: 'pending', error: message });
          mirrorError = message;
          result.failed += 1;
          // Stop this mirror's loop: later reels stay unclaimed for
          // the next tick instead of stacking failures.
          break;
        }
      }
    } catch (err) {
      const message = errorMessage(err);
      mirrorError = message;
      captureWorkerError(
        deps.env ?? {},
        err instanceof Error ? err : new Error(message),
        { site: 'processMirrorCheck', kind: 'mirror_tick_failed', mirrorId: mirror.id },
        deps.waitUntil
      );
      console.error(
        `[mirror-tick] mirror=${mirror.id} (@${mirror.sourceUsername}) failed; continuing:`,
        err
      );
    }
    try {
      await deps.updateMirror(mirror.id, {
        status: mirrorError ? 'error' : 'active',
        lastError: mirrorError,
        // last_checked_at means the last SUCCESSFUL check: a tick
        // whose feed fetch failed does not advance it, so the gap
        // rule above keeps seeing the missed checks. next_check_at
        // still advances every tick — the next check is scheduled
        // regardless. The resume flag clears only after a tick that
        // actually checked the feed; a feed failure leaves it for
        // the next tick.
        ...(feedFetched ? { lastCheckedAt: now.toISOString() } : {}),
        ...(isCatchUp && feedFetched ? { catchUpPending: false } : {}),
        nextCheckAt,
      });
    } catch (err) {
      captureWorkerError(
        deps.env ?? {},
        err instanceof Error ? err : new Error(String(err)),
        { site: 'processMirrorCheck', kind: 'mirror_stamp_failed', mirrorId: mirror.id },
        deps.waitUntil
      );
      console.error(`[mirror-tick] mirror=${mirror.id} stamp failed:`, err);
    }
  }

  console.info(
    `[mirror-tick] mirror=${mirror.id} posted=${result.posted} skipped=${result.skipped} failed=${result.failed}`
  );
  return result;
}

/**
 * Pause store over the tikwmapi_key_pauses table for the worker's
 * Supabase client. Lookup/insert failures throw; the rotation
 * logs them loudly and continues with rotation unpersisted —
 * a missing table never crashes the feed call on its own.
 */
export function buildWorkerTikwmPauseStore(db: SupabaseLike): TikwmApiKeyPauseStore {
  return {
    getPausedUntil: async (fingerprint: string) => {
      const { data, error } = await db
        .from('tikwmapi_key_pauses')
        .select('paused_until')
        .eq('key_fingerprint', fingerprint)
        .maybeSingle();
      if (error) throw new Error(`Failed to read key pause: ${error.message}`);
      const value = (data as { paused_until?: unknown } | null)?.paused_until;
      if (typeof value !== 'string') return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    },
    setPaused: async (fingerprint: string, pausedUntil: Date, reason: string) => {
      const { error } = await (
        db as unknown as {
          from: (table: string) => {
            upsert: (
              values: Record<string, unknown>,
              opts: { onConflict: string }
            ) => Promise<{ error: { message: string } | null }>;
          };
        }
      )
        .from('tikwmapi_key_pauses')
        .upsert(
          {
            key_fingerprint: fingerprint,
            paused_until: pausedUntil.toISOString(),
            reason,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'key_fingerprint' }
        );
      if (error) throw new Error(`Failed to persist key pause: ${error.message}`);
    },
  };
}

type SupabaseLike = {
  from: (table: string) => {
    select: (columns: string) => SupabaseQuery;
  };
};

type SupabaseQuery = {
  eq: (column: string, value: unknown) => SupabaseQuery;
  in: (column: string, values: unknown[]) => SupabaseQuery;
  order: (
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean }
  ) => SupabaseQuery;
  limit: (count: number) => SupabaseQuery;
  range: (from: number, to: number) => SupabaseQuery;
  single: () => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  maybeSingle: () => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  then: <T>(
    onFulfilled: (value: { data: unknown; error: { message: string; code?: string } | null }) => T
  ) => Promise<T>;
} & Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Build function deps over a Supabase client (the worker's db) +
 * the token master key. The FB client is the worker's own
 * FacebookPublishClient (3-phase video_reels upload, bytes
 * streamed from the resolved no-watermark URL). Feed discovery
 * uses the PAID tikwmapi endpoint with the given keys (rotation
 * + DB-persisted pauses); an empty key list fails every feed
 * fetch loudly as a per-mirror error, never silently.
 */
/** Minimal queue-producer handle (Cloudflare Queue binding shape). */
export interface MirrorCheckQueue {
  send: (body: MirrorCheckMessage, options?: { delaySeconds?: number }) => Promise<void>;
}

/** One queued job: the consumer re-fetches the mirror fresh by id,
 *  so a pause/delete between dispatch and consume is honoured. */
export interface MirrorCheckMessage {
  mirrorId: string;
}

/**
 * Full worker deps: per-mirror check deps (MirrorTickDeps) plus
 * the dispatcher/consumer deps. The old whole-list
 * `listMirrors` is gone on purpose: an unbounded select is
 * silently truncated at 1,000 rows, and a batch destinations
 * lookup over 10,000 mirrors would blow up the .in() lists —
 * both are replaced by paged due scans + single-mirror fetches.
 */
export interface MirrorWorkerDeps extends MirrorTickDeps {
  /**
   * Due-mirror ids in due order (next_check_at ASC NULLS FIRST,
   * id ASC), paged MIRROR_DISPATCH_BATCH_SIZE at a time, stopping
   * at the first not-yet-due row or at `cap`. NULL next_check_at
   * counts as due (never checked); an unparseable stamp also
   * counts as due (fail toward checking). Nothing is mutated
   * during the scan, so offset paging cannot skip rows.
   */
  listDueMirrorIds: (now: Date, cap: number) => Promise<string[]>;
  /** Single mirror + its resolved target (first active row wins;
   *  targetFound false when the target row is gone, so the
   *  consumer errors loudly instead of silently skipping it).
   *  Null when the mirror row itself is gone (deleted). */
  fetchMirror: (mirrorId: string) => Promise<MirrorTickMirror | null>;
  /** Enqueue one mirror-check job with the given delivery delay. */
  enqueueMirrorCheck: (mirrorId: string, delaySeconds: number) => Promise<void>;
}

export function buildMirrorTickDeps(
  db: SupabaseLike,
  masterKey: string,
  options?: {
    now?: Date;
    env?: PostHogEnv;
    waitUntil?: MirrorTickDeps['waitUntil'];
    tikwmApiKeys?: string[];
    mirrorQueue?: MirrorCheckQueue;
  }
): MirrorWorkerDeps {
  const fbClient = new FacebookPublishClient();
  const tikwmPauseStore = buildWorkerTikwmPauseStore(db);
  return {
    env: options?.env,
    now: options?.now,
    waitUntil: options?.waitUntil,
    listDueMirrorIds: async (now: Date, cap: number) => {
      const nowMs = now.getTime();
      const ids: string[] = [];
      let offset = 0;
      while (ids.length < cap) {
        const { data, error } = await db
          .from('mirrors')
          .select('id, next_check_at')
          .in('status', ['active', 'error'])
          .order('next_check_at', { ascending: true, nullsFirst: true })
          .order('id', { ascending: true })
          .range(offset, offset + MIRROR_DISPATCH_BATCH_SIZE - 1);
        if (error) throw new Error(`Failed to list due mirrors: ${error.message}`);
        const rows = ((data ?? []) as unknown[]).filter(isRecord) as Record<
          string,
          unknown
        >[];
        if (rows.length === 0) break;
        let stopped = false;
        for (const row of rows) {
          const stamp = row.next_check_at;
          // A stamp in the future ends the due prefix; NULL and
          // unparseable stamps count as due (see interface doc).
          if (typeof stamp === 'string' && !Number.isNaN(Date.parse(stamp))) {
            if (Date.parse(stamp) > nowMs) {
              stopped = true;
              break;
            }
          }
          if (typeof row.id === 'string') ids.push(row.id);
          if (ids.length >= cap) break;
        }
        if (stopped || rows.length < MIRROR_DISPATCH_BATCH_SIZE) break;
        offset += MIRROR_DISPATCH_BATCH_SIZE;
      }
      return ids;
    },
    fetchMirror: async (mirrorId: string) => {
      const { data, error } = await db
        .from('mirrors')
        .select(
          'id, workspace_id, source_platform, source_username, target_platform, target_external_id, status, catch_up_pending, last_checked_at, last_posted_source_id, last_posted_create_time'
        )
        .eq('id', mirrorId)
        .maybeSingle();
      if (error) throw new Error(`Failed to fetch mirror: ${error.message}`);
      if (!isRecord(data)) return null;
      const row = data as Record<string, unknown>;
      if (
        typeof row.id !== 'string' ||
        typeof row.workspace_id !== 'string' ||
        typeof row.source_platform !== 'string' ||
        typeof row.source_username !== 'string' ||
        typeof row.target_platform !== 'string' ||
        typeof row.target_external_id !== 'string'
      ) {
        return null;
      }
      // Mirrors carry no destination foreign key: resolve the
      // target at check time by (workspace, target platform,
      // target external id). First active row wins.
      const { data: destData, error: destError } = await db
        .from('destinations')
        .select('encrypted_destination_token, status')
        .eq('workspace_id', row.workspace_id)
        .eq('platform', row.target_platform)
        .eq('external_destination_id', row.target_external_id)
        .limit(10);
      if (destError) throw new Error(`Failed to list destinations: ${destError.message}`);
      const destRows = ((destData ?? []) as unknown[]).filter(isRecord) as Record<
        string,
        unknown
      >[];
      const dest =
        destRows.find((d) => d.status === 'active') ??
        (destRows.length > 0 ? destRows[0] : undefined);
      const token = dest?.encrypted_destination_token;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        sourcePlatform: row.source_platform,
        sourceUsername: row.source_username,
        targetPlatform: row.target_platform,
        targetExternalId: row.target_external_id,
        targetFound: dest !== undefined,
        targetToken:
          typeof token === 'string' ? await decryptToken(token, masterKey) : null,
        status: typeof row.status === 'string' ? row.status : 'active',
        lastCheckedAt:
          typeof row.last_checked_at === 'string' ? row.last_checked_at : null,
        catchUpPending: row.catch_up_pending === true,
        lastPostedSourceId:
          typeof row.last_posted_source_id === 'string' ? row.last_posted_source_id : null,
        lastPostedCreateTime:
          typeof row.last_posted_create_time === 'number' ? row.last_posted_create_time : null,
      };
    },
    enqueueMirrorCheck: async (mirrorId: string, delaySeconds: number) => {
      const queue = options?.mirrorQueue;
      if (!queue) throw new Error('Mirror check queue is not configured');
      await queue.send({ mirrorId }, { delaySeconds });
    },
    listKnownSourceIds: async (mirrorId: string) => {
      const { data, error } = await db
        .from('mirror_posts')
        .select('source_post_id')
        .eq('mirror_id', mirrorId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(`Failed to list known source posts: ${error.message}`);
      const ids = new Set<string>();
      for (const row of (data ?? []) as unknown[]) {
        if (isRecord(row) && typeof row.source_post_id === 'string') {
          ids.add(row.source_post_id);
        }
      }
      return ids;
    },
    claimPost: async (mirrorId: string, post: MirrorTickPostInput) => {
      const { data, error } = await (db as unknown as {
        from: (table: string) => {
          insert: (values: Record<string, unknown>) => {
            select: (columns: string) => {
              single: () => Promise<{
                data: unknown;
                error: { message: string; code?: string } | null;
              }>;
            };
          };
        };
      })
        .from('mirror_posts')
        .insert({
          mirror_id: mirrorId,
          source_post_id: post.sourcePostId,
          caption: post.caption,
          video_url: post.videoUrl,
          cover_url: post.coverUrl,
          source_created_at: post.sourceCreatedAt,
          status: post.status,
          published_post_id: post.publishedPostId ?? null,
          error: post.error ?? null,
        })
        .select('id')
        .single();
      if (error) {
        if (error.code === '23505') return null; // Claimed by an overlapping tick.
        throw new Error(`Failed to claim mirror post: ${error.message}`);
      }
      const id = (data as Record<string, unknown> | null)?.id;
      return typeof id === 'string' ? id : null;
    },
    updatePost: async (postId, patch) => {
      const { error } = await (db as unknown as {
        from: (table: string) => {
          update: (values: Record<string, unknown>) => {
            eq: (column: string, value: unknown) => Promise<{
              error: { message: string } | null;
            }>;
          };
        };
      })
        .from('mirror_posts')
        .update({
          status: patch.status,
          published_post_id: patch.publishedPostId ?? null,
          error: patch.error ?? null,
        })
        .eq('id', postId);
      if (error) throw new Error(`Failed to update mirror post: ${error.message}`);
    },
    updateMirror: async (mirrorId, patch) => {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.catchUpPending !== undefined) values.catch_up_pending = patch.catchUpPending;
      if (patch.lastPostedSourceId !== undefined) {
        values.last_posted_source_id = patch.lastPostedSourceId;
      }
      if (patch.lastPostedCreateTime !== undefined) {
        values.last_posted_create_time = patch.lastPostedCreateTime;
      }
      if (patch.lastCheckedAt !== undefined) values.last_checked_at = patch.lastCheckedAt;
      if (patch.nextCheckAt !== undefined) values.next_check_at = patch.nextCheckAt;
      if (patch.lastError !== undefined) values.last_error = patch.lastError;
      const { error } = await (db as unknown as {
        from: (table: string) => {
          update: (values: Record<string, unknown>) => {
            eq: (column: string, value: unknown) => Promise<{
              error: { message: string } | null;
            }>;
          };
        };
      })
        .from('mirrors')
        .update(values)
        .eq('id', mirrorId);
      if (error) throw new Error(`Failed to update mirror: ${error.message}`);
    },
    fetchFeed: (username: string) =>
      fetchTikwmApiUserPosts(username, {
        count: MIRROR_FEED_COUNT,
        apiKeys: options?.tikwmApiKeys ?? [],
        pauseStore: tikwmPauseStore,
      }),
    resolveVideo: async ({ username, videoId }) =>
      resolveTikwmVideo(`https://www.tiktok.com/@${username}/video/${videoId}`),
    publishReel: async (params) => {
      const result = await fbClient.publishReel({
        pageId: params.pageId,
        accessToken: params.pageToken,
        videoUrl: params.videoUrl,
        caption: params.caption,
      });
      return result.postId;
    },
  };
}

export interface MirrorDispatchDeps {
  listDueMirrorIds: (now: Date, cap: number) => Promise<string[]>;
  enqueueMirrorCheck: (mirrorId: string, delaySeconds: number) => Promise<void>;
  /** Advance a dispatched mirror's next check (dispatch time + 1h). */
  advanceMirrorCheck: (mirrorId: string, nextCheckAt: string) => Promise<void>;
  now?: Date;
}

export interface MirrorDispatchResult {
  /** Jobs successfully enqueued (their next check was advanced). */
  dispatched: number;
  /** Mirrors whose enqueue failed (left due for the next run). */
  failed: number;
  /** Due mirrors found by the scan (capped at the per-run cap). */
  due: number;
}

/**
 * Dispatcher (MIRROR_DISPATCH_CRON, every 10 minutes): the ONLY
 * thing the cron does. It scans due mirrors, enqueues one job
 * per mirror with a pacing delay (index / 3 seconds, ~3
 * jobs/second), and advances each enqueued mirror's
 * next_check_at to dispatch time + 1h so it is not
 * re-dispatched until its next hourly slot. A failed enqueue
 * leaves the mirror due (no advance, retried next run); a
 * failed advance after a successful enqueue is logged loudly
 * but the job still runs — the consumer's claim guard keeps
 * any re-dispatch from double-posting. Mirrors past the
 * per-run cap simply stay due for later runs.
 */
export async function runMirrorDispatch(
  deps: MirrorDispatchDeps
): Promise<MirrorDispatchResult> {
  const now = deps.now ?? new Date();
  const scanned = await deps.listDueMirrorIds(now, MIRROR_DISPATCH_PER_RUN_CAP);
  // Defense in depth: the per-run cap is a dispatcher invariant,
  // enforced here even if a scan implementation over-returns.
  const ids = scanned.slice(0, MIRROR_DISPATCH_PER_RUN_CAP);
  const nextCheckAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  let dispatched = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const mirrorId = ids[i]!;
    const delaySeconds = Math.floor(i / MIRROR_DISPATCH_JOBS_PER_SECOND);
    try {
      await deps.enqueueMirrorCheck(mirrorId, delaySeconds);
    } catch (err) {
      failed += 1;
      console.error(
        `[mirror-dispatch] mirror=${mirrorId} enqueue failed; leaving due:`,
        err
      );
      continue;
    }
    try {
      await deps.advanceMirrorCheck(mirrorId, nextCheckAt);
    } catch (err) {
      // The job is already queued: log loudly, do not fail the
      // run, and do not count it as failed — the consumer still
      // checks the mirror, and its final stamp sets the next
      // check. A later re-dispatch (next_check_at unadvanced)
      // is deduped by the claim guard.
      console.error(
        `[mirror-dispatch] mirror=${mirrorId} next_check_at advance failed after enqueue:`,
        err
      );
    }
    dispatched += 1;
  }
  console.info(
    `[mirror-dispatch] due=${scanned.length} dispatched=${dispatched} failed=${failed}`
  );
  return { dispatched, failed, due: scanned.length };
}

export interface MirrorCheckConsumerDeps {
  check: MirrorTickDeps;
  /** Fresh single-mirror fetch; throws on transport/DB failure
   *  so the batch retries via queue semantics. */
  fetchMirror: (mirrorId: string) => Promise<MirrorTickMirror | null>;
}

/**
 * Queue consumer for the mirror-check queue: one message = one
 * mirror, processed sequentially within the batch (messages in
 * one batch are independent mirrors, so a failure in one never
 * blocks the others — each message is handled in its own
 * try/catch via processMirrorCheck's mirror-error stamping).
 * A mirror deleted since dispatch, or paused since dispatch,
 * is acked without work. A throw here (fetchMirror failure)
 * retries the whole batch via queue semantics; after
 * max_retries the message lands in the DLQ (see below).
 */
export async function handleMirrorCheckBatch(
  batch: { messages: Array<{ body: MirrorCheckMessage }> },
  deps: MirrorCheckConsumerDeps
): Promise<void> {
  for (const message of batch.messages) {
    const mirror = await deps.fetchMirror(message.body.mirrorId);
    if (!mirror) continue; // Deleted since dispatch: ack, nothing to do.
    if (mirror.status !== 'active' && mirror.status !== 'error') {
      continue; // Paused (or otherwise held) since dispatch: ack, skip.
    }
    await processMirrorCheck(deps.check, mirror);
  }
}

export interface MirrorCheckDlqDeps {
  /** Best-effort error stamp; the DLQ handler never throws. */
  markMirrorError: (mirrorId: string, error: string) => Promise<void>;
}

/**
 * Dead-letter consumer: a message that exhausted queue retries
 * (a poison message — repeated transport/DB failure) marks its
 * mirror error so the failure is visible instead of silent.
 * Failures of the stamp itself are logged and swallowed: the
 * DLQ must not throw endlessly.
 */
export async function handleMirrorCheckDlqBatch(
  batch: { messages: Array<{ body: MirrorCheckMessage }> },
  deps: MirrorCheckDlqDeps
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await deps.markMirrorError(
        message.body.mirrorId,
        'Mirror check failed repeatedly and was moved to the dead-letter queue.'
      );
    } catch (err) {
      console.error(
        `[mirror-dlq] mirror=${message.body.mirrorId} error stamp failed:`,
        err
      );
    }
  }
}
