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

export function isVerticalVideo(input: {
  aspectRatio: string | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
}): boolean {
  if (input.aspectRatio && VERTICAL_ASPECT_RATIOS.has(input.aspectRatio)) return true;
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

/** One post block in the composer dialogue. */
export const ComposerDraftBlockSchema = z.object({
  id: z.string().min(1),
  text: z.string().max(5000),
  media: ComposerMediaSchema.nullable(),
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
  if (derived === 'text') {
    return { kind: 'text', platformFormat: null, caption: block.text, mediaItemIds: [] };
  }
  if (derived === 'image') {
    return {
      kind: 'image',
      platformFormat: null,
      caption: block.text,
      mediaItemIds: [media?.id as string],
    };
  }
  if (derived === 'reel') {
    return {
      kind: 'video',
      platformFormat: 'reel',
      caption: block.text,
      mediaItemIds: [media?.id as string],
    };
  }
  return {
    kind: 'video',
    platformFormat: null,
    caption: block.text,
    mediaItemIds: [media?.id as string],
  };
}
