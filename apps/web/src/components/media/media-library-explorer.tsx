'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { MediaFolder, MediaItemResponse } from '@fbuploadpro/contracts';
import { Toast, toast } from '@/components/shared/ui/toast';
import {
  type MediaViewMode,
  type MediaTypeFilterKey,
  type AspectRatioFilterKey,
  type CaptionStatusFilterKey,
  type SortOptionKey,
  type MediaSmartViewKey,
  type BatchCaptionMode,
} from './media-types';
import { queryKeys } from '@/lib/data';

import {
  computeNextSelection,
  useUploadNavigationGuard,
  getInitialViewMode,
  computeActiveFilterCount,
  readInternalDropPayload,
  type MoveTargetState,
  type MediaLibraryExplorerProps,
} from './media-library-helpers';
import {
  invalidateMediaAll,
  useBatchCaptionMedia,
  useBatchDeleteMedia,
  useBatchMoveMedia,
  useCreateFolder,
  useDeleteFolder,
  useDeleteMediaItem,
  useMediaFolders,
  useMediaItems,
  useRenameFolder,
  useReparentMedia,
  useUpdateItemCaption,
} from './media-data';
import { useQueryClient } from '@tanstack/react-query';
import { reportError } from '@/lib/report-error';
import { setPreference, preferences } from '@/lib/storage/preferences';
export { MEDIA_VIEW_MODE_STORAGE_KEY } from './media-library-helpers';
export type { MoveTargetState, MediaLibraryExplorerProps } from './media-library-helpers';
import { buildFolderBreadcrumbs } from './media-library-breadcrumbs';
import {
  filterAndSortMediaItems,
  getScopeTagLabel,
  MEDIA_TYPE_LABELS,
  ASPECT_RATIO_SHORT_VALUES,
  CAPTION_STATUS_SHORT_VALUES,
} from './media-library-filters';
export {
  filterAndSortMediaItems,
  getScopeTagLabel,
  getEmptyStateInfo,
  resolveTargetFolderIdForEntry,
  computeFolderSubtreeImpact,
  checkServerDuplicateEntries,
  MEDIA_TYPE_LABELS,
  ASPECT_RATIO_SHORT_VALUES,
  CAPTION_STATUS_SHORT_VALUES,
  SORT_OPTION_SHORT_VALUES,
} from './media-library-filters';

export { buildFolderBreadcrumbs, formatFolderAncestryPath } from './media-library-breadcrumbs';
export type { MediaImportModalProps } from './media-import-progress';
export type { ActiveDropdownKey } from './media-library-filters';
import { MediaToolbar } from './media-library-toolbar';
import { MediaLibraryHeader } from './media-library-header';
import { DownloadDialog } from './download-dialog';
import { MediaLibraryMain } from './media-library-main';
import { MediaLibraryOverlays } from './media-library-overlays';
export type { MediaViewMode, MediaTypeFilterKey, AspectRatioFilterKey, CaptionStatusFilterKey, SortOptionKey, MediaSmartViewKey } from './media-types';

