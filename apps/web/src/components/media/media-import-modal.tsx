'use client';

/**
 * Media import dialog (spec 133 PR-133-4, spec §6.5 / PB-2, PB-3,
 * PB-12, PB-18).
 *
 * Rebuilt as ONE shared/ui Dialog with staging / progress / complete
 * modes — the hand-rolled fixed layer and its numeric z-index are
 * gone; focus trap, Esc handling and focus return come from the
 * primitive (UI Rule 17/18). Esc closes only in staging (and on the
 * completion summary, where it means Done); during progress it does
 * nothing — leaving mid-upload is the leave-page guard's job (PB-19),
 * and "Keep working" minimises to the OD-133-4(a) chip instead.
 *
 * Behaviour preserved from the legacy dialog: ROWS-style staging
 * with duplicate flags + per-row remove, "Start import (n)", the
 * 3-concurrency engine with "queued · #n", per-file
 * pause/resume/cancel/retry, the completion summary, second imports
 * appending to the same queue, and destination defaulting to the
 * viewed folder. The duplicate check goes through the data module's
 * single typed-client call path (spec §6.1); its failure is reported
 * and staging continues unflagged — duplicates are advisory, the
 * check never blocks an import.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { MediaFolder, MediaItemResponse } from '@fbuploadpro/contracts';
import { AllowedMediaMimeTypes } from '@fbuploadpro/contracts';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Button } from '@/components/shared/ui/button';
import { reportError } from '@/lib/report-error';
import { checkMediaDuplicates } from './media-data';
import type { ImportQueueItem } from './media-types';
import {
  computeOverallProgress,
  computeFurthestAlong,
  buildImportQueueItems,
  isItemReadyToImport,
} from './media-import-utils';
import { useImportUpload } from './media-import-upload-engine';
import {
  ImportStagingHeader,
  ImportStagingRow,
  ImportStagingFooter,
} from './media-import-staging';
import {
  ImportProgressHeader,
  ImportProgressFooter,
  MinimizedUploadPill,
} from './media-import-progress';
import { ImportProgressRow } from './media-import-progress-row';

export interface MediaImportModalProps {
  subdomain: string;
  isOpen: boolean;
  initialFiles: File[];
  currentFolderId: string | null;
  folders: MediaFolder[];
  onClose: () => void;
  onUploadSuccess: (item: MediaItemResponse) => void;
  onActiveUploadsChange?: (
    count: number,
    furthestAlong: { name: string; progressPercent: number } | null
  ) => void;
  /**
   * Picker use only (the Create Posts attach flow): the destination
   * is fixed — device uploads must land in the page's folder, so the
   * staging destination picker is replaced by static text. Default
   * off: the library page keeps its changeable destination.
   */
  lockDestination?: boolean | undefined;
}

type ImportStep = 'staging' | 'progress' | 'complete';

