import { z } from 'zod';

// ==========================================
// Create Posts composer (dedicated Page)
// ==========================================
// The composer dialogue never lets the user pick a post type: the
// type is DERIVED from the block's content, here, in one place, so
// the UI label, the queue payload, and the publisher's view of the
// row can never disagree about what a post is:
//
//   - no media            → text post
//   - image               → image post (caption presence is a label
//                           distinction only, not a second type)
//   - vertical video      → reel (a SEPARATE publishing API from a
//                           plain video post — never collapse them)
//   - any other video     → video post
//
// "Vertical" is the media's own aspect ratio first (the library's
// stored ratio), falling back to stored dimensions, so a reel stays
// a reel even when the ratio string is unrecognised. An unknown
// ratio with no dimensions is NOT vertical: a reel must be proven
// vertical, never assumed.

/** The four post types the composer can produce. */
export const ComposerDerivedTypeSchema = z.enum(['text', 'image', 'reel', 'video']);
export type ComposerDerivedType = z.infer<typeof ComposerDerivedTypeSchema>;

/** Aspect ratios that are vertical by definition. */
const VERTICAL_ASPECT_RATIOS: ReadonlySet<string> = new Set(['9:16', '4:5']);

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

/**
 * Parse a stored aspect-ratio string into width/height, or null when
 * it cannot be parsed. Library rows store ratios in several shapes —
 * "9:16", "9 / 16", "9x16", "1080:1920", and plain decimals (width /
 * height, so 0.5625 is 9:16). Exact-string matching silently sent
 * every non-canonical vertical video out as a plain video post, so
 * the ratio is normalised here, in one place, before any
 * vertical/horizontal decision is made.
 */
export function parseAspectRatio(
  input: string | null | undefined
): { width: number; height: number } | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const pair = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i
  );
  if (pair) {
    const width = Number(pair[1]);
    const height = Number(pair[2]);
    if (width > 0 && height > 0) {
      if (Number.isInteger(width) && Number.isInteger(height)) {
        const divisor = gcd(width, height);
        return { width: width / divisor, height: height / divisor };
      }
      return { width, height };
    }
    return null;
  }
  const decimal = Number(trimmed);
  if (Number.isFinite(decimal) && decimal > 0) {
    // A lone decimal is width/height: <1 is vertical, >1 horizontal.
    return { width: decimal, height: 1 };
  }
  return null;
}

export function isVerticalVideo(input: {
  aspectRatio: string | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
}): boolean {
  if (input.aspectRatio && VERTICAL_ASPECT_RATIOS.has(input.aspectRatio)) return true;
  const parsed = parseAspectRatio(input.aspectRatio);
  if (parsed) return parsed.height > parsed.width;
  if (input.width && input.height) return input.height > input.width;
  return false;
}

export function deriveComposerPostType(input: {
  text: string;
  mediaType: 'image' | 'video' | null | undefined;
  aspectRatio: string | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
}): ComposerDerivedType {
  if (!input.mediaType) return 'text';
  if (input.mediaType === 'image') return 'image';
  return isVerticalVideo(input) ? 'reel' : 'video';
}

// ==========================================
// Facebook text limits, per derived type
// ==========================================
// Sourcing note (2026-10-28): no official Meta documentation stating
// these numbers as hard API caps could be reached — Meta's docs do
// not publish a feed-post maximum, and the Reels figure below is
// documented by third parties only. The numbers rest on broad
// third-party consensus (63,206 for feed posts/photo captions,
// stable for over a decade; 2,200 for Reels captions), NOT on a
// Meta doc, and the worker's Facebook publish path validates no
// length at all — so a limit change by Meta would surface at
// publish time, not here. Lengths are counted with JS string
// length (UTF-16 code units), the same measure the codebase
// already uses for caption caps elsewhere.
//
//   - text / image / video posts → the feed-post limit, 63,206.
//     Video posts share it: no separate video-post limit could be
//     sourced, and the feed-post limit is the documented figure
//     for feed publishing generally.
//   - reels → the Reels caption limit, 2,200. Reels are a separate
//     publishing API from plain video posts, so they get their own,
//     much smaller cap — attaching a vertical video to a long
//     caption drops that block's limit the moment its type flips.

