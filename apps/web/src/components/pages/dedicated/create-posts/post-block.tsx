'use client';

/**
 * One post block's editor inside the Create Posts dialogue.
 *
 * A block is its own post: its own caption, its own attached media,
 * its own derived type label. The type is never picked — it is
 * derived from the block's content (see the contracts module).
 * The trailing "New post" block is the same component with
 * `isDraft`: it has no remove button, and typing or attaching in
 * it turns it into a real post (the dialogue appends a fresh empty
 * one below). There is deliberately no "+ Add another post" button:
 * adding posts never costs a click per post.
 *
 * The caption field carries a real label and its character count
 * inset at the field's bottom-right, so the count is read where the
 * text is written. Attached media shows an uploaded tick; removing
 * media keeps the caption, and the note below says so plainly, so
 * the block never silently changes into a different kind of post.
 */

import Image from 'next/image';
import { CheckIcon, ImageIcon, XIcon } from 'lucide-react';

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
  const captionId = `create-posts-caption-${block.id}`;

  return (
    <div
      data-testid="create-posts-block"
      className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3"
    >
      <div className="flex items-center justify-between gap-2">
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

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={captionId}
          className="text-metadata font-semibold tracking-wide text-ink-dim uppercase"
        >
          Caption
        </label>
        <div className="relative">
          <Textarea
            id={captionId}
            data-testid="create-posts-block-text"
            placeholder="Write your post..."
            value={block.text}
            disabled={disabled}
            onChange={(event) => onTextChange(event.target.value)}
            className="min-h-20 border-0 bg-transparent px-0 pt-0 pb-6 focus-visible:border-0"
          />
          <span
            data-testid="create-posts-block-char-count"
            className={
              over > 0
                ? 'absolute right-1 bottom-1 text-metadata text-brand-rose tabular-nums'
                : 'absolute right-1 bottom-1 text-metadata text-ink-dim tabular-nums'
            }
          >
            {count.toLocaleString('en-US')} / {limit.toLocaleString('en-US')}
          </span>
        </div>
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
        <p className="text-metadata text-ink-sub">
          A file&apos;s saved caption only fills an empty post — your
          text here is never overwritten.
        </p>
      </div>

      {block.media ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-metadata font-semibold tracking-wide text-ink-dim uppercase">
            Attached media
          </span>
          <div className="flex items-center gap-3 rounded-md border border-line bg-panel p-2">
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
              <span className="flex items-center gap-1.5 text-metadata text-brand-emerald">
                <span className="flex size-4 items-center justify-center rounded-full bg-brand-emerald/15">
                  <CheckIcon className="size-3" aria-hidden />
                </span>
                Attached
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
          <p className="text-metadata text-ink-sub">
            Removing the media keeps this caption — the post becomes a
            text post.
          </p>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="create-posts-block-attach-btn"
          disabled={disabled}
          onClick={onAttachRequest}
          className="mt-1 self-start rounded-full"
        >
          <ImageIcon aria-hidden />
          Attach media
        </Button>
      )}
    </div>
  );
}
