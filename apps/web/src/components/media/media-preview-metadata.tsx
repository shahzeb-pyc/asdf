'use client';

/**
 * Preview metadata column (spec 133 §6.6 / PR-133-5, PB-8).
 *
 * The right column of the preview dialog: the "Asset Details" title,
 * plain label/value metadata rows (type, size, aspect ratio, duration
 * for video, upload date — PB-4), then the editable file name and the
 * caption editor with its character counter. Hairline dividers only —
 * no boxes inside the dialog (PB-1). No Schedule action and no
 * eligibility tags anywhere in the preview (PB-9).
 *
 * The fields are controlled by the shell, which owns the drafts and
 * the save/delete lockouts; this component presents them on the
 * shared/ui Input/Textarea primitives.
 */

import * as React from 'react';
import type { MediaItemResponse } from '@fbuploadpro/contracts';

import { DialogTitle } from '@/components/shared/ui/dialog';
import { Input } from '@/components/shared/ui/input';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/shared/ui/textarea';
import {
  formatBytes,
  formatDuration,
  formatUploadDate,
} from './media-types';

const CAPTION_LIMIT = 2200;

export interface MediaPreviewMetadataProps {
  item: MediaItemResponse;
  /** Grid placement from the shell's two-column layout. */
  className?: string | undefined;
  nameDraft: string;
  captionDraft: string;
  isSaving: boolean;
  isDeleting: boolean;
  onNameChange: (value: string) => void;
  onCaptionChange: (value: string) => void;
  /**
   * Picker use: the picker is browse + select only, so its preview
   * must not offer editing at all — not even editable-looking
   * fields whose Save is a no-op. Defaults false (library page).
   */
  readOnly?: boolean | undefined;
}

function MetadataRow({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-body">
      <span className="text-ink-dim">{label}</span>
      <span className="font-medium text-ink tabular-nums">{children}</span>
    </div>
  );
}

export function MediaPreviewMetadata({
  item,
  className,
  nameDraft,
  captionDraft,
  isSaving,
  isDeleting,
  onNameChange,
  onCaptionChange,
  readOnly = false,
}: Readonly<MediaPreviewMetadataProps>) {
  const isVideo = item.mediaType === 'video';
  const isBusy = isSaving || isDeleting;
  const fieldsDisabled = isBusy || readOnly;

  return (
    <div className={cn('flex min-w-0 flex-col gap-4 p-4 sm:p-6', className)}>
      <DialogTitle>Asset Details</DialogTitle>

      <div className="flex flex-col gap-2 border-b border-line pb-3">
        <MetadataRow label="Type">{isVideo ? 'Video' : 'Image'}</MetadataRow>
        <MetadataRow label="Size">{formatBytes(item.fileSize)}</MetadataRow>
        <MetadataRow label="Aspect ratio">
          {item.aspectRatio && item.aspectRatio !== 'unknown' ? item.aspectRatio : '—'}
        </MetadataRow>
        {isVideo ? (
          <MetadataRow label="Duration">
            {formatDuration(item.durationSeconds) || '—'}
          </MetadataRow>
        ) : null}
        <MetadataRow label="Upload date">{formatUploadDate(item.createdAt)}</MetadataRow>
      </div>

      {readOnly ? (
        <p className="text-metadata text-ink-sub">
          Names and captions are edited on the Media Library page, not
          here — this preview is for choosing the file.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="preview-filename-input"
          className="text-metadata font-semibold tracking-wide text-ink-dim uppercase"
        >
          File name
        </label>
        <Input
          id="preview-filename-input"
          type="text"
          data-testid="modal-filename-input"
          disabled={fieldsDisabled}
          value={nameDraft}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="preview-caption-textarea"
          className="text-metadata font-semibold tracking-wide text-ink-dim uppercase"
        >
          Caption
        </label>
        <Textarea
          id="preview-caption-textarea"
          data-testid="modal-caption-input"
          rows={4}
          disabled={fieldsDisabled}
          value={captionDraft}
          onChange={(e) => onCaptionChange(e.target.value)}
          placeholder="Add a caption..."
          className="resize-y"
        />
        <div className="flex justify-end text-metadata text-ink-dim tabular-nums">
          {captionDraft.length} / {CAPTION_LIMIT.toLocaleString('en-US')}
        </div>
      </div>
    </div>
  );
}
