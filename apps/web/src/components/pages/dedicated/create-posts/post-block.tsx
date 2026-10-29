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
 *
 * Flat composer styling, deliberately: a block is NOT a card.
 * There is no per-post background, border, rounded box, or shadow
 * — the dialogue surface is the only surface. Posts are separated
 * by spacing, their header row, and the hairline divider the
 * dialogue list puts between them (see create-posts-dialog.tsx),
 * the way a Facebook composer reads as one continuous flow
 * rather than boxes inside a box.
 */

import * as React from 'react';
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
    <div data-testid="create-posts-block" className="shrink-0 py-5 first:pt-1">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-body font-semibold text-ink">{label}</span>
        <span className="flex items-center gap-2">
          <span
            data-testid="create-posts-block-type"
            className="text-metadata text-link"
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
        className="min-h-20 border-0 bg-transparent px-0 py-0 focus-visible:border-0"
      />

      {/* Count and attach share one inline row on the flat surface:
          no boxed footer, no inner panel. Over-limit stays plain
          text in rose, never a boxed error. */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid="create-posts-block-char-count"
          className={
            over > 0 ? 'text-metadata text-signal-critical' : 'text-metadata text-ink-dim'
          }
        >
          {count.toLocaleString('en-US')} / {limit.toLocaleString('en-US')}
        </span>
        {over > 0 ? (
          <span
            data-testid="create-posts-block-over-limit"
            className="text-metadata text-signal-critical"
          >
            Over the {limit.toLocaleString('en-US')}-character{' '}
            {TYPE_NOUNS[derived]} limit by {over.toLocaleString('en-US')}{' '}
            characters.
          </span>
        ) : null}
        {!block.media ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="create-posts-block-attach-btn"
            disabled={disabled}
            onClick={onAttachRequest}
            className="rounded-full"
          >
            <ImageIcon aria-hidden />
            Attach media
          </Button>
        ) : null}
      </div>

      {block.media ? (
        <>
          {/* Attached media sits inline on the same flat surface:
              thumbnail + name + remove, no border, background, or
              padding box around it. */}
          <div className="mt-3 flex items-center gap-3">
            {block.media.thumbnailUrl ? (
              <Image
                src={block.media.thumbnailUrl}
                alt={block.media.name}
                width={64}
                height={64}
                className="size-16 shrink-0 rounded-sm object-cover"
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
          <p className="mt-1 text-metadata text-ink-sub">
            Removing the media keeps this caption — the post becomes a
            text post.
          </p>
        </>
      ) : null}
    </div>
  );
}
