'use client';

/**
 * Preview modal shell (spec 133 §6.6 / PR-133-5, PB-8 / PB-14).
 *
 * The slim composition that replaces the 969-line legacy monolith.
 * The monolith is decomposed into focused units in this folder —
 * `media-preview-viewer.tsx` (media pane + scrubber + spec-113
 * fallback chain + frame capture trigger), `media-preview-metadata.tsx`
 * (label/value rows + name/caption editors), `media-preview-footer.tsx`
 * (Delete / Cancel / Save changes), and `video-frame-capture.ts` (the
 * pure capture utility) — and this shell owns only the dialog itself:
 * shared/ui Dialog composition (focus trap/return, Esc, backdrop —
 * the legacy hand-rolled <dialog> layer and the subtree's last
 * legacy-ui dialog import die here), the name/caption drafts,
 * Previous/Next wiring, and the action lockouts.
 *
 * EXTERNAL CONTRACT — FROZEN in PR-133-3 (plan.md sequencing):
 * `MediaPreviewModalProps` below is exactly the contract the overlays
 * composition mounts (`<MediaPreviewModal item open onOpenChange
 * onSave onDelete />`); this PR changed internals only. The delete
 * confirmation is the shared/ui AlertDialog destructive pattern
 * (verb-named, focus on Keep, no Esc/outside dismissal — UI Rule 3).
 * A failed save stays open with the failure stated inline in the
 * footer (spec §7.2) instead of the legacy silent close.
 */

import React, { useEffect, useState } from 'react';
import type { MediaItemResponse } from '@fbuploadpro/contracts';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Dialog, DialogContent } from '@/components/shared/ui/dialog';
import { reportError } from '@/lib/report-error';
import { deriveDefaultCaption } from './media-types';
import { MediaPreviewFooter } from './media-preview-footer';
import { MediaPreviewMetadata } from './media-preview-metadata';
import { MediaPreviewViewer } from './media-preview-viewer';
import type { CapturedVideoFrame } from './video-frame-capture';

export type { CapturedVideoFrame } from './video-frame-capture';
export { captureVideoFrameAsWebp } from './video-frame-capture';
export { resolvePreviewImageSrc } from './media-preview-viewer';

export interface MediaPreviewModalProps {
  item: MediaItemResponse | null;
  open: boolean;
  hasPrevious?: boolean | undefined;
  hasNext?: boolean | undefined;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  onOpenChange: (open: boolean) => void;
  onSave?:
    | ((
        mediaId: string,
        updates: { name?: string; captionText?: string }
      ) => Promise<void> | void)
    | undefined;
  onUpdateThumbnail?:
    | ((
        mediaId: string,
        captured: CapturedVideoFrame
      ) => Promise<void> | void)
    | undefined;
  onDelete?: ((mediaId: string) => Promise<void> | void) | undefined;
  /**
   * Picker use: the picker is browse + select only, so its preview
   * shows metadata read-only and no Save button. Defaults false
   * (library page keeps full editing).
   */
  readOnlyMetadata?: boolean | undefined;
  /** P7: picker single-attach action, rendered instead of Save. */
  primaryAction?:
    | { label: string; onClick: () => void; testid?: string | undefined }
    | undefined;
}

export function MediaPreviewModal({
  item,
  open,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onOpenChange,
  onSave,
  onUpdateThumbnail,
  onDelete,
  readOnlyMetadata = false,
  primaryAction,
}: Readonly<MediaPreviewModalProps>) {
  const [nameDraft, setNameDraft] = useState(() => item?.name || '');
  const [captionDraft, setCaptionDraft] = useState(
    () => item?.captionText ?? (item ? deriveDefaultCaption(item.name) : '')
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (item && open) {
      setNameDraft(item.name || '');
      setCaptionDraft(item.captionText ?? deriveDefaultCaption(item.name));
      setSaveError(null);
    }
  }, [item, open]);

  if (!item) return null;

  const isBusy = isSaving || isDeleting;

  const handleOpenChange = (next: boolean) => {
    // An in-flight save/delete owns the dialog until it settles —
    // no dismissal path (Esc, backdrop, close button, Cancel is
    // disabled separately) may strand the operation (spec 071).
    if (!next && isBusy) return;
    onOpenChange(next);
  };

  const handleSaveChanges = async () => {
    if (!onSave || isBusy || readOnlyMetadata) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave(item.id, {
        name: nameDraft.trim() || item.name,
        captionText: captionDraft.trim(),
      });
      onOpenChange(false);
    } catch (error) {
      reportError(error, { source: 'media-preview-save' });
      setSaveError('Could not save changes. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!onDelete || isBusy) return;
    setIsDeleting(true);
    try {
      await onDelete(item.id);
      setShowDeleteConfirm(false);
      onOpenChange(false);
    } catch (error) {
      reportError(error, { source: 'media-preview-delete' });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          data-testid="media-preview-modal"
          aria-describedby={undefined}
          className="flex flex-col gap-0 p-0 sm:max-w-4xl"
        >
          <div className="grid min-h-0 flex-1 md:grid-cols-5">
            <MediaPreviewViewer
              item={item}
              isBusy={isBusy}
              className="md:col-span-3"
              hasPrevious={hasPrevious}
              hasNext={hasNext}
              onPrevious={onPrevious}
              onNext={onNext}
              onUpdateThumbnail={onUpdateThumbnail}
            />
            <MediaPreviewMetadata
              item={item}
              className="md:col-span-2"
              nameDraft={nameDraft}
              captionDraft={captionDraft}
              isSaving={isSaving}
              isDeleting={isDeleting}
              onNameChange={setNameDraft}
              onCaptionChange={setCaptionDraft}
              readOnly={readOnlyMetadata}
            />
          </div>

          <MediaPreviewFooter
            hasDelete={Boolean(onDelete)}
            isSaving={isSaving}
            isDeleting={isDeleting}
            saveError={saveError}
            onDelete={onDelete ? () => setShowDeleteConfirm(true) : undefined}
            onCancel={() => handleOpenChange(false)}
            onSave={handleSaveChanges}
            hideSave={readOnlyMetadata && !primaryAction}
            primaryAction={primaryAction}
          />
        </DialogContent>
      </Dialog>

      {/* Single-asset delete confirmation (AlertDialog pattern). */}
      <AlertDialog
        open={showDeleteConfirm}
        onOpenChange={(next) => {
          if (!next) setShowDeleteConfirm(false);
        }}
      >
        <AlertDialogContent
          data-testid="preview-delete-confirm-dialog"
          className="sm:max-w-md"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{item.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="preview-delete-keep-btn" disabled={isDeleting}>
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="preview-delete-confirm-btn"
              disabled={isDeleting}
              onClick={(event) => {
                // Stay open until the delete settles: success closes
                // from the handler; a failure keeps the confirm up.
                event.preventDefault();
                void handleConfirmDelete();
              }}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
