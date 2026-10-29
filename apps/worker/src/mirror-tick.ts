import {
  decryptToken,
  isTikwmReelItem,
  isTikwmWatermarkedOnlyItem,
  selectNewReels,
  TikwmUserPostsResponseSchema,
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
// from tikwm and post each NEW reel to the linked Facebook page
// as a Facebook Reel, caption verbatim.
//
// Dedup (designed upfront, three layers):
//   1. Time: only items newer than last_posted_create_time.
//   2. Id: items already in tiktok_mirror_posts are excluded.
//   3. Claim: the post row is inserted (status pending) BEFORE
//      calling Facebook; the unique (mirror_id, tiktok_video_id)
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

/** Hourly cron: minute 0 of every hour. */
export const MIRROR_CRON = '0 * * * *';

/** One feed fetch per tick (bounded: a burst above this is not
 *  silently partial — items past the bound wait for next tick,
 *  and the mirror's next_check_at still advances). */
export const MIRROR_FEED_COUNT = 30;

export interface MirrorTickMirror {
  id: string;
  workspaceId: string;
  destinationId: string;
  fbPageId: string;
  destinationToken: string | null;
  tiktokUsername: string;
  status: string;
  lastPostedVideoId: string | null;
  lastPostedCreateTime: number | null;
}

export interface MirrorTickPostInput {
  tiktokVideoId: string;
  caption: string;
  videoUrl: string | null;
  coverUrl: string | null;
  tiktokCreatedAt: string | null;
  status: 'posted' | 'failed' | 'skipped' | 'pending';
  facebookPostId?: string | null;
  error?: string | null;
}

export interface MirrorTickDeps {
  listMirrors: () => Promise<MirrorTickMirror[]>;
  listKnownVideoIds: (mirrorId: string) => Promise<ReadonlySet<string>>;
  /** Insert a pending/claimed row; returns the row id, or null when
   *  the unique constraint says another tick claimed it first. */
  claimPost: (mirrorId: string, post: MirrorTickPostInput) => Promise<string | null>;
  updatePost: (
    postId: string,
    patch: { status: string; facebookPostId?: string | null; error?: string | null }
  ) => Promise<void>;
  updateMirror: (
    mirrorId: string,
    patch: {
      status?: string;
      lastPostedVideoId?: string | null;
      lastPostedCreateTime?: number | null;
      lastCheckedAt?: string;
      nextCheckAt?: string;
      lastError?: string | null;
    }
  ) => Promise<void>;
  fetchFeed: (username: string) => Promise<TikwmVideoItem[]>;
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
    try {
      const feed = await deps.fetchFeed(mirror.tiktokUsername);
      const knownVideoIds = await deps.listKnownVideoIds(mirror.id);
      const newReels = selectNewReels(feed, {
        lastPostedVideoId: mirror.lastPostedVideoId,
        lastPostedCreateTime: mirror.lastPostedCreateTime,
        knownVideoIds,
      });

      // Watermarked-only items newer than the last post: record a
      // skipped row (claim-guarded) + mirror error note, never post.
      for (const item of feed) {
        if (!isTikwmWatermarkedOnlyItem(item)) continue;
        if (knownVideoIds.has(item.video_id)) continue;
        if (
          mirror.lastPostedCreateTime !== null &&
          typeof item.create_time === 'number' &&
          item.create_time <= mirror.lastPostedCreateTime
        ) {
          continue;
        }
        const claimedId = await deps.claimPost(mirror.id, {
          tiktokVideoId: item.video_id,
          caption: item.title ?? '',
          videoUrl: null,
          coverUrl: item.cover ?? null,
          tiktokCreatedAt: toIso(item.create_time),
          status: 'skipped',
          error: 'Only a watermarked version is available for this reel, so it was not posted.',
        });
        if (claimedId) {
          result.skipped += 1;
          mirrorError =
            'A recent reel offers only a watermarked version and was skipped.';
        }
      }

      // Post new reels oldest-first.
      for (const reel of newReels) {
        if (!isTikwmReelItem(reel) || !reel.play) continue;
        const claimedId = await deps.claimPost(mirror.id, {
          tiktokVideoId: reel.video_id,
          caption: reel.title ?? '',
          videoUrl: reel.play,
          coverUrl: reel.cover ?? null,
          tiktokCreatedAt: toIso(reel.create_time),
          status: 'pending',
        });
        if (!claimedId) continue; // Overlapping tick claimed it first.
        if (!mirror.destinationToken) {
          await deps.updatePost(claimedId, {
            status: 'pending',
            error: 'This page has no posting token. Reconnect the page and try again.',
          });
          mirrorError = 'This page has no posting token. Reconnect the page and try again.';
          result.failed += 1;
          break;
        }
        try {
          const postId = await deps.publishReel({
            pageId: mirror.fbPageId,
            pageToken: mirror.destinationToken,
            videoUrl: reel.play,
            caption: reel.title ?? '',
          });
          await deps.updatePost(claimedId, {
            status: 'posted',
            facebookPostId: postId,
            error: null,
          });
          await deps.updateMirror(mirror.id, {
            lastPostedVideoId: reel.video_id,
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
        `[mirror-tick] mirror=${mirror.id} (@${mirror.tiktokUsername}) failed; continuing:`,
        err
      );
    }
    try {
      await deps.updateMirror(mirror.id, {
        status: mirrorError ? 'error' : 'active',
        lastError: mirrorError,
        lastCheckedAt: now.toISOString(),
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

/** tikwm feed fetch for the worker (same endpoint + shape as web). */
export async function fetchTikwmFeedForWorker(
  username: string,
  fetchFn: typeof fetch = fetch
): Promise<TikwmVideoItem[]> {
  let res: Response;
  try {
    res = await fetchFn(
      `https://www.tikwm.com/api/user/posts?unique_id=${encodeURIComponent(username)}&count=${MIRROR_FEED_COUNT}`,
      { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } }
    );
  } catch {
    throw new Error('Could not reach TikTok feed service.');
  }
  if (!res.ok) {
    throw new Error(`TikTok feed service returned HTTP ${res.status}.`);
  }
  const raw: unknown = await res.json().catch(() => null);
  const parsed = TikwmUserPostsResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data) {
    throw new Error(
      parsed.data && typeof parsed.data.msg === 'string' && parsed.data.msg
        ? `Could not fetch that TikTok account's feed: ${parsed.data.msg}`
        : "Could not fetch that TikTok account's feed."
    );
  }
  return parsed.data.data.videos;
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
 * streamed from the tikwm URL).
 */
export function buildMirrorTickDeps(
  db: SupabaseLike,
  masterKey: string,
  options?: { now?: Date; env?: PostHogEnv; waitUntil?: MirrorTickDeps['waitUntil'] }
): MirrorTickDeps {
  const fbClient = new FacebookPublishClient();
  return {
    env: options?.env,
    now: options?.now,
    waitUntil: options?.waitUntil,
    listMirrors: async () => {
      const { data, error } = await db
        .from('tiktok_mirrors')
        .select(
          'id, workspace_id, destination_id, tiktok_username, status, last_posted_video_id, last_posted_create_time, destinations!inner(external_destination_id, encrypted_destination_token)'
        )
        .in('status', ['active', 'error']);
      if (error) throw new Error(`Failed to list mirrors: ${error.message}`);
      const mirrors: MirrorTickMirror[] = [];
      for (const row of (data ?? []) as unknown[]) {
        if (!isRecord(row)) continue;
        const dest = row.destinations as Record<string, unknown> | null;
        if (
          typeof row.id !== 'string' ||
          typeof row.workspace_id !== 'string' ||
          typeof row.destination_id !== 'string' ||
          typeof row.tiktok_username !== 'string' ||
          !dest ||
          typeof dest.external_destination_id !== 'string'
        ) {
          continue;
        }
        const token = dest.encrypted_destination_token;
        mirrors.push({
          id: row.id,
          workspaceId: row.workspace_id,
          destinationId: row.destination_id,
          fbPageId: dest.external_destination_id,
          destinationToken:
            typeof token === 'string' ? await decryptToken(token, masterKey) : null,
          tiktokUsername: row.tiktok_username,
          status: typeof row.status === 'string' ? row.status : 'active',
          lastPostedVideoId:
            typeof row.last_posted_video_id === 'string' ? row.last_posted_video_id : null,
          lastPostedCreateTime:
            typeof row.last_posted_create_time === 'number' ? row.last_posted_create_time : null,
        });
      }
      return mirrors;
    },
    listKnownVideoIds: async (mirrorId: string) => {
      const { data, error } = await db
        .from('tiktok_mirror_posts')
        .select('tiktok_video_id')
        .eq('mirror_id', mirrorId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(`Failed to list known videos: ${error.message}`);
      const ids = new Set<string>();
      for (const row of (data ?? []) as unknown[]) {
        if (isRecord(row) && typeof row.tiktok_video_id === 'string') {
          ids.add(row.tiktok_video_id);
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
        .from('tiktok_mirror_posts')
        .insert({
          mirror_id: mirrorId,
          tiktok_video_id: post.tiktokVideoId,
          caption: post.caption,
          video_url: post.videoUrl,
          cover_url: post.coverUrl,
          tiktok_created_at: post.tiktokCreatedAt,
          status: post.status,
          facebook_post_id: post.facebookPostId ?? null,
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
        .from('tiktok_mirror_posts')
        .update({
          status: patch.status,
          facebook_post_id: patch.facebookPostId ?? null,
          error: patch.error ?? null,
        })
        .eq('id', postId);
      if (error) throw new Error(`Failed to update mirror post: ${error.message}`);
    },
    updateMirror: async (mirrorId, patch) => {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.lastPostedVideoId !== undefined) {
        values.last_posted_video_id = patch.lastPostedVideoId;
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
        .from('tiktok_mirrors')
        .update(values)
        .eq('id', mirrorId);
      if (error) throw new Error(`Failed to update mirror: ${error.message}`);
    },
    fetchFeed: (username: string) => fetchTikwmFeedForWorker(username),
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
