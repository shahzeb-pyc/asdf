import { z } from 'zod';

// ==========================================
// TikTok mirrors (TikTok → Facebook auto-post)
// ==========================================
//
// A mirror links one TikTok username to one Facebook destination
// (page). The same username may feed several pages — each pair is
// its own mirror row — but the exact pair (username + page) may
// exist only once, or every reel would post twice to that page.
//
// Data source: https://www.tikwm.com/api/ (free, no key, unofficial).
// User posts: GET /api/user/posts?unique_id=<username>&count=<n>
//   -> { code: 0, msg, data: { videos: [...], cursor, hasMore } }.
// A feed item is a reel iff it carries a non-empty no-watermark
// `play` URL and no non-empty `images` array (photo posts carry
// `images` and no `play`). An item with only `wmplay` is
// watermarked-only: it is skipped with an error, never posted.

/**
 * Normalize a user-entered TikTok username: trim, strip a leading
 * @, lowercase. TikTok usernames are 1–24 chars of letters, digits,
 * underscore, and dot.
 */
export function normalizeTikTokUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export const TikTokUsernameSchema = z
  .string()
  .min(1, 'Enter a TikTok username')
  .max(30, 'That username is too long')
  .transform((value) => normalizeTikTokUsername(value))
  .refine((value) => /^[a-z0-9_.]{1,24}$/.test(value), {
    message: 'Enter a valid TikTok username (letters, numbers, underscore, dot).',
  });

export const MirrorStatusSchema = z.enum(['active', 'paused', 'error']);
export type MirrorStatus = z.infer<typeof MirrorStatusSchema>;

export const MirrorPostStatusSchema = z.enum(['posted', 'failed', 'skipped', 'pending']);
export type MirrorPostStatus = z.infer<typeof MirrorPostStatusSchema>;

// --- tikwm API responses (defensive: unknown fields tolerated,
// missing video fields tolerated — the reel filter decides) ---

export const TikwmVideoItemSchema = z.object({
  video_id: z.string().min(1),
  play: z.string().optional(),
  wmplay: z.string().optional(),
  hdplay: z.string().optional(),
  title: z.string().optional(),
  cover: z.string().optional(),
  create_time: z.number().int().nonnegative().optional(),
  images: z.array(z.string()).optional(),
  author: z
    .object({
      unique_id: z.string().optional(),
      nickname: z.string().optional(),
      avatar: z.string().optional(),
    })
    .optional(),
});
export type TikwmVideoItem = z.infer<typeof TikwmVideoItemSchema>;

/** True for a video/reel item: a no-watermark play URL and no photos. */
export function isTikwmReelItem(item: TikwmVideoItem): boolean {
  return (
    typeof item.play === 'string' &&
    item.play.length > 0 &&
    !(Array.isArray(item.images) && item.images.length > 0)
  );
}

/** True when the item offers only a watermarked version (skip + error). */
export function isTikwmWatermarkedOnlyItem(item: TikwmVideoItem): boolean {
  const hasPhotos = Array.isArray(item.images) && item.images.length > 0;
  return (
    !hasPhotos &&
    !(typeof item.play === 'string' && item.play.length > 0) &&
    typeof item.wmplay === 'string' &&
    item.wmplay.length > 0
  );
}

/** The newest reel in a feed, or null when the feed has no reels. */
export function selectLatestReel(videos: TikwmVideoItem[]): TikwmVideoItem | null {
  const reels = videos.filter(isTikwmReelItem);
  if (reels.length === 0) return null;
  reels.sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0));
  return reels[0] ?? null;
}

/**
 * Reels newer than the mirror's last posted one, oldest-first.
 * Items already recorded in mirrored-posts are excluded by id, and
 * items at or before lastPostedCreateTime are excluded by time, so
 * a reordered feed can never re-post an old reel.
 */
export function selectNewReels(
  videos: TikwmVideoItem[],
  options: {
    lastPostedVideoId: string | null;
    lastPostedCreateTime: number | null;
    knownVideoIds: ReadonlySet<string>;
  }
): TikwmVideoItem[] {
  const { lastPostedVideoId, lastPostedCreateTime, knownVideoIds } = options;
  const fresh = videos.filter((item) => {
    if (!isTikwmReelItem(item)) return false;
    if (knownVideoIds.has(item.video_id)) return false;
    if (lastPostedVideoId !== null && item.video_id === lastPostedVideoId) return false;
    if (
      lastPostedCreateTime !== null &&
      typeof item.create_time === 'number' &&
      item.create_time <= lastPostedCreateTime
    ) {
      return false;
    }
    return true;
  });
  fresh.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  return fresh;
}

