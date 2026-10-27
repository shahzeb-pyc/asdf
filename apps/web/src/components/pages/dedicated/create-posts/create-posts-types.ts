import {
  deriveComposerPostType,
  type ComposerDerivedType,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import type { MediaItem } from '@/lib/api/schemas/media';

/** Maps a library list item onto the composer's attached-media shape. */
export function toComposerMedia(item: MediaItem): ComposerMedia {
  return {
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    aspectRatio: item.aspectRatio,
    thumbnailUrl: item.thumbnailUrl,
    url: item.url,
    width: item.width ?? null,
    height: item.height ?? null,
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
