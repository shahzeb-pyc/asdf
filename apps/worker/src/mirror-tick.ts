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
// TikTok mirror tick (hourly)
// ==========================================
//
// Every hour, for every mirror with status active or error
// (paused mirrors are skipped), fetch the TikTok account's feed
// from the PAID tikwmapi endpoint (key rotation with DB-persisted
// 30-day pauses, see contracts tikwmapi), resolve each NEW reel
// via the FREE tikwm POST endpoint (no-watermark URL + verbatim
// title), and post it to the linked Facebook page as a Facebook
// Reel, caption verbatim.
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

/** Hourly cron: minute 0 of every hour. */
export const MIRROR_CRON = '0 * * * *';

/** One feed fetch per tick (bounded: a burst above this is not
 *  silently partial — items past the bound wait for next tick,
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
  listMirrors: () => Promise<MirrorTickMirror[]>;
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

export interface MirrorTickResult {
  mirrorsChecked: number;
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

export async function runMirrorTick(deps: MirrorTickDeps): Promise<MirrorTickResult> {
  const now = deps.now ?? new Date();
  const nextCheckAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const result: MirrorTickResult = { mirrorsChecked: 0, posted: 0, skipped: 0, failed: 0 };

  const mirrors = await deps.listMirrors();
  for (const mirror of mirrors) {
    result.mirrorsChecked += 1;
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
        { site: 'runMirrorTick', kind: 'mirror_tick_failed', mirrorId: mirror.id },
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
        { site: 'runMirrorTick', kind: 'mirror_stamp_failed', mirrorId: mirror.id },
        deps.waitUntil
      );
      console.error(`[mirror-tick] mirror=${mirror.id} stamp failed:`, err);
    }
  }

  if (result.mirrorsChecked > 0) {
    console.info(
      `[mirror-tick] checked=${result.mirrorsChecked} posted=${result.posted} skipped=${result.skipped} failed=${result.failed}`
    );
  }
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
  order: (column: string, options?: { ascending?: boolean }) => SupabaseQuery;
  limit: (count: number) => SupabaseQuery;
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
export function buildMirrorTickDeps(
  db: SupabaseLike,
  masterKey: string,
  options?: {
    now?: Date;
    env?: PostHogEnv;
    waitUntil?: MirrorTickDeps['waitUntil'];
    tikwmApiKeys?: string[];
  }
): MirrorTickDeps {
  const fbClient = new FacebookPublishClient();
  const tikwmPauseStore = buildWorkerTikwmPauseStore(db);
  return {
    env: options?.env,
    now: options?.now,
    waitUntil: options?.waitUntil,
    listMirrors: async () => {
      // Mirrors carry no destination foreign key: the target is
      // resolved at tick time by (workspace, target platform,
      // target external id) against destinations. Batch the lookup:
      // one destinations query for all mirrors, matched in code
      // (first active row wins per key). A mirror whose target row
      // is gone is still listed with targetFound false so the tick
      // errors loudly instead of silently skipping it (the old
      // inner-join behaviour dropped such mirrors without a trace).
      const { data, error } = await db
        .from('mirrors')
        .select(
          'id, workspace_id, source_platform, source_username, target_platform, target_external_id, status, catch_up_pending, last_checked_at, last_posted_source_id, last_posted_create_time'
        )
        .in('status', ['active', 'error']);
      if (error) throw new Error(`Failed to list mirrors: ${error.message}`);
      const rows = ((data ?? []) as unknown[]).filter(isRecord) as Record<string, unknown>[];
      const valid = rows.filter(
        (row) =>
          typeof row.id === 'string' &&
          typeof row.workspace_id === 'string' &&
          typeof row.source_platform === 'string' &&
          typeof row.source_username === 'string' &&
          typeof row.target_platform === 'string' &&
          typeof row.target_external_id === 'string'
      );
      const destinations = new Map<string, Record<string, unknown>>();
      if (valid.length > 0) {
        const workspaces = [...new Set(valid.map((row) => row.workspace_id as string))];
        const platforms = [...new Set(valid.map((row) => row.target_platform as string))];
        const externalIds = [...new Set(valid.map((row) => row.target_external_id as string))];
        const { data: destData, error: destError } = await db
          .from('destinations')
          .select('workspace_id, platform, external_destination_id, encrypted_destination_token, status')
          .in('workspace_id', workspaces)
          .in('platform', platforms)
          .in('external_destination_id', externalIds);
        if (destError) throw new Error(`Failed to list destinations: ${destError.message}`);
        const destRows = ((destData ?? []) as unknown[]).filter(isRecord) as Record<
          string,
          unknown
        >[];
        // First active row wins per key; otherwise the first row.
        const byKey = new Map<string, Record<string, unknown>>();
        for (const dest of destRows) {
          const key = `${dest.workspace_id}:${dest.platform}:${dest.external_destination_id}`;
          const existing = byKey.get(key);
          if (!existing || (existing.status !== 'active' && dest.status === 'active')) {
            byKey.set(key, dest);
          }
        }
        for (const [key, dest] of byKey) destinations.set(key, dest);
      }
      const mirrors: MirrorTickMirror[] = [];
      for (const row of valid) {
        const key = `${row.workspace_id}:${row.target_platform}:${row.target_external_id}`;
        const dest = destinations.get(key) ?? null;
        const token = dest?.encrypted_destination_token;
        mirrors.push({
          id: row.id as string,
          workspaceId: row.workspace_id as string,
          sourcePlatform: row.source_platform as string,
          sourceUsername: row.source_username as string,
          targetPlatform: row.target_platform as string,
          targetExternalId: row.target_external_id as string,
          targetFound: dest !== null,
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
        });
      }
      return mirrors;
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
