'use client';

/**
 * The Media Library picker for the Create Posts dialogue.
 *
 * One picker serves every attach point: Bulk Post opens it in
 * multi-select mode (each chosen file becomes its own post block),
 * and a block's "Attach media" slot opens the same picker in
 * single-select mode (one tap attaches and closes). The picker IS
 * the Media Library, not a lookalike of it:
 *
 *   - The Library tab composes the library's own pieces — its
 *     toolbar (search, Type / Ratio / Captions, sort, grid/table
 *     switch), its client-side filter/sort, its breadcrumb trail,
 *     its subfolder rows, and its grid tiles / table rows — over
 *     the library's own React Query data (same queries, same
 *     500-item list, same cache as the library page). It opens at
 *     the library root, and the user moves to ANY folder exactly
 *     as in the library; nothing confines browsing to one folder.
 *   - The Upload from device tab opens the library's own import
 *     modal (staging, duplicate flags, 3-concurrency engine,
 *     pause/resume/cancel/retry, completion summary) — the picker's
 *     first-build custom upload flow is deleted. The one picker
 *     rule on top of it: the import destination is LOCKED to the
 *     page's folder (named after the page, auto-created if
 *     missing), so device uploads always land there.
 *
 * What is deliberately NOT the library: folder management. The
 * picker is browse + select only — no rename / move / delete
 * folder or item actions, no batch bar, no caption editing from
 * the grid (table-view caption edit stays, wired to the library's
 * own mutation, because it is part of the row rendering). Those
 * actions live on the library page. The two replicated pieces are
 * the breadcrumb row (clickable crumbs, no drag-drop reparenting)
 * and the subfolder rows (same row layout, no management
 * buttons), because the library's own versions bundle the
 * management actions the picker must not offer.
 *
 * Captions: the media attached here carries its saved library
 * caption (`captionText`) through to the dialogue, which prefills
 * an empty block's text from it. Device uploads get their saved
 * caption from the library uploader itself (filename without
 * extension), so their blocks prefill the same way.
 */

import * as React from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MediaFolder, MediaItemResponse } from '@fbuploadpro/contracts';
import {
  FolderListResponseSchema,
  FolderResponseSchema,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath } from '@/lib/api';