/** Facebook feed posts, photo captions, and video posts. */
export const FACEBOOK_POST_TEXT_LIMIT = 63206;

/** Facebook Reels captions. */
export const FACEBOOK_REEL_CAPTION_LIMIT = 2200;

/** The text limit for one derived post type. */
export function composerTextLimitForType(type: ComposerDerivedType): number {
  return type === 'reel' ? FACEBOOK_REEL_CAPTION_LIMIT : FACEBOOK_POST_TEXT_LIMIT;
}

/** The text limit for one draft block, from its CURRENT derived type. */
export function composerTextLimitForBlock(block: {
  text: string;
  media: {
    mediaType: 'image' | 'video' | null | undefined;
    aspectRatio: string | null | undefined;
    width?: number | null | undefined;
    height?: number | null | undefined;
  } | null;
}): number {
  const derived = deriveComposerPostType({
    text: block.text,
    mediaType: block.media?.mediaType ?? null,
    aspectRatio: block.media?.aspectRatio ?? null,
    width: block.media?.width ?? null,
    height: block.media?.height ?? null,
  });
  return composerTextLimitForType(derived);
}

/**
 * One library item attached to a composer block. `captionText` is the
 * item's saved caption in the Media Library (null when it has none):
 * at attach time the composer prefills an empty block's text from it
 * (library → post only — editing in the composer never writes back
 * to the library caption).
 */
export const ComposerMediaSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  mediaType: z.enum(['image', 'video']),
  aspectRatio: z.string(),
  thumbnailUrl: z.string().nullable(),
  url: z.string(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  captionText: z.string().nullable(),
});
export type ComposerMedia = z.infer<typeof ComposerMediaSchema>;

/**
 * One post block in the composer dialogue. The text limit is NOT a
 * flat cap: it follows the block's CURRENT derived type (see the
 * limits above), so attaching or removing media — which flips the
 * type between text/image/video/reel — moves the limit with it.
 * Over-limit text is a validation failure, never a silent
 * truncation: the UI keeps the full text and flags the block, and
 * the queue path refuses it.
 */
export const ComposerDraftBlockSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    media: ComposerMediaSchema.nullable(),
  })
  .superRefine((block, ctx) => {
    const limit = composerTextLimitForBlock(block);
    if (block.text.length > limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Text exceeds the ${limit.toLocaleString('en-US')}-character limit`,
        path: ['text'],
      });
    }
  });
export type ComposerDraftBlock = z.infer<typeof ComposerDraftBlockSchema>;

/** The destination-enqueue fields one ready block maps to. */
export interface ComposerEnqueueItem {
  kind: 'text' | 'image' | 'video';
  platformFormat: string | null;
  caption: string;
  mediaItemIds: string[];
}

/**
 * Maps one draft block to its enqueue payload, or `null` when the
 * block is empty (no text, no media) and must not be queued. The
 * reel/video split rides `platformFormat` exactly as the unified
 * queue row vocabulary expects it (`reel` vs null).
 */
export function toComposerEnqueueItem(
  block: ComposerDraftBlock
): ComposerEnqueueItem | null {
  const hasText = block.text.trim().length > 0;
  const media = block.media;
  if (!hasText && !media) return null;
  const derived = deriveComposerPostType({
    text: block.text,
    mediaType: media?.mediaType ?? null,
    aspectRatio: media?.aspectRatio ?? null,
    width: media?.width ?? null,
    height: media?.height ?? null,
  });
  // Captions are trimmed at the boundary: a block that is only
  // whitespace is empty (handled above), and a real caption never
  // queues with leading/trailing whitespace attached.
  const caption = block.text.trim();
  if (derived === 'text') {
    return { kind: 'text', platformFormat: null, caption, mediaItemIds: [] };
  }
  if (derived === 'image') {
    return {
      kind: 'image',
      platformFormat: null,
      caption,
      mediaItemIds: [media?.id as string],
    };
  }
  if (derived === 'reel') {
    return {
      kind: 'video',
      platformFormat: 'reel',
      caption,
      mediaItemIds: [media?.id as string],
    };
  }
  return {
    kind: 'video',
    platformFormat: null,
    caption,
    mediaItemIds: [media?.id as string],
  };
}
