'use client';

/**
 * Post preview for the Create Posts dialogue's editor pane.
 *
 * This is what the post will look like — not a thumbnail strip:
 * media at post size (image contained, video with controls and the
 * thumbnail as poster), the caption rendered as the post body, and
 * the derived type shown. No media and no text yet means the
 * designed empty state, with the attach action, instead of a blank
 * panel. The preview never edits: caption and media edits happen in
 * the editor above it.
 */

import { CheckIcon, ImageIcon } from 'lucide-react';
import { Button } from '@/components/shared/ui/button';
import type { ComposerDraftBlock } from '@fbuploadpro/contracts';
import { blockTypeLabel } from './create-posts-types';

export interface PostPreviewProps {
  block: ComposerDraftBlock;
  /** Human-readable expected time, when the dialogue could compute one. */
  estimateLabel?: string | null | undefined;
  disabled?: boolean | undefined;
  onAttachRequest: () => void;
}

export function PostPreview({
  block,
  estimateLabel,
  disabled,
  onAttachRequest,
}: Readonly<PostPreviewProps>) {
  const media = block.media;
  const hasText = block.text.trim().length > 0;
  const typeLabel = blockTypeLabel(block.text, media);

  return (
    <div data-testid="create-posts-preview" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-metadata font-semibold tracking-wide text-ink-dim uppercase">
          Post preview
        </span>
        <span className="text-metadata text-brand-gold">{typeLabel}</span>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-line bg-canvas p-3">
        {hasText ? (
          <p className="text-body whitespace-pre-line text-ink break-words">
            {block.text}
          </p>
        ) : null}

        {media ? (
          <div className="flex flex-col gap-2">
            {media.mediaType === 'video' ? (
              <video
                data-testid="create-posts-preview-video"
                src={media.url}
                poster={media.thumbnailUrl ?? undefined}
                controls
                preload="metadata"
                className="max-h-65 w-full rounded-md bg-black/40 object-contain"
              />
            ) : (
              <img
                data-testid="create-posts-preview-image"
                src={media.thumbnailUrl ?? media.url}
                alt={media.name}
                className="max-h-65 w-full rounded-md bg-black/40 object-contain"
              />
            )}
            <span className="flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-emerald/15 text-brand-emerald">
                <CheckIcon className="size-3" aria-hidden />
              </span>
              <span className="min-w-0 truncate text-metadata text-ink-sub">
                {media.name} · Attached
              </span>
            </span>
          </div>
        ) : hasText ? (
          <p className="text-metadata text-ink-sub">
            No media — this will post as text.
          </p>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line px-4 py-6 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-subtle">
              <ImageIcon className="size-6 text-ink-dim" aria-hidden />
            </span>
            <p className="text-body font-semibold text-ink">
              Nothing to preview yet
            </p>
            <p className="text-metadata text-ink-sub">
              Write a caption or attach media to see how this post will
              look.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="create-posts-preview-attach-btn"
              disabled={disabled}
              onClick={onAttachRequest}
              className="rounded-full"
            >
              <ImageIcon aria-hidden />
              Attach media
            </Button>
          </div>
        )}
      </div>

      <p className="text-metadata text-ink-sub">
        {estimateLabel ?? 'Goes out at your next posting time.'}
      </p>
    </div>
  );
}
