'use client';

import React from 'react';
import { DownloadIcon, FolderPlusIcon, UploadIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';

/**
 * Page header for the media library (spec 133 §6.2 / PR-133-2, PB-13).
 *
 * Rebuilt on the shared/ui primitives: "Upload Files" is the surface's
 * single primary Button, "New Folder" a quiet text action, and the
 * rendered-but-invisible file input is retained purely as the picker
 * mechanism (it must stay rendered — see its comment — so that
 * showPicker() is honored). The surface-local toast that used to
 * render here is deleted — all surface feedback goes through the
 * shared/ui Toast system mounted by the explorer (one toast system
 * product-wide, UI Rule 11).
 */

export interface MediaLibraryHeaderProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (files: File[]) => void;
  onNewFolderClick: () => void;
  onUploadClick: () => void;
  onDownloadClick: () => void;
  /**
   * Read-only library (storage over the plan limit): uploads and new
   * folders are disabled here; browsing, preview, and delete stay
   * enabled. The server gates are the enforcement — these flags are
   * only the visible half, so a disabled button never implies the
   * API would accept the write.
   */
  uploadDisabled?: boolean;
  newFolderDisabled?: boolean;
}

export function MediaLibraryHeader({
  fileInputRef,
  onFileInputChange,
  onNewFolderClick,
  onUploadClick,
  onDownloadClick,
  uploadDisabled = false,
  newFolderDisabled = false,
}: Readonly<MediaLibraryHeaderProps>) {
  return (
    <>
      {/*
        File picker mechanism. This input MUST stay rendered (positioned
        1px and transparent) — never display:none. showPicker() silently
        no-ops on a non-rendered input in spec-compliant browsers: it
        does not throw, so the click() fallback in the explorer never
        runs and Upload Files appears completely dead (launch bug
        2026-10-31: no picker, no dialog, no toast, no change).
        tabIndex -1 + aria-hidden keep it out of keyboard/AT order:
        it is a mechanism only, never a visible control.
      */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="media-library-file-input"
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none absolute h-px w-px opacity-0"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            const files = Array.from(e.target.files);
            e.target.value = '';
            onFileInputChange(files);
          }
        }}
      />

      {/* Page Header (no box, plain text — PB-1/PB-13) */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 data-testid="media-library-title" className="text-xxl font-bold tracking-tight text-ink">
            Media Library
          </h1>
          <p className="text-body text-ink-sub">
            Upload, organize, and caption your media for publishing queues.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* Quiet New Folder action */}
          <Button
            type="button"
            variant="link"
            data-testid="new-folder-link"
            onClick={onNewFolderClick}
            disabled={newFolderDisabled}
            className="h-11 px-1 text-body md:h-10"
          >
            <FolderPlusIcon aria-hidden />
            <span>New Folder</span>
          </Button>

          {/* Single Primary Button: Upload Files (UI Rule 1).
              44px at every width — the surface's primary touch target
              (spec 142 gate). Download stays secondary: one primary
              per surface, so it is the outline button beside Upload. */}
          <Button
            type="button"
            variant="outline"
            data-testid="download-files-btn"
            onClick={onDownloadClick}
            className="h-11"
          >
            <DownloadIcon aria-hidden />
            <span>Download</span>
          </Button>
          <Button
            type="button"
            data-testid="upload-files-btn"
            onClick={onUploadClick}
            disabled={uploadDisabled}
            className="h-11"
          >
            <UploadIcon aria-hidden />
            <span>Upload Files</span>
          </Button>
        </div>
      </header>
    </>
  );
}