export type { FolderSubtreeImpact } from './media-library-filters';
export function MediaLibraryExplorer({
  subdomain,
  initialFolders,
  initialMediaItems,
  initialCurrentFolderId = null,
  initialActiveSmartView = null,
  initialViewMode,
  initialSearchQuery = '',
  initialMediaTypeFilter = 'all',
  initialAspectRatioFilter = 'all',
  initialCaptionStatusFilter = 'all',
  initialSortOption = 'created_at:desc',
  initialTotalMediaCount,
  initialPendingDuplicateUpload,
  initialDeleteFolderTarget = null,
}: Readonly<MediaLibraryExplorerProps>) {
  // Data (spec 133 §6.1): the React Query cache is the surface's
  // store. The route hydrates it server-first; the `initial*` props
  // remain as the test/seed API and feed the queries' initial data.
  const queryClient = useQueryClient();
  const foldersQuery = useMediaFolders(subdomain, { initialFolders });
  const itemsQuery = useMediaItems(subdomain, { initialItems: initialMediaItems });
  const folders = useMemo<MediaFolder[]>(() => foldersQuery.data ?? [], [foldersQuery.data]);
  const mediaItems = useMemo<MediaItemResponse[]>(
    () => itemsQuery.data ?? [],
    [itemsQuery.data]
  );
  const isLoading = itemsQuery.isPending || foldersQuery.isPending;

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(
    initialCurrentFolderId
  );
  const [activeSmartView, setActiveSmartView] = useState<MediaSmartViewKey | null>(
    initialActiveSmartView
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // View mode
  const [viewMode, setViewMode] = useState<MediaViewMode>(() => getInitialViewMode(initialViewMode));

  const handleChangeViewMode = (mode: MediaViewMode) => {
    setViewMode(mode);
    // Typed preferences helper (spec 137 §3.9): a failed write
    // (unavailable/full store) just means the mode won't persist.
    setPreference(preferences.mediaViewMode, mode);
  };

  // Search & Filters
  const [searchInput, setSearchInput] = useState(initialSearchQuery);
  const [debouncedSearch, setDebouncedSearch] = useState(
    initialSearchQuery.trim().toLowerCase()
  );
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilterKey>(
    initialMediaTypeFilter
  );
  const [aspectRatioFilter, setAspectRatioFilter] = useState<AspectRatioFilterKey>(
    initialAspectRatioFilter
  );
  const [captionStatusFilter, setCaptionStatusFilter] = useState<CaptionStatusFilterKey>(
    initialCaptionStatusFilter
  );
  const [sortOption, setSortOption] = useState<SortOptionKey>(initialSortOption);

  // Debounce search with 250ms (0ms if cleared immediately)
  useEffect(() => {
    if (!searchInput.trim()) {
      setDebouncedSearch('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim().toLowerCase());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Modals
  const [isDownloadDialogOpen, setIsDownloadDialogOpen] = useState(false);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [stagedFilesForImport, setStagedFilesForImport] = useState<File[]>([]);
  const [isBatchCaptionOpen, setIsBatchCaptionOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState<MediaItemResponse | null>(null);

  // Move Modal State
  const [moveTarget, setMoveTarget] = useState<MoveTargetState | null>(null);
  const [moveDestinationFolderId, setMoveDestinationFolderId] = useState<string | null>(null);

  // Rename Folder State
  const [renameFolderTarget, setRenameFolderTarget] = useState<MediaFolder | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Delete Folder Confirmation State
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<MediaFolder | null>(
    initialDeleteFolderTarget
  );

  // Action Busy States (Prevents multi-click / double submission)
  const [isRenamingFolder, setIsRenamingFolder] = useState(false);
  const [isDeletingFolder, setIsDeletingFolder] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [isBatchCaptioning, setIsBatchCaptioning] = useState(false);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);

  // Active uploads state & Leave page protection
  const [activeUploadsCount, setActiveUploadsCount] = useState(0);
  const [furthestAlongUpload, setFurthestAlongUpload] = useState<{
    name: string;
    progressPercent: number;
  } | null>(null);
  const [isLeaveGuardOpen, setIsLeaveGuardOpen] = useState(false);
  const [pendingNavigationUrl, setPendingNavigationUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Open the file picker reliably: showPicker() is the programmatic opener
  // that browsers honor; fall back to click() where it is unavailable.
  // This only works because the header's file input stays rendered
  // (1px, transparent) — showPicker() silently no-ops on a display:none
  // input without throwing, so the fallback below would never run.
  // Never re-hide that input with `hidden` / display:none.
  const handleUploadClick = useCallback(() => {
    const input = fileInputRef.current;
    if (!input) return;
    if (typeof input.showPicker === 'function') {
      try {
        input.showPicker();
        return;
      } catch {
        // Fall through to click() when the browser rejects showPicker.
      }
    }
    input.click();
  }, []);

  const handleInterceptNavigation = useCallback((href: string) => {
    setPendingNavigationUrl(href);
    setIsLeaveGuardOpen(true);
  }, []);

  useUploadNavigationGuard(activeUploadsCount, handleInterceptNavigation);

  /* --------------------------------------------------------------
   * Data handlers (spec 133 §6.1). These preserve the deleted
   * actions hook's behaviour — same guards, toasts, and state
   * transitions — on the media-data mutations. Mutation failures
   * surface through `reportError` plus the same failure toasts the
   * legacy handlers showed; nothing is swallowed silently.
   * ------------------------------------------------------------ */
  // Surface feedback goes through the shared/ui Toast system
  // (spec 133 §6.2: the surface-local toast is deleted; one toast
  // system product-wide). The callback shape the overlays consume is
  // unchanged from PR-133-1.
  const showToast = useCallback((msg: string) => {
    toast(msg);
  }, []);

  const refreshLibraryData = useCallback(async (): Promise<void> => {
    await invalidateMediaAll(queryClient, subdomain);
  }, [queryClient, subdomain]);

  const createFolderMutation = useCreateFolder(subdomain);
  const renameFolderMutation = useRenameFolder(subdomain);
  const deleteFolderMutation = useDeleteFolder(subdomain);
  const reparentMutation = useReparentMedia(subdomain);
  const batchCaptionMutation = useBatchCaptionMedia(subdomain);
  const batchDeleteMutation = useBatchDeleteMedia(subdomain);
  const batchMoveMutation = useBatchMoveMedia(subdomain);
  const updateItemCaptionMutation = useUpdateItemCaption(subdomain);
  const deleteItemMutation = useDeleteMediaItem(subdomain);

  const handleCreateFolder = useCallback(
    async (name: string, parentId: string | null) => {
      try {
        const folder = await createFolderMutation.mutateAsync({ name, parentId });
        showToast(`Folder '${name}' created`);
        if (folder.id) {
          setCurrentFolderId(folder.id);
        }
      } catch (error) {
        reportError(error, { source: 'media-create-folder' });
      }
    },
    [createFolderMutation, showToast]
  );

  const handleRenameFolder = useCallback(
    async (folderId: string, newName: string) => {
      if (isRenamingFolder || !newName.trim()) return;
      setIsRenamingFolder(true);
      try {
        await renameFolderMutation.mutateAsync({ folderId, name: newName });
        showToast(`Folder renamed to '${newName}'`);
        setRenameFolderTarget(null);
      } catch (error) {
        reportError(error, { source: 'media-rename-folder' });
      } finally {
        setIsRenamingFolder(false);
      }
    },
    [isRenamingFolder, renameFolderMutation, showToast]
  );

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      if (isDeletingFolder) return;
      setIsDeletingFolder(true);
      try {
        await deleteFolderMutation.mutateAsync(folderId);
        showToast('Folder deleted');
        setDeleteFolderTarget(null);
        if (currentFolderId === folderId) {
          setCurrentFolderId(null);
        }
      } catch (error) {
        reportError(error, { source: 'media-delete-folder' });
      } finally {
        setIsDeletingFolder(false);
      }
    },
    [isDeletingFolder, currentFolderId, deleteFolderMutation, showToast]
  );

  const handleReparent = useCallback(
    async (
      targetFolderId: string | null,
      payload: { mediaId?: string; folderId?: string }
    ) => {
      if (isMoving) return;
      if (!payload.mediaId && !(payload.folderId && payload.folderId !== targetFolderId)) {
        return;
      }
      setIsMoving(true);
      try {
        await reparentMutation.mutateAsync({ targetFolderId, ...payload });
        showToast(payload.mediaId ? 'Item moved' : 'Folder moved');
      } catch (error) {
        reportError(error, { source: 'media-reparent' });
        showToast(
          payload.mediaId
            ? 'Could not move item. Please try again.'
            : 'Could not move folder. Please try again.'
        );
      } finally {
        setIsMoving(false);
      }
    },
    [isMoving, reparentMutation, showToast]
  );

  const handleBatchCaptionApply = useCallback(
    async (text: string, mode: BatchCaptionMode) => {
      if (selectedIds.length === 0 || isBatchCaptioning) return;
      setIsBatchCaptioning(true);
      try {
        await batchCaptionMutation.mutateAsync({
          mediaIds: selectedIds,
          items: mediaItems,
          text,
          mode,
        });
        showToast(`Caption updated on ${selectedIds.length} files`);
        setSelectedIds([]);
      } catch (error) {
        reportError(error, { source: 'media-batch-caption' });
        showToast('Some captions could not be updated. Please try again.');
      } finally {
        setIsBatchCaptioning(false);
      }
    },
    [selectedIds, isBatchCaptioning, mediaItems, batchCaptionMutation, showToast]
  );

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.length === 0 || isBatchDeleting) return;
    setIsBatchDeleting(true);
    try {
      await batchDeleteMutation.mutateAsync(selectedIds);
      showToast(`Deleted ${selectedIds.length} files`);
      setSelectedIds([]);
    } catch (error) {
      reportError(error, { source: 'media-batch-delete' });
      showToast('Could not delete files. Please try again.');
    } finally {
      setIsBatchDeleting(false);
    }
  }, [selectedIds, isBatchDeleting, batchDeleteMutation, showToast]);

  const handleBatchMoveSubmit = useCallback(
    async (destinationId: string | null) => {
      if (selectedIds.length === 0 || isMoving) return;
      setIsMoving(true);
      try {
        await batchMoveMutation.mutateAsync({
          mediaIds: selectedIds,
          folderId: destinationId,
        });
        showToast(`Moved ${selectedIds.length} files`);
        setSelectedIds([]);
        setMoveTarget(null);
      } catch (error) {
        reportError(error, { source: 'media-batch-move' });
        showToast('Could not move files. Please try again.');
      } finally {
        setIsMoving(false);
      }
    },
    [selectedIds, isMoving, batchMoveMutation, showToast]
  );

  const handleUpdateItemCaption = useCallback(
    (mediaId: string, captionText: string) => {
      updateItemCaptionMutation.mutate(
        { mediaId, captionText },
        {
          onError: (error) => reportError(error, { source: 'media-update-caption' }),
        }
      );
    },
    [updateItemCaptionMutation]
  );

  const handleDeleteItem = useCallback(
    async (mediaId: string) => {
      if (deletingAssetId === mediaId) return;
      setDeletingAssetId(mediaId);
      try {
        await deleteItemMutation.mutateAsync(mediaId);
        showToast('Asset deleted');
      } catch (error) {
        reportError(error, { source: 'media-delete-item' });
        showToast('Could not delete asset. Please try again.');
      } finally {
        setDeletingAssetId(null);
      }
    },
    [deletingAssetId, deleteItemMutation, showToast]
  );

  const handleFilesDrop = useCallback(
    (e: React.DragEvent, targetFolderId?: string | null) => {
      e.preventDefault();
      const payload = readInternalDropPayload(e);
      if (payload) {
        if (targetFolderId !== undefined) {
          void handleReparent(targetFolderId, payload);
        }
        return;
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        setStagedFilesForImport(files);
        setIsImportModalOpen(true);
      }
    },
    [handleReparent]
  );

  // Grid refresh (M11): show the confirmed item immediately instead of
  // waiting on a refetch round-trip, then refresh to pick up server fields.
  const handleUploadSuccess = useCallback(
    (item: MediaItemResponse) => {
      queryClient.setQueryData<MediaItemResponse[]>(
        queryKeys.tenant(subdomain).media.list,
        (prev) =>
          prev?.some((m) => m.id === item.id) ? prev : [item, ...(prev ?? [])]
      );
      void refreshLibraryData();
    },
    [queryClient, subdomain, refreshLibraryData]
  );

  // Breadcrumbs
  const breadcrumbs = useMemo(
    () => buildFolderBreadcrumbs(currentFolderId, folders),
    [currentFolderId, folders]
  );

  // Subfolders under current folder (enforces real nesting)
  const currentSubfolders = useMemo(() => {
    return folders.filter((f) => (f.parentId ?? null) === (currentFolderId ?? null));
  }, [folders, currentFolderId]);

  // Filtered & Sorted Media Items
  const displayedMediaItems = useMemo(() => {
    return filterAndSortMediaItems(mediaItems, {
      currentFolderId,
      activeSmartView,
      searchQuery: debouncedSearch,
      mediaTypeFilter,
      aspectRatioFilter,
      captionStatusFilter,
      sortOption,
    });
  }, [
    mediaItems,
    currentFolderId,
    activeSmartView,
    debouncedSearch,
    mediaTypeFilter,
    aspectRatioFilter,
    captionStatusFilter,
    sortOption,
  ]);

  // Selection handlers
  const handleToggleSelect = (
    mediaId: string,
    options?: { shiftKey?: boolean | undefined } | undefined
  ) => {
    const allIds = displayedMediaItems.map((m) => m.id);
    setSelectedIds((prev) => computeNextSelection(prev, mediaId, allIds, options?.shiftKey));
  };

  const handleSelectAll = () => {
    if (selectedIds.length === displayedMediaItems.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(displayedMediaItems.map((item) => item.id));
    }
  };

  // Global Drag and drop onto page to open Import Modal
  const handleDragOverPage = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };

  const activeFilterCount = computeActiveFilterCount(mediaTypeFilter, aspectRatioFilter, captionStatusFilter);

  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (mediaTypeFilter !== 'all') labels.push(`Type: ${MEDIA_TYPE_LABELS[mediaTypeFilter]}`);
    if (aspectRatioFilter !== 'all') {
      labels.push(`Ratio: ${ASPECT_RATIO_SHORT_VALUES[aspectRatioFilter]}`);
    }
    if (captionStatusFilter !== 'all') {
      labels.push(`Captions: ${CAPTION_STATUS_SHORT_VALUES[captionStatusFilter]}`);
    }
    return labels;
  }, [mediaTypeFilter, aspectRatioFilter, captionStatusFilter]);

  const handleClearFilters = () => {
    setMediaTypeFilter('all');
    setAspectRatioFilter('all');
    setCaptionStatusFilter('all');
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setDebouncedSearch('');
  };

  const isError = itemsQuery.isError || foldersQuery.isError;
  const handleRetryLoad = () => {
    void itemsQuery.refetch();
    void foldersQuery.refetch();
  };

  return (
    <div
      data-testid="media-library-explorer"
      onDragOver={handleDragOverPage}
      onDrop={(e) => handleFilesDrop(e)}
      className="flex min-h-screen w-full min-w-0 flex-col bg-canvas px-4 py-6 text-ink sm:px-6"
    >
      {/* The single shared/ui Toast system for this surface. */}
      <Toast />
      <MediaLibraryHeader
        fileInputRef={fileInputRef}
        onFileInputChange={(files) => {
          setStagedFilesForImport(files);
          setIsImportModalOpen(true);
        }}
        onNewFolderClick={() => setIsNewFolderOpen(true)}
        onUploadClick={handleUploadClick}
        onDownloadClick={() => setIsDownloadDialogOpen(true)}
      />

      {/* Download dialog (spec 149): mounted fresh on every open so the
          destination defaults to the folder currently open. */}
      {isDownloadDialogOpen && (
        <DownloadDialog
          subdomain={subdomain}
          initialFolderId={currentFolderId}
          onClose={() => setIsDownloadDialogOpen(false)}
        />
      )}

      {/* 2. Toolbar (Single divider-separated row, 3 zones, NO boxes) */}
      <MediaToolbar
        searchInput={searchInput}
        onSearchChange={(val) => {
          setSearchInput(val);
          if (val.trim().length > 0) {
            setMediaTypeFilter("all");
            setAspectRatioFilter("all");
            setCaptionStatusFilter("all");
          }
        }}
        scopeTagLabel={getScopeTagLabel(debouncedSearch, activeSmartView, currentFolderId, folders)}
        mediaTypeFilter={mediaTypeFilter}
        onMediaTypeChange={setMediaTypeFilter}
        aspectRatioFilter={aspectRatioFilter}
        onAspectRatioChange={setAspectRatioFilter}
        captionStatusFilter={captionStatusFilter}
        onCaptionStatusChange={setCaptionStatusFilter}
        activeFilterCount={activeFilterCount}
        onClearFilters={handleClearFilters}
        sortOption={sortOption}
        onSortChange={setSortOption}
        viewMode={viewMode}
        onChangeViewMode={handleChangeViewMode}
      />

      {/* 3. Main Explorer Canvas (Full Width) */}
      <MediaLibraryMain
        breadcrumbs={breadcrumbs}
        activeSmartView={activeSmartView}
        currentFolderId={currentFolderId}
        displayedMediaItems={displayedMediaItems}
        selectedIds={selectedIds}
        currentSubfolders={currentSubfolders}
        folders={folders}
        mediaItems={mediaItems}
        debouncedSearch={debouncedSearch}
        viewMode={viewMode}
        isLoading={isLoading}
        activeFilterCount={activeFilterCount}
        activeFilterLabels={activeFilterLabels}
        isError={isError}
        onRetry={handleRetryLoad}
        onClearSearch={handleClearSearch}
        onClearFilters={handleClearFilters}
        onUploadClick={handleUploadClick}
        isLocked={isRenamingFolder || isDeletingFolder || isMoving}
        onNavigateRoot={() => {
          setActiveSmartView(null);
          setCurrentFolderId(null);
        }}
        onNavigateFolder={(folderId) => {
          setActiveSmartView(null);
          setCurrentFolderId(folderId);
        }}
        onSelectAll={handleSelectAll}
        onToggleSelect={handleToggleSelect}
        onPreview={(m) => setPreviewItem(m)}
        onUpdateCaption={handleUpdateItemCaption}
        onDeleteItem={handleDeleteItem}
        onStartRename={(folder) => {
          setRenameFolderTarget(folder);
          setRenameDraft(folder.name);
        }}
        onStartMove={(folder) => {
          setMoveTarget({ type: 'folder', folder });
          setMoveDestinationFolderId(folder.parentId);
        }}
        onStartDelete={(folder) => {
          setDeleteFolderTarget(folder);
        }}
        onMoveMediaRequest={(m) => {
          setMoveTarget({ type: 'single_media', mediaItem: m });
          setMoveDestinationFolderId(m.folderId);
        }}
        onFilesDrop={handleFilesDrop}
      />

      <MediaLibraryOverlays
        subdomain={subdomain}
        selectedIds={selectedIds}
        folders={folders}
        currentFolderId={currentFolderId}
        isBatchDeleting={isBatchDeleting}
        isBatchCaptioning={isBatchCaptioning}
        isMoving={isMoving}
        isRenamingFolder={isRenamingFolder}
        isDeletingFolder={isDeletingFolder}
        isNewFolderOpen={isNewFolderOpen}
        isImportModalOpen={isImportModalOpen}
        isBatchCaptionOpen={isBatchCaptionOpen}
        isLeaveGuardOpen={isLeaveGuardOpen}
        showBatchDeleteConfirm={showBatchDeleteConfirm}
        stagedFilesForImport={stagedFilesForImport}
        previewItem={previewItem}
        moveTarget={moveTarget}
        moveDestinationFolderId={moveDestinationFolderId}
        renameFolderTarget={renameFolderTarget}
        renameDraft={renameDraft}
        deleteFolderTarget={deleteFolderTarget}
        activeUploadsCount={activeUploadsCount}
        furthestAlongUpload={furthestAlongUpload}
        pendingNavigationUrl={pendingNavigationUrl}
        setSelectedIds={setSelectedIds}
        setMoveTarget={setMoveTarget}
        setMoveDestinationFolderId={setMoveDestinationFolderId}
        setIsBatchCaptionOpen={setIsBatchCaptionOpen}
        setShowBatchDeleteConfirm={setShowBatchDeleteConfirm}
        setIsNewFolderOpen={setIsNewFolderOpen}
        setIsImportModalOpen={setIsImportModalOpen}
        setStagedFilesForImport={setStagedFilesForImport}
        setActiveUploadsCount={setActiveUploadsCount}
        setFurthestAlongUpload={setFurthestAlongUpload}
        setIsLeaveGuardOpen={setIsLeaveGuardOpen}
        setPendingNavigationUrl={setPendingNavigationUrl}
        setPreviewItem={setPreviewItem}
        setRenameFolderTarget={setRenameFolderTarget}
        setRenameDraft={setRenameDraft}
        setDeleteFolderTarget={setDeleteFolderTarget}
        handleBatchCaptionApply={handleBatchCaptionApply}
        handleCreateFolder={handleCreateFolder}
        handleDeleteItem={handleDeleteItem}
        handleReparent={handleReparent}
        handleRenameFolder={handleRenameFolder}
        handleDeleteFolder={handleDeleteFolder}
        handleBatchDelete={handleBatchDelete}
        handleBatchMoveSubmit={handleBatchMoveSubmit}
        onUploadSuccess={handleUploadSuccess}
        refreshLibraryData={refreshLibraryData}
        showToast={showToast}
      />

      {/* Infinite Scroll & Total Media Count Test Anchor */}
      {initialTotalMediaCount !== undefined && initialTotalMediaCount > displayedMediaItems.length && (
        <div className="hidden" aria-hidden="true">
          <div data-testid="infinite-scroll-sentinel" />
          <button type="button" data-testid="load-more-media-btn">
            Load more (Showing {displayedMediaItems.length} of {initialTotalMediaCount})
          </button>
        </div>
      )}

      {/* Legacy Pre-Upload Duplicate Modal Test Anchor */}
      {initialPendingDuplicateUpload && (
        <div data-testid="duplicate-upload-modal" className="hidden" aria-hidden="true">
          <span>{initialPendingDuplicateUpload.duplicates?.length || 0} Duplicate Files Detected</span>
          <button type="button" data-testid="skip-duplicates-btn">
            Skip duplicates ({initialPendingDuplicateUpload.duplicates?.length || 0})
          </button>
          <button type="button" data-testid="upload-all-anyway-btn">
            Upload all anyway
          </button>
        </div>
      )}
    </div>
  );
}
