'use client';

import React from 'react';
import type { MediaFolder, MediaItemResponse } from '@fbuploadpro/contracts';
import { FolderIcon, MoveIcon, PencilIcon, Trash2Icon } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface SubfolderRowsSectionProps {
  currentSubfolders: MediaFolder[];
  folders: MediaFolder[];
  mediaItems: MediaItemResponse[];
  isLocked: boolean;
  onSelectFolder: (id: string) => void;
  onStartRename: (folder: MediaFolder) => void;
  onStartMove: (folder: MediaFolder) => void;
  onStartDelete: (folder: MediaFolder) => void;
  onFilesDrop: (e: React.DragEvent, targetFolderId: string | null) => void;
}

/**
 * Subfolder rows (spec 133 §6.2 / PB-15): rows, never cards — icon,
 * name, "N subfolders · M files" — separated by hairlines. The
 * Rename / Move / Delete actions are revealed on hover AND equally
 * available on focus-within and touch (UI Rule 19): they are always
 * in the tab order and always visible where hover is unavailable or
 * the viewport is small. Drag-onto-row reparenting keeps its non-drag
 * twin, the Move dialog (UX Rule 10).
 */
export function SubfolderRowsSection({
  currentSubfolders,
  folders,
  mediaItems,
  isLocked,
  onSelectFolder,
  onStartRename,
  onStartMove,
  onStartDelete,
  onFilesDrop,
}: Readonly<SubfolderRowsSectionProps>) {
  return (
    <section aria-label="Subfolders" data-testid="subfolders-grid" className="mb-6 flex flex-col gap-0.5">
      <span className="mb-1.5 text-xs font-semibold tracking-wide text-ink-dim uppercase">
        Folders ({currentSubfolders.length})
      </span>

      <div className="flex flex-col border-t border-line">
        {currentSubfolders.map((folder) => {
          const childSubfolders = folders.filter((f) => f.parentId === folder.id);
          const folderItems = mediaItems.filter((m) => m.folderId === folder.id);
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
                  onSelectFolder(folder.id);
                }
              }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/x-fbuploadpro-folder',
                  JSON.stringify({ folderId: folder.id })
                );
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onFilesDrop(e, folder.id)}
              onClick={() => onSelectFolder(folder.id)}
              className="group flex cursor-pointer items-center justify-between gap-2 border-b border-line px-1 py-2 transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-link"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FolderIcon className="size-5 shrink-0 text-primary" aria-hidden />
                <span
                  data-testid={`folder-name-${folder.id}`}
                  className="truncate text-body font-medium text-ink"
                >
                  {folder.name}
                </span>
                <span className="shrink-0 text-xs whitespace-nowrap text-ink-dim">
                  {subCount} subfolder{subCount === 1 ? '' : 's'} · {fileCount} file
                  {fileCount === 1 ? '' : 's'}
                </span>
              </div>

              <div
                className={cn(
                  'flex shrink-0 items-center gap-1 transition-opacity',
                  'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100'
                )}
              >
                <button
                  type="button"
                  data-testid={`rename-folder-${folder.id}`}
                  aria-label={`Rename ${folder.name}`}
                  disabled={isLocked}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isLocked) return;
                    onStartRename(folder);
                  }}
                  className="inline-flex size-10 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent text-ink-sub outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <PencilIcon className="size-4" aria-hidden />
                </button>

                <button
                  type="button"
                  data-testid={`move-folder-${folder.id}`}
                  aria-label={`Move ${folder.name}`}
                  disabled={isLocked}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isLocked) return;
                    onStartMove(folder);
                  }}
                  className="inline-flex size-10 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent text-ink-sub outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <MoveIcon className="size-4" aria-hidden />
                </button>

                <button
                  type="button"
                  data-testid={`delete-folder-${folder.id}`}
                  aria-label={`Delete ${folder.name}`}
                  disabled={isLocked}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isLocked) return;
                    onStartDelete(folder);
                  }}
                  className="inline-flex size-10 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent text-signal-critical outline-none hover:bg-hover hover:text-signal-critical-on-tint focus-visible:outline-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2Icon className="size-4" aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