import { reportError } from '@/lib/report-error';
import { setPreference, preferences } from '@/lib/storage/preferences';
import { cn } from '@/lib/utils';
import { CircleAlertIcon, FolderIcon, ImageIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/shared/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import {
  mediaFoldersQuery,
  mediaListQuery,
  invalidateMediaAll,
  invalidateMediaList,
  toMediaFolder,
  useUpdateItemCaption,
} from '@/components/media/media-data';
import { MediaAssetCard } from '@/components/media/media-asset-card';
import { MediaTableRow } from '@/components/media/media-table-row';
import {
  buildFolderBreadcrumbs,
  formatFolderAncestryPath,
} from '@/components/media/media-library-breadcrumbs';
import {
  filterAndSortMediaItems,
  getEmptyStateInfo,
  getScopeTagLabel,
  ASPECT_RATIO_SHORT_VALUES,
  CAPTION_STATUS_SHORT_VALUES,
  MEDIA_TYPE_LABELS,
} from '@/components/media/media-library-filters';
import {
  computeActiveFilterCount,
  computeNextSelection,
  getInitialViewMode,
} from '@/components/media/media-library-helpers';
import { MediaToolbar } from '@/components/media/media-library-toolbar';
import type {
  AspectRatioFilterKey,
  CaptionStatusFilterKey,
  MediaTypeFilterKey,
  MediaViewMode,
  SortOptionKey,
} from '@/components/media/media-types';
import { toComposerMedia } from './create-posts-types';

/**
 * The library's preview + import dialogs are closed-by-default UI
 * in the library itself (next/dynamic, ssr:false) — the picker
 * loads them the same way so a closed picker ships neither.
 */
const MediaPreviewModal = dynamic(
  () =>
    import('@/components/media/media-preview-modal').then((m) => ({
      default: m.MediaPreviewModal,
    })),
  { ssr: false }
);

const MediaImportModal = dynamic(
  () =>
    import('@/components/media/media-import-modal').then((m) => ({
      default: m.MediaImportModal,
    })),
  { ssr: false }
);

export interface MediaLibraryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subdomain: string;
  pageName: string;
  mode: 'single' | 'multi';
  onSingleAttach: (media: ComposerMedia) => void;
  onMultiAttach: (media: ComposerMedia[]) => void;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function MediaLibraryPicker({
  open,
  onOpenChange,
  subdomain,
  pageName,
  mode,
  onSingleAttach,
  onMultiAttach,
}: Readonly<MediaLibraryPickerProps>) {
  const queryClient = useQueryClient();
  const folderName = React.useMemo(
    () => (pageName.trim() || 'Page').slice(0, 100),
    [pageName]
  );
  const foldersPath = buildTenantApiPath(subdomain, '/media/folders');
  const listDefinition = React.useMemo(() => mediaListQuery(subdomain), [subdomain]);
  const foldersDefinition = React.useMemo(
    () => mediaFoldersQuery(subdomain),
    [subdomain]
  );

  // Picker chrome + device-upload state.
  const [tab, setTab] = React.useState<'library' | 'device'>('library');
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [pageFolderId, setPageFolderId] = React.useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = React.useState<File[]>([]);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importActiveCount, setImportActiveCount] = React.useState(0);
  const [uploadedItems, setUploadedItems] = React.useState<ComposerMedia[]>([]);
  const [deviceError, setDeviceError] = React.useState<string | null>(null);
  const [resolvingFolder, setResolvingFolder] = React.useState(false);
  const deviceInputRef = React.useRef<HTMLInputElement | null>(null);

  // Library browsing state — the explorer's state shape, minus
  // smart views (the library page exposes no in-page switcher for
  // them) and minus management targets (see the header comment).
  const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(null);
  const [viewMode, setViewMode] = React.useState<MediaViewMode>(() =>
    getInitialViewMode()
  );
  const [searchInput, setSearchInput] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [mediaTypeFilter, setMediaTypeFilter] =
    React.useState<MediaTypeFilterKey>('all');
  const [aspectRatioFilter, setAspectRatioFilter] =
    React.useState<AspectRatioFilterKey>('all');
  const [captionStatusFilter, setCaptionStatusFilter] =
    React.useState<CaptionStatusFilterKey>('all');
  const [sortOption, setSortOption] = React.useState<SortOptionKey>('created_at:desc');
  const [previewItem, setPreviewItem] = React.useState<MediaItemResponse | null>(null);

  // The library's own queries, fetched only while the picker is
  // open (same keys + cache as the library page itself).
  const itemsQuery = useQuery({ ...listDefinition, enabled: open });
  const foldersQuery = useQuery({ ...foldersDefinition, enabled: open });
  const folders = React.useMemo<MediaFolder[]>(
    () => foldersQuery.data ?? [],
    [foldersQuery.data]
  );
  const mediaItems = React.useMemo<MediaItemResponse[]>(
    () => itemsQuery.data ?? [],
    [itemsQuery.data]
  );
  const isLoading = itemsQuery.isPending || foldersQuery.isPending;
  const isError = itemsQuery.isError || foldersQuery.isError;

  const updateCaptionMutation = useUpdateItemCaption(subdomain);

  // Fresh state on every open; browsing starts at the library root
  // (the same landing as the Media Library itself), never inside
  // the page's folder.
  React.useEffect(() => {
    if (!open) return;
    setTab('library');
    setSelectedIds([]);
    setStagedFiles([]);
    setImportOpen(false);
    setImportActiveCount(0);
    setUploadedItems([]);
    setDeviceError(null);
    setCurrentFolderId(null);
    setSearchInput('');
    setDebouncedSearch('');
    setMediaTypeFilter('all');
    setAspectRatioFilter('all');
    setCaptionStatusFilter('all');
    setSortOption('created_at:desc');
    setPreviewItem(null);
  }, [open ]);

  // Search debounce, as in the explorer: 250ms, immediate on clear.
  React.useEffect(() => {
    if (!searchInput.trim()) {
      setDebouncedSearch('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim().toLowerCase());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const breadcrumbs = React.useMemo(
    () => buildFolderBreadcrumbs(currentFolderId, folders),
    [currentFolderId, folders]
  );
  const currentSubfolders = React.useMemo(
    () => folders.filter((f) => (f.parentId ?? null) === (currentFolderId ?? null)),
    [folders, currentFolderId]
  );
  const displayedMediaItems = React.useMemo(
    () =>
      filterAndSortMediaItems(mediaItems, {
        currentFolderId,
        activeSmartView: null,
        mediaTypeFilter,
        aspectRatioFilter,
        captionStatusFilter,
        searchQuery: debouncedSearch,
        sortOption,
      }),
    [
      mediaItems,
      currentFolderId,
      mediaTypeFilter,
      aspectRatioFilter,
      captionStatusFilter,
      debouncedSearch,
      sortOption,
    ]
  );
  const activeFilterCount = computeActiveFilterCount(
    mediaTypeFilter,
    aspectRatioFilter,
    captionStatusFilter
  );
  const activeFilterLabels = React.useMemo(() => {
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

  const currentFolderName =
    currentFolderId != null
      ? (folders.find((f) => f.id === currentFolderId)?.name ?? null)
      : null;

  const navigateRoot = React.useCallback(() => setCurrentFolderId(null), []);
  const navigateFolder = React.useCallback(
    (folderId: string | null) => setCurrentFolderId(folderId),
    []
  );

  const handleChangeViewMode = React.useCallback((next: MediaViewMode) => {
    setViewMode(next);
    setPreference(preferences.mediaViewMode, next);
  }, []);

  const handleClearFilters = React.useCallback(() => {
    setMediaTypeFilter('all');
    setAspectRatioFilter('all');
    setCaptionStatusFilter('all');
  }, []);

  const handleClearSearch = React.useCallback(() => {
    setSearchInput('');
    setDebouncedSearch('');
  }, []);

  const handleRetryLoad = React.useCallback(() => {
    void itemsQuery.refetch();
    void foldersQuery.refetch();
  }, [itemsQuery, foldersQuery]);

  // Selection: the library's own model (checkbox + shift-range).
  // Single mode is choose-one: any select/preview gesture attaches
  // at once and closes the picker.
  const handleToggleSelect = React.useCallback(
    (mediaId: string, options?: { shiftKey?: boolean | undefined }) => {
      if (mode === 'single') {
        const item = mediaItems.find((m) => m.id === mediaId);
        if (item) {
          onSingleAttach(toComposerMedia(item));
          onOpenChange(false);
        }
        return;
      }
      const allIds = displayedMediaItems.map((m) => m.id);
      setSelectedIds((prev) =>
        computeNextSelection(prev, mediaId, allIds, options?.shiftKey)
      );
    },
    [mode, mediaItems, displayedMediaItems, onSingleAttach, onOpenChange]
  );

  const handleSelectAll = React.useCallback(() => {
    setSelectedIds((prev) =>
      prev.length === displayedMediaItems.length
        ? []
        : displayedMediaItems.map((item) => item.id)
    );
  }, [displayedMediaItems]);

  const handlePreview = React.useCallback(
    (item: MediaItemResponse) => {
      if (mode === 'single') {
        onSingleAttach(toComposerMedia(item));
        onOpenChange(false);
        return;
      }
      setPreviewItem(item);
    },
    [mode, onSingleAttach, onOpenChange]
  );

  const handleUpdateCaption = React.useCallback(
    (mediaId: string, captionText: string) => {
      updateCaptionMutation.mutate(
        { mediaId, captionText },
        {
          onError: (error) =>
            reportError(error, { source: 'media-picker-update-caption' }),
        }
      );
    },
    [updateCaptionMutation]
  );

  // Page-named folder, for device uploads ONLY — never a browsing
  // restriction. Lists first, creates only when missing, and on a
  // create race (409 "already exists") re-lists instead of failing.
  // A newly created folder is seeded into the folders cache so the
  // import modal names its destination correctly on first render.
  const resolvePageFolder = React.useCallback(async (): Promise<string> => {
    const list = await api.get(foldersPath, { schema: FolderListResponseSchema });
    const found = list.folders.find((folder) => folder.name === folderName);
    if (found) return found.id;
    try {
      const created = await api.post(
        foldersPath,
        { name: folderName },
        { schema: FolderResponseSchema }
      );
      queryClient.setQueryData<MediaFolder[]>(
        foldersDefinition.queryKey,
        (prev) =>
          prev ? [...prev, toMediaFolder(created)] : [toMediaFolder(created)]
      );
      void invalidateMediaList(queryClient, subdomain);
      return created.id;
    } catch {
      const relist = await api.get(foldersPath, {
        schema: FolderListResponseSchema,
      });
      const raced = relist.folders.find((folder) => folder.name === folderName);
      if (raced) return raced.id;
      throw new Error(`Couldn't open the "${folderName}" folder. Please try again.`);
    }
  }, [foldersPath, folderName, foldersDefinition.queryKey, queryClient, subdomain]);

  // Device uploads go through the library's import modal. The modal
  // owns staging, duplicate flags, the 3-concurrency engine and
  // progress; the picker only supplies the files and collects the
  // successes. The destination is locked to the page folder.
  const handleDeviceFiles = React.useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const chosen = Array.from(files);
      setDeviceError(null);
      setResolvingFolder(true);
      try {
        const id = pageFolderId ?? (await resolvePageFolder());
        setPageFolderId(id);
        setStagedFiles(chosen);
        setImportOpen(true);
      } catch (error) {
        setDeviceError(
          errorText(error, "Couldn't open this page's folder. Please try again.")
        );
      } finally {
        setResolvingFolder(false);
      }
    },
    [pageFolderId, resolvePageFolder]
  );

  const handleImportSuccess = React.useCallback(
    (item: MediaItemResponse) => {
      const media = toComposerMedia(item);
      // The Library tab must show the new file immediately.
      void invalidateMediaAll(queryClient, subdomain);
      if (mode === 'single') {
        // Single mode is one file: attach at once and close. (The
        // modal unmounts with the picker; the upload already
        // completed, so nothing is lost.)
        onSingleAttach(media);
        onOpenChange(false);
        return;
      }
      // Multi mode: a freshly uploaded file is chosen by definition,
      // so it joins the selection and Add selected includes it.
      setUploadedItems((prev) =>
        prev.some((u) => u.id === media.id) ? prev : [...prev, media]
      );
      setSelectedIds((prev) =>
        prev.includes(media.id) ? prev : [...prev, media.id]
      );
    },
    [mode, onSingleAttach, onOpenChange, queryClient, subdomain]
  );

  const handleImportClose = React.useCallback(() => {
    setImportOpen(false);
    setStagedFiles([]);
  }, []);

  // Selection resolved against the whole library (not just the
  // displayed view), so files picked across folders all queue.
  const allSelected = React.useMemo(() => {
    const byId = new Map<string, ComposerMedia>();
    mediaItems
      .filter((item) => selectedIds.includes(item.id))
      .map(toComposerMedia)
      .forEach((item) => byId.set(item.id, item));
    uploadedItems
      .filter((item) => selectedIds.includes(item.id))
      .forEach((item) => byId.set(item.id, item));
    return [...byId.values()];
  }, [mediaItems, selectedIds, uploadedItems]);

  const handleMultiAdd = React.useCallback(() => {
    if (allSelected.length === 0) return;
    onMultiAttach(allSelected);
    onOpenChange(false);
  }, [allSelected, onMultiAttach, onOpenChange]);

  // While the import modal has live uploads, the picker must not
  // close under it — dismissal would unmount the modal and strand
  // the in-flight successes. The modal itself blocks dismissal
  // during progress the same way; finishing or cancelling there
  // re-enables the picker.
  const uploadsActive = importActiveCount > 0;
  const handlePickerOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next && uploadsActive) return;
      onOpenChange(next);
    },
    [uploadsActive, onOpenChange]
  );

  const emptyState = getEmptyStateInfo(null, debouncedSearch);
  const totalMediaCount = mediaItems.length;

  return (
    <Dialog open={open} onOpenChange={handlePickerOpenChange}>
      <DialogContent
        data-testid="media-library-picker"
        className="overflow-x-hidden sm:max-w-3xl lg:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === 'single' ? 'Attach media' : 'Bulk Post — choose media'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'single'
              ? 'Pick one file from your Media Library, or upload one from your device.'
              : 'Tick as many images, reels and videos as you want — each one becomes its own post.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as 'library' | 'device')}
          className="min-w-0"
        >
          <TabsList data-testid="media-library-picker-tabs">
            <TabsTrigger value="library">Media Library</TabsTrigger>
            <TabsTrigger value="device">Upload from device</TabsTrigger>
          </TabsList>

          <TabsContent value="library" className="min-w-0">
            <MediaToolbar
              searchInput={searchInput}
              onSearchChange={(value) => {
                setSearchInput(value);
                if (value.trim().length > 0) {
                  setMediaTypeFilter('all');
                  setAspectRatioFilter('all');
                  setCaptionStatusFilter('all');
                }
              }}
              scopeTagLabel={getScopeTagLabel(
                debouncedSearch,
                null,
                currentFolderId,
                folders
              )}
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

            {/* Context row, as in the library: breadcrumb trail on
                the left, Select all on the right (multi mode only).
                Crumbs are clickable only — the library's drag-drop
                reparenting has no place in a picker. */}
            <div
              data-testid="context-row"
              className="flex flex-wrap items-center justify-between gap-4 py-4"
            >
              <nav
                aria-label="Folder path"
                data-testid="folder-breadcrumbs"
                className="flex flex-wrap items-center gap-1.5 text-body text-ink-sub"
              >
                <button
                  type="button"
                  data-testid="breadcrumb-root"
                  onClick={navigateRoot}
                  className={cn(
                    'cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-brand-gold',
                    currentFolderId === null
                      ? 'font-semibold text-ink'
                      : 'text-ink-sub'
                  )}
                >
                  Library
                </button>
                {breadcrumbs.map((crumb, idx) => {
                  const isLast = idx === breadcrumbs.length - 1;
                  return (
                    <React.Fragment key={crumb.id}>
                      <span className="text-ink-dim">/</span>
                      <button
                        type="button"
                        data-testid={`breadcrumb-folder-${crumb.id}`}
                        onClick={() => navigateFolder(crumb.id)}
                        className={cn(
                          'cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-brand-gold',
                          isLast ? 'font-semibold text-ink' : 'text-ink-sub'
                        )}
                      >
                        {crumb.name}
                      </button>
                    </React.Fragment>
                  );
                })}
              </nav>

              {mode === 'multi' && displayedMediaItems.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="select-all-btn"
                  onClick={handleSelectAll}
                  className="h-11 px-2 text-metadata text-ink-sub hover:text-ink md:h-10"
                >
                  {selectedIds.length === displayedMediaItems.length
                    ? 'Deselect all'
                    : 'Select all'}
                </Button>
              )}
            </div>

            {/* Subfolder rows, as in the library — rows, never
                cards — but without the library's rename / move /
                delete buttons: the picker is browse + select only,
                and those actions live on the library page. Hidden
                while searching, exactly as in the library. */}
            {currentSubfolders.length > 0 && !debouncedSearch && (
              <section
                aria-label="Subfolders"
                data-testid="subfolders-grid"
                className="mb-6 flex flex-col gap-0.5"
              >
                <span className="mb-1.5 text-xs font-semibold tracking-wide text-ink-dim uppercase">
                  Folders ({currentSubfolders.length})
                </span>
                <div className="flex flex-col border-t border-line">
                  {currentSubfolders.map((folder) => {
                    const childSubfolders = folders.filter(
                      (f) => f.parentId === folder.id
                    );
                    const folderItems = mediaItems.filter(
                      (m) => m.folderId === folder.id
                    );
                    const subCount = childSubfolders.length;
                    const fileCount = folder.itemCount ?? folderItems.length;
                    return (
                      <div
                        key={folder.id}
                        data-testid={`folder-row-${folder.id}`}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            navigateFolder(folder.id);
                          }
                        }}
                        onClick={() => navigateFolder(folder.id)}
                        className="flex cursor-pointer items-center justify-between gap-2 border-b border-line px-1 py-2 transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-brand-gold"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <FolderIcon
                            className="size-5 shrink-0 text-primary"
                            aria-hidden
                          />
                          <span
                            data-testid={`folder-name-${folder.id}`}
                            className="truncate text-body font-medium text-ink"
                          >
                            {folder.name}
                          </span>
                          <span className="shrink-0 text-xs whitespace-nowrap text-ink-dim">
                            {subCount} subfolder{subCount === 1 ? '' : 's'} ·{' '}
                            {fileCount} file{fileCount === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* The browse canvas: the library's own tiles / rows,
                its loaded/total line, its loading skeleton, and its
                typed empty states — same rendering, same rules.
                Move / Delete actions are omitted (their menu items
                and row buttons render only when handlers are passed),
                so no dead actions appear in the picker. */}
            {isError ? (
              <Alert
                variant="destructive"
                data-testid="media-error-state"
                className="mt-2"
              >
                <CircleAlertIcon className="size-5 shrink-0" aria-hidden />
                <div className="flex flex-col items-start gap-2">
                  <AlertTitle>Couldn&apos;t load your library</AlertTitle>
                  <AlertDescription>
                    Your files are safe — this was a loading problem. Try again.
                  </AlertDescription>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="media-error-retry-btn"
                    onClick={handleRetryLoad}
                    className="h-11 lg:h-8"
                  >
                    Retry
                  </Button>
                </div>
              </Alert>
            ) : displayedMediaItems.length > 0 ? (
              <>
                {viewMode === 'grid' ? (
                  <div
                    data-testid="media-assets-grid"
                    className="mt-1 grid min-w-0 grid-cols-2 gap-4 md:grid-cols-3 md:gap-5 xl:grid-cols-4 2xl:grid-cols-5"
                  >
                    {displayedMediaItems.map((item) => (
                      /* min-w-0 wrapper: a grid item's automatic minimum
                         is its content minimum, and a long nowrap
                         filename would otherwise force its track wider
                         than the card — the wrapper lets the tile shrink
                         so its truncate works instead of overflowing. */
                      <div key={item.id} className="min-w-0">
                        <MediaAssetCard
                          item={item}
                          selected={selectedIds.includes(item.id)}
                          folderPathLabel={
                            debouncedSearch
                              ? `in ${formatFolderAncestryPath(item.folderId, folders)}`
                              : null
                          }
                          onNavigateFolder={navigateFolder}
                          onToggleSelect={handleToggleSelect}
                          onPreview={handlePreview}
                          onUpdateCaption={handleUpdateCaption}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div data-testid="media-table-view" className="mt-1 w-full min-w-0">
                    {/* Picker-compact table: fixed layout + the compact
                        row variant, so columns are constrained and
                        truncate instead of pushing the table past the
                        card. The shared Table's overflow-x-auto
                        container stays, but with fixed widths nothing
                        exceeds it, so there is nothing to scroll.
                        Details/Date are omitted; Caption/Size hide
                        below sm. Widths are border-box (preflight),
                        so they include the px-3 cell padding. */}
                    <Table data-testid="media-table" className="table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-16">
                            <span className="sr-only">Select</span>
                          </TableHead>
                          <TableHead className="w-12 px-0">
                            <span className="sr-only">Thumbnail</span>
                          </TableHead>
                          <TableHead>File</TableHead>
                          <TableHead className="hidden sm:table-cell">
                            Caption
                          </TableHead>
                          <TableHead className="hidden w-[84px] text-right sm:table-cell">
                            Size
                          </TableHead>
                          <TableHead className="w-[120px] text-right">
                            Actions
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {displayedMediaItems.map((item) => (
                          <MediaTableRow
                            key={item.id}
                            item={item}
                            compact
                            selected={selectedIds.includes(item.id)}
                            folderPathLabel={
                              debouncedSearch
                                ? `in ${formatFolderAncestryPath(item.folderId, folders)}`
                                : null
                            }
                            onNavigateFolder={navigateFolder}
                            onToggleSelect={handleToggleSelect}
                            onPreview={handlePreview}
                            onUpdateCaption={handleUpdateCaption}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                <p
                  data-testid="media-loaded-count"
                  className="pt-4 text-xs text-ink-dim tabular-nums"
                >
                  Showing {displayedMediaItems.length} of {totalMediaCount}{' '}
                  {totalMediaCount === 1 ? 'file' : 'files'}
                </p>
              </>
            ) : isLoading ? (
              <div
                data-testid="media-loading-state"
                aria-busy="true"
                aria-label="Loading media"
                className="mt-1 grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-5 xl:grid-cols-4 2xl:grid-cols-5"
              >
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <Skeleton className="aspect-video w-full" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))}
              </div>
            ) : debouncedSearch ? (
              <EmptyState
                type="no-results"
                data-testid="media-empty-state"
                icon={<ImageIcon className="size-10 text-ink-dim" aria-hidden />}
                title={emptyState.title}
                description={`No files match “${debouncedSearch}”. Search looks across your whole library, in every folder.`}
                action={
                  <Button
                    type="button"
                    data-testid="media-empty-clear-search-btn"
                    onClick={handleClearSearch}
                    className="h-11 md:h-10"
                  >
                    Clear search
                  </Button>
                }
              />
            ) : activeFilterCount > 0 ? (
              <EmptyState
                type="no-results"
                data-testid="media-empty-state"
                icon={<ImageIcon className="size-10 text-ink-dim" aria-hidden />}
                title="No files match these filters"
                description="Try widening the filters, or clear them to see everything in this view."
                activeFilters={activeFilterLabels}
                action={
                  <Button
                    type="button"
                    data-testid="media-empty-clear-filters-btn"
                    onClick={handleClearFilters}
                    className="h-11 md:h-10"
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : totalMediaCount === 0 && folders.length === 0 ? (
              <EmptyState
                type="first-use"
                data-testid="media-empty-state"
                icon={<ImageIcon className="size-10 text-ink-dim" aria-hidden />}
                title="Your media library is empty"
                description="Upload photos and videos here once, then schedule them to every platform from one place."
                action={
                  <Button
                    type="button"
                    data-testid="media-empty-upload-btn"
                    aria-label="Upload your first files"
                    onClick={() => setTab('device')}
                    className="h-11 md:h-10"
                  >
                    Upload Files
                  </Button>
                }
              />
            ) : (
              <EmptyState
                type="first-use"
                data-testid="media-empty-state"
                icon={<ImageIcon className="size-10 text-ink-dim" aria-hidden />}
                title={currentFolderName ? `No media in ${currentFolderName}` : emptyState.title}
                description={emptyState.subtext}
                action={
                  <Button
                    type="button"
                    data-testid="media-empty-upload-btn"
                    aria-label="Upload files to this folder"
                    onClick={() => setTab('device')}
                    className="h-11 md:h-10"
                  >
                    Upload Files
                  </Button>
                }
              />
            )}
          </TabsContent>

          <TabsContent value="device">
            <p className="mb-3 text-body text-ink-sub">
              Uploads go to the “{folderName}” folder. The folder is created
              automatically if it doesn’t exist yet.
            </p>
            <input
              ref={deviceInputRef}
              type="file"
              data-testid="media-library-device-input"
              className="hidden"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
              multiple={mode === 'multi'}
              onChange={(event) => {
                void handleDeviceFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="secondary"
              data-testid="media-library-device-choose-btn"
              disabled={resolvingFolder}
              onClick={() => deviceInputRef.current?.click()}
            >
              {resolvingFolder
                ? 'Opening your page’s folder…'
                : 'Choose files from your device'}
            </Button>
            {deviceError && (
              <p className="mt-3 text-body text-brand-rose">{deviceError}</p>
            )}
            {uploadedItems.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {uploadedItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-sm border border-line px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {item.name}
                    </span>
                    <span className="shrink-0 text-metadata text-brand-emerald">
                      Uploaded
                    </span>
                  </div>
                ))}
                {mode === 'multi' && (
                  <p className="text-metadata text-ink-sub">
                    These joined your selection — Add selected includes them.
                  </p>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {mode === 'multi' && (
          <div className="flex min-w-0 justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={uploadsActive}
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="button"
              data-testid="media-library-picker-add-btn"
              disabled={allSelected.length === 0 || uploadsActive}
              onClick={handleMultiAdd}
            >
              {allSelected.length === 0
                ? 'Add selected'
                : `Add selected (${allSelected.length})`}
            </Button>
          </div>
        )}

        {/* The library's own import modal, nested inside the picker:
            staging, duplicate flags, the 3-concurrency engine and
            progress — with the destination locked to the page
            folder, so device uploads can never land elsewhere. */}
        <MediaImportModal
          subdomain={subdomain}
          isOpen={importOpen}
          initialFiles={stagedFiles}
          currentFolderId={pageFolderId}
          folders={folders}
          onClose={handleImportClose}
          onUploadSuccess={handleImportSuccess}
          onActiveUploadsChange={(count) => setImportActiveCount(count)}
          lockDestination
        />

        {/* View-only preview in multi mode (the library's own
            preview, without save/delete): tile clicks preview
            instead of selecting, exactly as in the library. */}
        {mode === 'multi' && (
          <MediaPreviewModal
            item={previewItem}
            open={previewItem !== null}
            onOpenChange={(next) => {
              if (!next) setPreviewItem(null);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
