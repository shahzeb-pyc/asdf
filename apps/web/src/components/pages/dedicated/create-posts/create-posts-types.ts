import {
  deriveComposerPostType,
  type ComposerDerivedType,
  type ComposerMedia,
} from '@fbuploadpro/contracts';

/**
 * The fields the composer needs from a library item. Both the API
 * list item (`MediaItem`) and the contracts list item
 * (`MediaItemResponse`, what the library queries return) satisfy it —
 * the picker's browser works off the library queries, the import
 * modal's success payload is a `MediaItemResponse`, and the old
 * picker confirm path produced a `MediaItem`.
 */
export interface ComposerMediaInput {
  id: string;
  name: string;
  mediaType: 'image' | 'video';
  aspectRatio: string | null;
  thumbnailUrl: string | null;
  url: string;
  // `| undefined` is required here: the repo compiles with
  // `exactOptionalPropertyTypes`, under which an optional prop
  // typed `number | null` rejects an explicit `undefined` — and the
  // library's `MediaItemResponse` carries width/height/captionText
  // as `… | undefined` when absent.
  width?: number | null | undefined;
  height?: number | null | undefined;
  captionText?: string | null | undefined;
}

/** Maps a library list item onto the composer's attached-media shape. */
export function toComposerMedia(item: ComposerMediaInput): ComposerMedia {
  return {
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    aspectRatio: item.aspectRatio ?? 'unknown',
    thumbnailUrl: item.thumbnailUrl,
    url: item.url,
    width: item.width ?? null,
    height: item.height ?? null,
    captionText: item.captionText ?? null,
  };
}

/** The small muted type label shown on each post block. */
export function composerPostTypeLabel(
  derived: ComposerDerivedType,
  hasCaption: boolean
): string {
  if (derived === 'text') return 'Text post';
  if (derived === 'image') {
    return hasCaption ? 'Image post with caption' : 'Image post, no caption';
  }
  if (derived === 'reel') return 'Reel';
  return 'Video post';
}

/** Derives a block's type label from its text + attached media. */
export function blockTypeLabel(
  text: string,
  media: ComposerMedia | null
): string {
  const derived = deriveComposerPostType({
    text,
    mediaType: media?.mediaType ?? null,
    aspectRatio: media?.aspectRatio ?? null,
    width: media?.width ?? null,
    height: media?.height ?? null,
  });
  return composerPostTypeLabel(derived, text.trim().length > 0);
}
