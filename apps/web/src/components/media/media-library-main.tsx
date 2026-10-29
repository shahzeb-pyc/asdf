'use client';

import React from 'react';
import type { MediaFolder, MediaItemResponse } from '@fbuploadpro/contracts';

import { Button } from '@/components/shared/ui/button';
import { cn } from '@/lib/utils';
import type { MediaSmartViewKey, MediaViewMode } from './media-types';
import { MediaCanvas } from './media-library-grid';
import { SubfolderRowsSection } from './media-library-subfolders';

/**
 * Main explorer canvas (spec 133 §6.2): the plain-text breadcrumb
 * context row (root is "Library", ancestors clickable, drag-onto-crumb
 * reparenting with the Move-dialog twin), the "Select all" control in
 * the same row, the subfolder rows, and the media canvas. Rebuilt on
 * token utilities — no box, no panel (PB-1).
 */

export interface BreadcrumbItem {
  id: string;
  name: string;
}

export interface MediaLibraryMainProps {
  breadcrumbs: BreadcrumbItem[];
  activeSmartView: MediaSmartViewKey | null;
  currentFolderId: string | null;
  displayedMediaItems: MediaItemResponse[];
  selectedIds: string[];
  currentSubfolders: MediaFolder[];
  folders: MediaFolder[];
  mediaItems: MediaItemResponse[];
  debouncedSearch: string;
  viewMode: MediaViewMode;
  isLoading: boolean;
  isLocked: boolean;
  activeFilterCount?: number;
  activeFilterLabels?: string[];
  isError?: boolean;
  onRetry?: () => void;
  onClearSearch?: () => void;
  onClearFilters?: () => void;
  onUploadClick?: () => void;
  onNavigateRoot: () => void;
  onNavigateFolder: (folderId: string | null) => void;
  onSelectAll: () => void;
  onToggleSelect: (mediaId: string, options?: { shiftKey?: boolean | undefined }) => void;
  onPreview: (item: MediaItemResponse) => void;
  onUpdateCaption: (mediaId: string, captionText: string) => void;
  onDeleteItem: (mediaId: string) => void;
  onStartRename: (folder: MediaFolder) => void;
  onStartMove: (folder: MediaFolder) => void;
  onStartDelete: (folder: MediaFolder) => void;
  onMoveMediaRequest: (item: MediaItemResponse) => void;
  onFilesDrop: (e: React.DragEvent, targetFolderId?: string | null) => void;
}

export function MediaLibraryMain({
  breadcrumbs,
  activeSmartView,
  currentFolderId,
  displayedMediaItems,
  selectedIds,
  currentSubfolders,
  folders,
  mediaItems,
  debouncedSearch,
  viewMode,
  isLoading,
  isLocked,
  activeFilterCount = 0,
  activeFilterLabels = [],
  isError = false,
  onRetry,
  onClearSearch,
  onClearFilters,
  onUploadClick,
  onNavigateRoot,
  onNavigateFolder,
  onSelectAll,
  onToggleSelect,
  onPreview,
  onUpdateCaption,
  onDeleteItem,
  onStartRename,
  onStartMove,
  onStartDelete,
  onMoveMediaRequest,
  onFilesDrop,
}: Readonly<MediaLibraryMainProps>) {
  const currentFolderName =
    currentFolderId != null
      ? (folders.find((f) => f.id === currentFolderId)?.name ?? null)
      : null;

  return (
    <main data-testid="media-explorer-body" className="flex w-full min-w-0 flex-col">
      {/* Slim Context Row: Breadcrumb in Plain Text on Left, "Select all" on Right */}
      <div
        data-testid="context-row"
        className="flex flex-wrap items-center justify-between gap-4 py-4"
      >
        {/* Breadcrumb Trail in Plain Text (Clickable & Drag-Drop Reparenting) */}
        <nav
          aria-label="Folder path"
          data-testid="folder-breadcrumbs"
          className="flex flex-wrap items-center gap-1.5 text-body text-ink-sub"
        >
          <button
            type="button"
            data-testid="breadcrumb-root"
            onClick={onNavigateRoot}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onFilesDrop(e, null)}
            className={cn(
              'cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-link',
              activeSmartView === null && currentFolderId === null
                ? 'font-semibold text-ink'
                : 'text-ink-sub'
            )}
          >
            Library
          </button>

          {activeSmartView === 'everything' && (
            <>
              <span className="text-ink-dim">/</span>
              <span className="font-semibold text-ink">Everything</span>
            </>
          )}

          {activeSmartView === 'needs_caption' && (
            <>
              <span className="text-ink-dim">/</span>
              <span className="font-semibold text-ink">Needs caption</span>
            </>
          )}

          {!activeSmartView &&
            breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <React.Fragment key={crumb.id}>
                  <span className="text-ink-dim">/</span>
                  <button
                    type="button"
                    data-testid={`breadcrumb-folder-${crumb.id}`}
                    onClick={() => onNavigateFolder(crumb.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onFilesDrop(e, crumb.id)}
                    className={cn(
                      'cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-link',
                      isLast ? 'font-semibold text-ink' : 'text-ink-sub'
                    )}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              );
            })}
        </nav>

        {/* Right: "Select all" toggle */}
        {displayedMediaItems.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            data-testid="select-all-btn"
            onClick={onSelectAll}
            className="h-11 px-2 text-metadata text-ink-sub hover:text-ink md:h-10"
          >
            {selectedIds.length === displayedMediaItems.length
              ? 'Deselect all'
              : 'Select all'}
          </Button>
        )}
      </div>

      {/* Subfolders as ROWS (NOT cards) */}
      {currentSubfolders.length > 0 && !debouncedSearch && !activeSmartView && (
        <SubfolderRowsSection
          currentSubfolders={currentSubfolders}
          folders={folders}
          mediaItems={mediaItems}
          isLocked={isLocked}
          onSelectFolder={(id) => onNavigateFolder(id)}
          onStartRename={onStartRename}
          onStartMove={onStartMove}
          onStartDelete={onStartDelete}
          onFilesDrop={(e, folderId) => onFilesDrop(e, folderId)}
        />
      )}

      {/* Main Media Asset Canvas: Grid or Table View */}
      <MediaCanvas
        displayedMediaItems={displayedMediaItems}
        viewMode={viewMode}
        isLoading={isLoading}
        selectedIds={selectedIds}
        debouncedSearch={debouncedSearch}
        folders={folders}
        activeSmartView={activeSmartView}
        totalMediaCount={mediaItems.length}
        activeFilterCount={activeFilterCount}
        activeFilterLabels={activeFilterLabels}
        currentFolderName={currentFolderName}
        isError={isError}
        onRetry={onRetry}
        onClearSearch={onClearSearch}
        onClearFilters={onClearFilters}
        onUploadClick={onUploadClick}
        onNavigateFolder={onNavigateFolder}
        onToggleSelect={onToggleSelect}
        onPreview={onPreview}
        onUpdateCaption={onUpdateCaption}
        onMoveRequest={onMoveMediaRequest}
        onDeleteRequest={onDeleteItem}
      />
    </main>
  );
}