export const TikwmUserPostsResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z
    .object({
      videos: z.array(TikwmVideoItemSchema).default([]),
      cursor: z.string().optional(),
      hasMore: z.boolean().optional(),
    })
    .optional(),
});
export type TikwmUserPostsResponse = z.infer<typeof TikwmUserPostsResponseSchema>;

export const TikwmUserInfoResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z
    .object({
      user: z
        .object({
          unique_id: z.string().optional(),
          nickname: z.string().optional(),
          avatar: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type TikwmUserInfoResponse = z.infer<typeof TikwmUserInfoResponseSchema>;

// --- stored rows ---

export const MirrorRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  destination_id: z.string().uuid(),
  tiktok_username: z.string(),
  tiktok_display_name: z.string().nullable(),
  tiktok_avatar_url: z.string().nullable(),
  status: MirrorStatusSchema,
  last_posted_video_id: z.string().nullable(),
  last_posted_create_time: z.number().int().nullable(),
  last_checked_at: z.string().nullable(),
  next_check_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MirrorRow = z.infer<typeof MirrorRowSchema>;

export const MirrorPostRowSchema = z.object({
  id: z.string().uuid(),
  mirror_id: z.string().uuid(),
  tiktok_video_id: z.string(),
  caption: z.string(),
  video_url: z.string().nullable(),
  cover_url: z.string().nullable(),
  tiktok_created_at: z.string().nullable(),
  status: MirrorPostStatusSchema,
  facebook_post_id: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
});
export type MirrorPostRow = z.infer<typeof MirrorPostRowSchema>;

// --- API shapes ---

export const CreateMirrorRequestSchema = z
  .object({
    tiktokUsername: TikTokUsernameSchema,
    destinationId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    fbPageId: z.string().min(1).optional(),
  })
  .refine((value) => value.destinationId ?? (value.accountId && value.fbPageId), {
    message: 'Pick a Facebook page: an existing page or an account + page.',
  });
export type CreateMirrorRequest = z.infer<typeof CreateMirrorRequestSchema>;

export const MirrorViewSchema = z.object({
  id: z.string().uuid(),
  destinationId: z.string().uuid(),
  destinationName: z.string(),
  destinationAvatarUrl: z.string().nullable(),
  fbPageId: z.string(),
  tiktokUsername: z.string(),
  tiktokDisplayName: z.string().nullable(),
  tiktokAvatarUrl: z.string().nullable(),
  status: MirrorStatusSchema,
  lastPostedVideoId: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastMirroredPost: z
    .object({
      id: z.string().uuid(),
      tiktokVideoId: z.string(),
      caption: z.string(),
      coverUrl: z.string().nullable(),
      status: MirrorPostStatusSchema,
      facebookPostId: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type MirrorView = z.infer<typeof MirrorViewSchema>;

export const ListMirrorsResponseSchema = z.object({
  mirrors: z.array(MirrorViewSchema),
});
export type ListMirrorsResponse = z.infer<typeof ListMirrorsResponseSchema>;

export const CreateMirrorResponseSchema = z.object({
  mirror: MirrorViewSchema,
  immediatePost: z
    .object({
      attempted: z.boolean(),
      status: MirrorPostStatusSchema.nullable(),
      tiktokVideoId: z.string().nullable(),
      facebookPostId: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type CreateMirrorResponse = z.infer<typeof CreateMirrorResponseSchema>;

export const UpdateMirrorRequestSchema = z.object({
  status: z.enum(['active', 'paused']),
});
export type UpdateMirrorRequest = z.infer<typeof UpdateMirrorRequestSchema>;

export const MirrorDetailResponseSchema = z.object({
  mirror: MirrorViewSchema,
  posts: z.array(MirrorPostRowSchema),
});
export type MirrorDetailResponse = z.infer<typeof MirrorDetailResponseSchema>;

export const DeleteMirrorResponseSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteMirrorResponse = z.infer<typeof DeleteMirrorResponseSchema>;
