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
 *     toolbar pieces (search, Type / Ratio / Captions, sort,
 *     grid/table switch — Style A arrangement: one search field
 *     plus a Filters button, with the filter/sort menus behind
 *     that button), its client-side filter/sort, its breadcrumb trail,
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
 * the grid (table-view caption editing is disabled in the picker,
 * because it is browse + select only). Those
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
import {
  CircleAlertIcon,
  FolderIcon,
  ImageIcon,
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Input } from '@/components/shared/ui/input';
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
  SORT_OPTION_SHORT_VALUES,
} from '@/components/media/media-library-filters';
import {
  computeActiveFilterCount,
  computeNextSelection,
  getInitialViewMode,
} from '@/components/media/media-library-helpers';
import {
  ToolbarMenu,
  TYPE_DROPDOWN_OPTIONS,
  RATIO_DROPDOWN_OPTIONS,
  CAPTION_DROPDOWN_OPTIONS,
  SORT_DROPDOWN_OPTIONS,
} from '@/components/media/media-library-toolbar';
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
  /**
   * P11: the composer dialogue's session key. Browsing state
   * (folder, search, filters, selection, uploads) persists across
   * picker opens within one session and resets only when this key
   * changes — i.e. when the dialogue itself opens fresh.
   */
  sessionKey?: number | undefined;
  /**
   * P2: live upload state for the composer's leave guard — the
   * active count plus the furthest-along file, as the import
   * modal reports them. Called only when the values change.
   */
  onUploadsActiveChange?:
    | ((
        count: number,
        furthestAlong: { name: string; progressPercent: number } | null
      ) => void)
    | undefined;
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
  sessionKey = 0,
  onUploadsActiveChange,
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
  const [furthestAlongUpload, setFurthestAlongUpload] = React.useState<{
    name: string;
    progressPercent: number;
  } | null>(null);
  const [uploadedItems, setUploadedItems] = React.useState<ComposerMedia[]>([]);
  const [deviceError, setDeviceError] = React.useState<string | null>(null);
  const [resolvingFolder, setResolvingFolder] = React.useState(false);
  const deviceInputRef = React.useRef<HTMLInputElement | null>(null);
  // P8: drag-over highlight for the device-tab drop zone.
  const [isDraggingOverDevice, setIsDraggingOverDevice] = React.useState(false);
  // P1: a late success must never overwrite an attached file.
  const singleAttachedRef = React.useRef(false);
  // P12: a batch invalidates the library cache once, when it settles.
  const pendingInvalidationRef = React.useRef(false);
  const prevActiveCountRef = React.useRef(0);
  const prevReportedUploadsRef = React.useRef<{
    count: number;
    name: string | null;
    progressPercent: number | null;
  }>({ count: 0, name: null, progressPercent: null });

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
  // Style A top section: the filter/sort controls live behind the
  // Filters button instead of sitting out as always-visible
  // dropdowns. Closed by default, reset on every open.
  const [filtersOpen, setFiltersOpen] = React.useState(false);

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

  // P11: fresh state only when the composer dialogue itself opens
  // fresh (sessionKey change) — not on every picker open. Within
  // one session the user keeps their folder, search, filters and
  // selection across picker opens; browsing still starts at the
  // library root, never inside the page's folder.
  React.useEffect(() => {
    setTab('library');
    setSelectedIds([]);
    setPageFolderId(null);
    setStagedFiles([]);
    setImportOpen(false);
    setImportActiveCount(0);
    setFurthestAlongUpload(null);
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
    setFiltersOpen(false);
    singleAttachedRef.current = false;
    pendingInvalidationRef.current = false;
    prevActiveCountRef.current = 0;
  }, [sessionKey]);

  // P1: the single-attach guard resets on every picker open, so a
  // new attach in the same session is never blocked by a previous
  // one — while a late success within one open is still ignored.
  React.useEffect(() => {
    if (open) singleAttachedRef.current = false;
  }, [open ]);

  // P12: when a batch settles (active count drops to zero after
  // having been live) and at least one file succeeded, invalidate
  // the library cache exactly once — not once per file.
  React.useEffect(() => {
    const prev = prevActiveCountRef.current;
    prevActiveCountRef.current = importActiveCount;
    if (prev > 0 && importActiveCount === 0 && pendingInvalidationRef.current) {
      pendingInvalidationRef.current = false;
      void invalidateMediaAll(queryClient, subdomain);
    }
  }, [importActiveCount, queryClient, subdomain]);

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
  // Single mode previews first (P7): every select/preview gesture
  // opens the library preview with an "Attach this file" button
  // instead of attaching instantly.
  const handleToggleSelect = React.useCallback(
    (mediaId: string, options?: { shiftKey?: boolean | undefined }) => {
      if (mode === 'single') {
        const item = mediaItems.find((m) => m.id === mediaId);
        if (item) setPreviewItem(item);
        return;
      }
      const allIds = displayedMediaItems.map((m) => m.id);
      setSelectedIds((prev) =>
        computeNextSelection(prev, mediaId, allIds, options?.shiftKey)
      );
    },
    [mode, mediaItems, displayedMediaItems]
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
      setPreviewItem(item);
    },
    []
  );

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

  const handleAttachFromPreview = React.useCallback(() => {
    if (!previewItem) return;
    onSingleAttach(toComposerMedia(previewItem));
    setPreviewItem(null);
    handlePickerOpenChange(false);
  }, [previewItem, onSingleAttach, handlePickerOpenChange]);

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
  // P10: the match is (parent = root, name) — a nested folder with
  // the same name can never capture device uploads. A newly created
  // folder is seeded into the folders cache so the import modal
  // names its destination correctly on first render.
  const resolvePageFolder = React.useCallback(async (): Promise<string> => {
    const list = await api.get(foldersPath, { schema: FolderListResponseSchema });
    const found = list.folders.find(
      (folder) => folder.name === folderName && (folder.parentId ?? null) === null
    );
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
      const raced = relist.folders.find(
        (folder) => folder.name === folderName && (folder.parentId ?? null) === null
      );
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
      // P12: show the new file in the Library tab at once with an
      // optimistic cache insert; the full refetch is deferred until
      // the batch settles (see the importActiveCount effect above),
      // instead of one refetch per file.
      queryClient.setQueryData<MediaItemResponse[]>(
        listDefinition.queryKey,
        (prev) => {
          if (!prev) return [item];
          return prev.some((m) => m.id === item.id) ? prev : [...prev, item];
        }
      );
      pendingInvalidationRef.current = true;
      if (mode === 'single') {
        // Single mode is one file: attach at once and close through
        // the uploads guard (P1). A second success after the close
        // — e.g. a file staged before "+ Add more" was disabled —
        // is ignored, so it can never overwrite the attached file.
        if (singleAttachedRef.current) return;
        singleAttachedRef.current = true;
        onSingleAttach(media);
        handlePickerOpenChange(false);
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
    [mode, onSingleAttach, handlePickerOpenChange, queryClient, listDefinition.queryKey]
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
    // Consumed: added files must not linger selected, or reopening
    // the picker would re-add them as duplicate blocks.
    setSelectedIds([]);
    setUploadedItems([]);
    onOpenChange(false);
  }, [allSelected, onMultiAttach, onOpenChange]);

  // P5: the device tab's one clear next step — add exactly the
  // files this batch uploaded, without hunting through the footer.
  // Library files the user also selected stay selected (only the
  // uploaded ones are consumed), so nothing chosen is silently lost.
  const handleAddUploaded = React.useCallback(() => {
    if (uploadedItems.length === 0) return;
    onMultiAttach(uploadedItems);
    const uploadedIds = new Set(uploadedItems.map((u) => u.id));
    setSelectedIds((prev) => prev.filter((id) => !uploadedIds.has(id)));
    setUploadedItems([]);
    onOpenChange(false);
  }, [uploadedItems, onMultiAttach, onOpenChange]);

  const emptyState = getEmptyStateInfo(null, debouncedSearch);
  const totalMediaCount = mediaItems.length;

  return (
    <Dialog open={open} onOpenChange={handlePickerOpenChange}>
      <DialogContent
        data-testid="media-library-picker"
        className="overflow-x-hidden sm:max-w-3xl lg:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>Choose media</DialogTitle>
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
          {/* Style A tabs: plain text links, not pills or a
              segmented control — the active one is gold with a
              gold underline, the inactive one muted. */}
          <div
            data-testid="media-library-picker-tabs"
            className="flex items-center gap-5 border-b border-line"
          >
            <button
              type="button"
              onClick={() => setTab('library')}
              className={cn(
                '-mb-px border-b-2 pb-2 text-body',
                tab === 'library'
                  ? 'border-brand-gold font-semibold text-brand-gold'
                  : 'border-transparent text-ink-sub'
              )}
            >
              Media Library
            </button>
            <button
              type="button"
              onClick={() => setTab('device')}
              className={cn(
                '-mb-px border-b-2 pb-2 text-body',
                tab === 'device'
                  ? 'border-brand-gold font-semibold text-brand-gold'
                  : 'border-transparent text-ink-sub'
              )}
            >
              Upload from device
            </button>
          </div>

          <TabsContent value="library" className="min-w-0">
            {/* Style A top section: one search field, a Filters
                button, and the grid/table switch on one row. The
                Type / Ratio / Captions / Sort controls live behind
                the Filters button (same menu pieces as the library
                toolbar, same testids) instead of sitting out as
                always-visible dropdowns. Search behaviour is the
                library's: typing a query resets the local filters. */}
            <div className="flex min-w-0 items-center gap-2">
              <SearchIcon className="size-4 shrink-0 text-ink-dim" aria-hidden />
              <Input
                type="search"
                data-testid="media-search-input"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  if (e.target.value.trim().length > 0) {
                    setMediaTypeFilter('all');
                    setAspectRatioFilter('all');
                    setCaptionStatusFilter('all');
                  }
                }}
                placeholder="Search files and captions…"
                aria-label="Search files and captions"
                className="h-11 min-w-0 flex-1 md:h-10"
              />
              <Button
                type="button"
                variant="outline"
                data-testid="media-picker-filters-btn"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((prev) => !prev)}
                className="h-11 shrink-0 md:h-10"
              >
                Filters
                {activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </Button>
              <Tabs
                value={viewMode}
                onValueChange={(value) =>
                  handleChangeViewMode(value as MediaViewMode)
                }
                className="shrink-0 gap-0"
              >
                <TabsList aria-label="View mode" className="h-11 md:h-10">
                  <TabsTrigger
                    value="grid"
                    data-testid="view-mode-grid-btn"
                    aria-label="Grid view"
                    className="h-9 min-w-11 md:h-8"
                  >
                    <LayoutGridIcon aria-hidden />
                  </TabsTrigger>
                  <TabsTrigger
                    value="table"
                    data-testid="view-mode-table-btn"
                    aria-label="Table view"
                    className="h-9 min-w-11 md:h-8"
                  >
                    <ListIcon aria-hidden />
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {filtersOpen && (
              <div
                data-testid="media-picker-filters-panel"
                className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line p-2"
              >
                <ToolbarMenu
                  testId="media-type-select"
                  layer="overlayTop"
                  label="Type:"
                  displayValue={MEDIA_TYPE_LABELS[mediaTypeFilter]}
                  isActive={mediaTypeFilter !== 'all'}
                  options={TYPE_DROPDOWN_OPTIONS}
                  selectedKey={mediaTypeFilter}
                  optionTestIdPrefix="type"
                  onSelect={setMediaTypeFilter}
                />
                <ToolbarMenu
                  testId="media-aspect-ratio-select"
                  layer="overlayTop"
                  label="Ratio:"
                  displayValue={ASPECT_RATIO_SHORT_VALUES[aspectRatioFilter]}
                  isActive={aspectRatioFilter !== 'all'}
                  options={RATIO_DROPDOWN_OPTIONS}
                  selectedKey={aspectRatioFilter}
                  optionTestIdPrefix="aspect-ratio"
                  onSelect={setAspectRatioFilter}
                />
                <ToolbarMenu
                  testId="media-caption-status-select"
                  layer="overlayTop"
                  label="Captions:"
                  displayValue={CAPTION_STATUS_SHORT_VALUES[captionStatusFilter]}
                  isActive={captionStatusFilter !== 'all'}
                  options={CAPTION_DROPDOWN_OPTIONS}
                  selectedKey={captionStatusFilter}
                  optionTestIdPrefix="caption-status"
                  onSelect={setCaptionStatusFilter}
                />
                <ToolbarMenu
                  testId="media-sort-select"
                  layer="overlayTop"
                  label="Sort:"
                  displayValue={SORT_OPTION_SHORT_VALUES[sortOption]}
                  options={SORT_DROPDOWN_OPTIONS}
                  selectedKey={sortOption}
                  optionTestIdPrefix="sort"
                  onSelect={setSortOption}
                />
                {activeFilterCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid="clear-filters-btn"
                    onClick={handleClearFilters}
                    className="h-11 px-2 text-metadata text-ink-dim hover:text-ink md:h-10"
                  >
                    <span>
                      {activeFilterCount}{' '}
                      {activeFilterCount === 1 ? 'filter' : 'filters'} · Clear
                    </span>
                  </Button>
                )}
              </div>
            )}

            {/* Slim navigation row, as in the library: breadcrumb
                trail, the scope tag (plain truncating text, not the
                toolbar's non-wrapping chip, so a long folder name
                can never push the card wide), and Select all on the
                right (multi mode only). Crumbs are clickable only
                — the library's drag-drop reparenting has no place
                in a picker. */}
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

              <span
                data-testid="media-scope-tag"
                className="min-w-0 truncate text-metadata text-ink-dim"
              >
                {getScopeTagLabel(
                  debouncedSearch,
                  null,
                  currentFolderId,
                  folders
                )}
              </span>

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
                          onTileClick={
                            mode === 'multi'
                              ? (item) => handleToggleSelect(item.id)
                              : undefined
                          }
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
                          <TableHead className="hidden w-21 text-right sm:table-cell">
                            Size
                          </TableHead>
                          <TableHead className="w-30 text-right">
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
                            disableCaptionEditing
                            selected={selectedIds.includes(item.id)}
                            folderPathLabel={
                              debouncedSearch
                                ? `in ${formatFolderAncestryPath(item.folderId, folders)}`
                                : null
                            }
                            onNavigateFolder={navigateFolder}
                            onToggleSelect={handleToggleSelect}
                            onPreview={handlePreview}
                            onTileClick={
                              mode === 'multi'
                                ? (item) => handleToggleSelect(item.id)
                                : undefined
                            }
                            onNameClick={
                              mode === 'multi'
                                ? (item) => handleToggleSelect(item.id)
                                : handlePreview
                            }
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

          {/* P8: the device tab is a drop zone — dropped files take
              the same validation + staging path as the file input. */}
          <TabsContent
            value="device"
            className={cn(
              isDraggingOverDevice && 'rounded-md ring-2 ring-brand-gold/60 ring-inset'
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOverDevice(true);
            }}
            onDragLeave={() => setIsDraggingOverDevice(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingOverDevice(false);
              void handleDeviceFiles(e.dataTransfer.files);
            }}
          >
            <p className="mb-3 text-body text-ink-sub">
              Uploads go to the “{folderName}” folder. The folder is created
              automatically if it doesn’t exist yet. You can also drop files
              anywhere on this tab.
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
            {isDraggingOverDevice && (
              <p className="mt-3 text-center text-body font-medium text-brand-gold">
                Drop files to upload them
              </p>
            )}
            {deviceError && (
              <p className="mt-3 text-body text-brand-rose">{deviceError}</p>
            )}
            {/* P5: the batch's live state on the device tab itself —
                visible while the import modal is minimised to its
                chip, instead of uploads running invisibly. */}
            {uploadsActive && (
              <p
                data-testid="media-picker-upload-status"
                className="mt-3 text-body text-ink-sub"
              >
                Uploading {importActiveCount} file{importActiveCount === 1 ? '' : 's'}…
                {furthestAlongUpload && (
                  <span className="tabular-nums">
                    {' '}
                    {furthestAlongUpload.name} · {furthestAlongUpload.progressPercent}%
                  </span>
                )}
                {uploadedItems.length > 0 && (
                  <span>
                    {' '}
                    · {uploadedItems.length} uploaded
                  </span>
                )}
              </p>
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
            {/* P5: one prominent next step after a batch finishes —
                no auto-append on Done, and Close no longer discards
                the finished batch's setup unnoticed. */}
            {mode === 'multi' && uploadedItems.length > 0 && !uploadsActive && (
              <Button
                type="button"
                data-testid="media-library-picker-add-uploaded-btn"
                onClick={handleAddUploaded}
                className="mt-3 h-11"
              >
                Add {uploadedItems.length} uploaded file{uploadedItems.length === 1 ? '' : 's'} as posts
              </Button>
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
            folder, so device uploads can never land elsewhere.
            Single mode also disables "+ Add more" (P1). */}
        <MediaImportModal
          subdomain={subdomain}
          isOpen={importOpen}
          initialFiles={stagedFiles}
          currentFolderId={pageFolderId}
          folders={folders}
          onClose={handleImportClose}
          onUploadSuccess={handleImportSuccess}
          onActiveUploadsChange={(count, furthest) => {
            setImportActiveCount(count);
            setFurthestAlongUpload(furthest);
            // P2: report live upload state up to the composer
            // dialogue's leave guard — only when it changes, so the
            // dialogue never re-renders in a loop.
            const prev = prevReportedUploadsRef.current;
            if (
              count !== prev.count ||
              (furthest?.name ?? null) !== prev.name ||
              (furthest?.progressPercent ?? null) !== prev.progressPercent
            ) {
              prevReportedUploadsRef.current = {
                count,
                name: furthest?.name ?? null,
                progressPercent: furthest?.progressPercent ?? null,
              };
              onUploadsActiveChange?.(count, furthest);
            }
          }}
          lockDestination
          singleMode={mode === 'single'}
        />

        {/* The library's own preview: in multi mode it is view-only
            (tile clicks preview instead of selecting, exactly as in
            the library); in single mode it carries the "Attach this
            file" action (P7) — tapping a tile never attaches
            instantly anymore. */}
        {previewItem && (
          <MediaPreviewModal
            item={previewItem}
            open={previewItem !== null}
            onOpenChange={(next) => {
              if (!next) setPreviewItem(null);
            }}
            primaryAction={
              mode === 'single'
                ? {
                    label: 'Attach this file',
                    onClick: handleAttachFromPreview,
                    testid: 'media-preview-attach-btn',
                  }
                : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
