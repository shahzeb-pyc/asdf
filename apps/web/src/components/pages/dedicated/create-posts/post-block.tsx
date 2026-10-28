'use client';

/**
 * One post block inside the Create Posts dialogue.
 *
 * A block is its own post: its own text field, its own attached
 * media, its own derived type label. The type is never picked — it
 * is derived from the block's content (see the contracts module).
 * The trailing "New post" block is the same component with
 * `isDraft`: it has no remove button, and typing or attaching in
 * it turns it into a real post (the dialogue appends a fresh empty
 * one below). There is deliberately no "+ Add another post" button:
 * adding posts never costs a click per post.
 */

import Image from 'next/image';
import { ImageIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { Textarea } from '@/components/shared/ui/textarea';
import {
  composerTextLimitForType,
  deriveComposerPostType,
  type ComposerDraftBlock,
} from '@fbuploadpro/contracts';
import { blockTypeLabel } from './create-posts-types';

const TYPE_NOUNS = {
  text: 'text post',
  image: 'image post',
  reel: 'reel',
  video: 'video post',
} as const;

export interface PostBlockProps {
  block: ComposerDraftBlock;
  /** "Post 1", "Post 2", … — or "New post" for the trailing draft. */
  label: string;
  isDraft: boolean;
  disabled?: boolean | undefined;
  onTextChange: (text: string) => void;
  onAttachRequest: () => void;
  onRemoveMedia: () => void;
  onRemove: () => void;
}

export function PostBlock({
  block,
  label,
  isDraft,
  disabled,
  onTextChange,
  onAttachRequest,
  onRemoveMedia,
  onRemove,
}: Readonly<PostBlockProps>) {
  const typeLabel = blockTypeLabel(block.text, block.media);
  // The limit follows the block's CURRENT derived type: attaching
  // or removing media flips the type (and the limit with it). Text
  // is never truncated here — over-limit input stays fully visible
  // and is flagged, so the user trims it deliberately.
  const derived = deriveComposerPostType({
    text: block.text,
    mediaType: block.media?.mediaType ?? null,
    aspectRatio: block.media?.aspectRatio ?? null,
    width: block.media?.width ?? null,
    height: block.media?.height ?? null,
  });
  const limit = composerTextLimitForType(derived);
  const count = block.text.length;
  const over = count - limit;

  return (
    <div
      data-testid="create-posts-block"
      className="rounded-md border border-line bg-canvas p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-body font-semibold text-ink">{label}</span>
        <span className="flex items-center gap-2">
          <span
            data-testid="create-posts-block-type"
            className="text-metadata text-brand-gold"
          >
            {typeLabel}
          </span>
          {!isDraft && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="create-posts-block-remove-btn"
              aria-label={`Remove ${label}`}
              disabled={disabled}
              onClick={onRemove}
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </span>
      </div>

      <Textarea
        data-testid="create-posts-block-text"
        placeholder="Write your post..."
        value={block.text}
        disabled={disabled}
        onChange={(event) => onTextChange(event.target.value)}
        className="min-h-16 border-0 bg-transparent px-0 py-0 focus-visible:border-0"
      />

      <div className="mt-1 flex items-center justify-between gap-2">
        <span
          data-testid="create-posts-block-char-count"
          className={
            over > 0 ? 'text-metadata text-brand-rose' : 'text-metadata text-ink-dim'
          }
        >
          {count.toLocaleString('en-US')} / {limit.toLocaleString('en-US')}
        </span>
        {over > 0 ? (
          <span
            data-testid="create-posts-block-over-limit"
            className="text-metadata text-brand-rose"
          >
            Over the {limit.toLocaleString('en-US')}-character{' '}
            {TYPE_NOUNS[derived]} limit by {over.toLocaleString('en-US')}{' '}
            characters.
          </span>
        ) : null}
      </div>

      {block.media ? (
        <div className="mt-2 flex items-center gap-3 rounded-md border border-line bg-panel p-2">
          {block.media.thumbnailUrl ? (
            <Image
              src={block.media.thumbnailUrl}
              alt={block.media.name}
              width={56}
              height={56}
              className="size-14 shrink-0 rounded-sm object-cover"
            />
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-ink">
              {block.media.name}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="create-posts-block-remove-media-btn"
            aria-label="Remove media"
            disabled={disabled}
            onClick={onRemoveMedia}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="create-posts-block-attach-btn"
          disabled={disabled}
          onClick={onAttachRequest}
          className="mt-2 rounded-full"
        >
          <ImageIcon aria-hidden />
          Attach media
        </Button>
      )}
    </div>
  );
}