export function MediaImportModal({
  subdomain,
  isOpen,
  initialFiles,
  currentFolderId,
  folders,
  onClose,
  onUploadSuccess,
  onActiveUploadsChange,
  lockDestination = false,
}: Readonly<MediaImportModalProps>) {
  const [step, setStep] = useState<ImportStep>('staging');
  const [isMinimized, setIsMinimized] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(currentFolderId);
  const [queue, setQueue] = useState<ImportQueueItem[]>(() =>
    isOpen && initialFiles.length > 0
      ? buildImportQueueItems(initialFiles, currentFolderId)
      : []
  );
  const [userInitiatedCancel, setUserInitiatedCancel] = useState(false);
  const [isStartingImport, setIsStartingImport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync destination folder default when opening (PB-12).
  useEffect(() => {
    if (isOpen) {
      setSelectedFolderId(currentFolderId);
    } else {
      setIsStartingImport(false);
    }
  }, [isOpen, currentFolderId]);

  // Append newly picked files to the staging queue — a second import
  // while one is staged joins the same list, never a second dialog.
  // (Deduped by name+size inside buildImportQueueItems, so re-runs
  // when the destination changes are no-ops, as in the legacy modal.)
  useEffect(() => {
    if (!isOpen || initialFiles.length === 0 || step !== 'staging') return;

    setQueue((prevQueue) => {
      const newItems = buildImportQueueItems(initialFiles, selectedFolderId, prevQueue);
      if (newItems.length === 0) return prevQueue;
      return [...prevQueue, ...newItems];
    });
  }, [isOpen, initialFiles, selectedFolderId, step]);

  // Server-side duplicate detection (single typed call path, §6.1).
  const queueLength = queue.length;
  useEffect(() => {
    if (step !== 'staging' || queueLength === 0) return;
    let cancelled = false;

    const checkDuplicates = async () => {
      try {
        const entries = queue.map((item) => ({
          clientKey: item.id,
          name: item.name,
          fileSize: item.size,
          folderId: selectedFolderId,
        }));

        const data = await checkMediaDuplicates(subdomain, selectedFolderId, entries);
        if (cancelled) return;
        const duplicateIds = new Set(data.duplicates.map((d) => d.clientKey));

        if (duplicateIds.size > 0) {
          setQueue((prev) =>
            prev.map((item) =>
              duplicateIds.has(item.id) ? { ...item, isDuplicate: true } : item
            )
          );
        }
      } catch (err) {
        // Advisory only: report it and leave the rows unflagged — a
        // failed duplicate check must never block an import (PB-18).
        reportError(err, { source: 'media-import-duplicate-check' });
      }
    };

    void checkDuplicates();
    return () => {
      cancelled = true;
    };
    // `queue` identity changes on every render; the check keys off
    // the staged set's size + destination, as the legacy check did.
  }, [step, subdomain, selectedFolderId, queueLength]);

  // Derived counts
  const validStagedItems = queue.filter(isItemReadyToImport);
  const activeUploadingItems = queue.filter((item) => item.status === 'uploading');
  const queuedItems = queue.filter((item) => item.status === 'queued');
  const completedItems = queue.filter((item) => item.status === 'completed');
  const nonCancelledItems = queue.filter((item) => item.status !== 'cancelled');

  // Furthest along progress
  const furthestAlong = computeFurthestAlong(activeUploadingItems);

  // Notify parent of active upload state for leave-page protection (PB-19).
  const activeCount = activeUploadingItems.length + queuedItems.length;
  useEffect(() => {
    onActiveUploadsChange?.(activeCount, furthestAlong);
  }, [activeCount, furthestAlong, onActiveUploadsChange]);

  const updateItemProgress = useCallback((id: string, pct: number) => {
    setQueue((prev) =>
      prev.map((it) => (it.id === id ? { ...it, progressPercent: pct } : it))
    );
  }, []);

  const uploadFile = useImportUpload({
    subdomain,
    selectedFolderId,
    queue,
    step,
    setQueue,
    setStep,
    updateItemProgress,
    onUploadSuccess,
  });

  // Actions
  const handleStartImport = () => {
    if (isStartingImport || validStagedItems.length === 0) return;
    setIsStartingImport(true);
    setUserInitiatedCancel(false);
    setQueue((prev) =>
      prev.map((it) => (isItemReadyToImport(it) ? { ...it, status: 'queued' } : it))
    );
    setStep('progress');
  };

  const handleRemoveStagedItem = (id: string) => {
    setQueue((prev) => prev.filter((it) => it.id !== id));
  };

  const handleKeepDuplicate = (id: string) => {
    setQueue((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, isDuplicate: false, duplicateResolution: 'keep' } : it
      )
    );
  };

  const handleSkipAllDuplicates = () => {
    setQueue((prev) => prev.filter((it) => !it.isDuplicate));
  };

  const handlePauseUpload = (id: string) => {
    setQueue((prev) =>
      prev.map((it) => {
        if (it.id === id) {
          it.abortController?.abort();
          return { ...it, status: 'paused' };
        }
        return it;
      })
    );
  };

  const handleResumeUpload = (id: string) => {
    const item = queue.find((it) => it.id === id);
    if (item) {
      void uploadFile(item);
    }
  };

  const handleCancelUpload = (id: string) => {
    setUserInitiatedCancel(true);
    setQueue((prev) =>
      prev.map((it) => {
        if (it.id === id) {
          it.abortController?.abort();
          return { ...it, status: 'cancelled' };
        }
        return it;
      })
    );
  };

  const handleRetryUpload = (id: string) => {
    setQueue((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, status: 'queued', retryCount: 0, validationError: null } : it
      )
    );
  };

  const handleCancelRemaining = () => {
    setUserInitiatedCancel(true);
    // Cancels queued only, never in-flight
    setQueue((prev) =>
      prev.map((it) => (it.status === 'queued' ? { ...it, status: 'cancelled' } : it))
    );
  };

  const handleDone = useCallback(() => {
    setQueue([]);
    setStep('staging');
    setIsMinimized(false);
    onClose();
  }, [onClose]);

  // Staging is pre-upload and disposable: dismissing it (Cancel, Esc,
  // backdrop, close button) discards the staged list. The legacy dialog
  // kept its queue mounted after Cancel (its render condition was
  // `isOpen || queue.length > 0`), so Cancel visibly did nothing; the
  // rebuild makes dismissal real and records the difference here.
  const handleDismissStaging = useCallback(() => {
    setQueue([]);
    setStep('staging');
    onClose();
  }, [onClose]);

  const dialogOpen = isOpen || queue.length > 0;

  const handleOpenChange = (next: boolean) => {
    if (next) return;
    if (step === 'staging') {
      handleDismissStaging();
    } else if (step === 'complete') {
      handleDone();
    }
    // Progress: dismissal is blocked — Keep working minimises instead.
  };

  // Minimized dock (OD-133-4(a)): uploads continue behind the chip.
  if (isMinimized) {
    const totalCount = nonCancelledItems.length;
    const completedCount = completedItems.length;
    const overallPct =
      totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    return (
      <MinimizedUploadPill
        completedCount={completedCount}
        totalCount={totalCount}
        overallPercent={overallPct}
        onRestore={() => setIsMinimized(false)}
      />
    );
  }

  const destinationFolderName =
    (selectedFolderId ? folders.find((f) => f.id === selectedFolderId)?.name : null) ||
    'Library';

  const overallProgressPercent = computeOverallProgress(nonCancelledItems);

  const duplicatesCount = queue.filter((it) => it.isDuplicate).length;
  const isAllCancelled =
    completedItems.length === 0 &&
    (userInitiatedCancel || queue.every((it) => it.status === 'cancelled'));

  const title =
    step === 'staging'
      ? 'Import media'
      : step === 'complete'
        ? isAllCancelled
          ? 'Import canceled'
          : 'Import complete'
        : 'Importing media';

  // 1-based positions among the waiting files, for "queued · #n" (PB-3).
  const queuePositions = new Map<string, number>();
  queuedItems.forEach((item, index) => {
    queuePositions.set(item.id, index + 1);
  });

  return (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="media-import-modal"
        aria-labelledby="import-media-title"
        showCloseButton={step !== 'progress'}
        onInteractOutside={(e) => {
          // Staging dismisses on backdrop click (legacy behaviour);
          // progress never dismisses by accident.
          if (step !== 'staging') e.preventDefault();
        }}
        className="sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle id="import-media-title" data-testid="import-modal-title">
            {title}
          </DialogTitle>
        </DialogHeader>

        {step === 'staging' ? (
          <ImportStagingHeader
            totalCount={queue.length}
            destinationFolderName={destinationFolderName}
            selectedFolderId={selectedFolderId}
            folders={folders}
            onSelectFolder={setSelectedFolderId}
            lockDestination={lockDestination}
          />
        ) : (
          <ImportProgressHeader
            step={step}
            destinationFolderName={destinationFolderName}
            completedCount={completedItems.length}
            totalCount={queue.length}
            isAllCancelled={isAllCancelled}
            overallProgressPercent={overallProgressPercent}
          />
        )}

        {/* Scrollable file list */}
        <div
          data-testid="import-files-list"
          className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto sm:max-h-96"
        >
          {/* Duplicate banner (staging mode only) */}
          {step === 'staging' && duplicatesCount > 0 && (
            <div
              data-testid="duplicate-banner"
              className="flex items-center justify-between gap-3 border border-brand-gold/40 bg-brand-gold/10 px-3 py-2 text-body text-brand-gold"
            >
              <span>
                {duplicatesCount} possible duplicate{duplicatesCount === 1 ? '' : 's'} found
              </span>
              <Button
                type="button"
                variant="link"
                data-testid="skip-all-duplicates-btn"
                onClick={handleSkipAllDuplicates}
                className="h-11 px-0 text-body font-semibold"
              >
                Skip all
              </Button>
            </div>
          )}

          {queue.map((item) =>
            step === 'staging' ? (
              <ImportStagingRow
                key={item.id}
                item={item}
                onRemove={handleRemoveStagedItem}
                onKeepDuplicate={handleKeepDuplicate}
              />
            ) : (
              <ImportProgressRow
                key={item.id}
                item={item}
                destinationFolderName={destinationFolderName}
                queuePosition={queuePositions.get(item.id)}
                onPause={handlePauseUpload}
                onResume={handleResumeUpload}
                onCancel={handleCancelUpload}
                onRetry={handleRetryUpload}
              />
            )
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-line pt-4">
          {step === 'staging' ? (
            <ImportStagingFooter
              validCount={validStagedItems.length}
              isStarting={isStartingImport}
              onAddMore={() => fileInputRef.current?.click()}
              onCancel={handleDismissStaging}
              onStart={handleStartImport}
            />
          ) : (
            <ImportProgressFooter
              step={step}
              isUploading={activeUploadingItems.length > 0}
              canCancelRemaining={queuedItems.length > activeUploadingItems.length}
              onCancelRemaining={handleCancelRemaining}
              onKeepWorking={() => setIsMinimized(true)}
              onDone={handleDone}
            />
          )}
        </div>

        {/* Hidden file input for "+ Add more" */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={AllowedMediaMimeTypes.join(',')}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              const newFiles = Array.from(e.target.files);
              e.target.value = '';
              setQueue((prev) => [
                ...prev,
                ...buildImportQueueItems(newFiles, selectedFolderId, prev),
              ]);
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
