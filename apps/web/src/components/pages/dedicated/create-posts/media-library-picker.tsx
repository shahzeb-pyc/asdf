'use client';

/**
 * The Media Library picker for the Create Posts dialogue.
 *
 * One picker serves every attach point: Bulk Post opens it in
 * multi-select mode (each chosen file becomes its own post block),
 * and a block's "Attach media" slot opens the same picker in
 * single-select mode (one tap attaches and closes). The two tabs
 * are the whole picker — there is no third source of media:
 *
 *   - Media Library: the page's own folder (named after the page),
 *     listed from the existing media list API, filtered to that
 *     folder. The folder is created on demand (see below).
 *   - Upload from device: the existing presigned-upload flow
 *     (upload-url → R2 PUT → thumbnail PUT → confirm), with the
 *     confirmed item landing in the page's folder.
 *
 * Page-named folder, auto-created: the folder name is the page
 * name (trimmed to the folder schema's 100 characters). Resolution
 * lists first, creates only when missing, and on a create race
 * (409 "already exists") re-lists instead of failing — two tabs
 * racing to create the same folder still land on one folder.
 */

import * as React from 'react';
import Image from 'next/image';
import {
  FolderListResponseSchema,
  FolderResponseSchema,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath } from '@/lib/api';
import {
  MediaItemSchema,
  MediaListResponseSchema,
  UploadUrlResponseSchema,
  type MediaItem,
} from '@/lib/api/schemas/media';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import {
  classifyAspectRatio,
  generateThumbnailBlob,
  resolveMediaType,
  validateFileForImport,
} from '@/components/media/media-import-utils';
import { toComposerMedia } from './create-posts-types';

export interface MediaLibraryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subdomain: string;
  pageName: string;
  mode: 'single' | 'multi';
  onSingleAttach: (media: ComposerMedia) => void;
  onMultiAttach: (media: ComposerMedia[]) => void;
}

interface DeviceUploadRow {
  key: string;
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string | undefined;
  item?: ComposerMedia | undefined;
}

const MEDIA_LIST_LIMIT = 100;

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
  const folderName = React.useMemo(
    () => (pageName.trim() || 'Page').slice(0, 100),
    [pageName]
  );
  const [tab, setTab] = React.useState<'library' | 'device'>('library');
  const [folderId, setFolderId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<MediaItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [isLoadingLibrary, setIsLoadingLibrary] = React.useState(false);
  const [libraryError, setLibraryError] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(new Set());
  const [deviceRows, setDeviceRows] = React.useState<DeviceUploadRow[]>([]);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const foldersPath = buildTenantApiPath(subdomain, '/media/folders');
  const mediaPath = buildTenantApiPath(subdomain, '/media');

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
      return created.id;
    } catch {
      // Create race (another tab created the same folder first):
      // re-list once and take the folder that now exists.
      const relist = await api.get(foldersPath, {
        schema: FolderListResponseSchema,
      });
      const raced = relist.folders.find((folder) => folder.name === folderName);
      if (raced) return raced.id;
      throw new Error(`Couldn't open the "${folderName}" folder. Please try again.`);
    }
  }, [foldersPath, folderName]);

  const loadLibrary = React.useCallback(async () => {
    setIsLoadingLibrary(true);
    setLibraryError(null);
    try {
      const id = await resolvePageFolder();
      setFolderId(id);
      const list = await api.get(mediaPath, {
        schema: MediaListResponseSchema,
        query: { folderId: id, limit: MEDIA_LIST_LIMIT },
      });
      setItems(list.items);
      setTotal(list.total);
    } catch (error) {
      setLibraryError(errorText(error, "Couldn't load this page's media."));
    } finally {
      setIsLoadingLibrary(false);
    }
  }, [mediaPath, resolvePageFolder]);

  // Fresh state on every open; the library loads when the picker
  // opens (not before — the dialogue underneath stays untouched).
  React.useEffect(() => {
    if (!open) return;
    setTab('library');
    setSelectedIds(new Set());
    setDeviceRows([]);
    void loadLibrary();
  }, [open, loadLibrary]);

  const toggleSelected = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const uploadOne = React.useCallback(
    async (row: DeviceUploadRow, targetFolderId: string): Promise<ComposerMedia> => {
      const file = row.file;
      const mimeType = file.type;
      const mediaType = resolveMediaType(mimeType);
      const presign = await api.post(
        buildTenantApiPath(subdomain, '/media/upload-url'),
        { fileName: file.name, fileSize: file.size, mimeType },
        { schema: UploadUrlResponseSchema }
      );
      const put = await fetch(presign.mediaUploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: file,
      });
      if (!put.ok) throw new Error('Upload failed. Please try again.');
      const thumb = await generateThumbnailBlob(file, mediaType);
      let thumbnailUrl: string | null = null;
      if (thumb.blob) {
        const thumbPut = await fetch(presign.thumbnailUploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/webp' },
          body: thumb.blob,
        });
        if (thumbPut.ok) thumbnailUrl = presign.publicThumbnailUrl;
      }
      const confirmed = await api.post(
        buildTenantApiPath(subdomain, '/media/confirm'),
        {
          mediaId: presign.mediaId,
          name: file.name,
          fileSize: file.size,
          mimeType,
          mediaType,
          storageKey: presign.mediaKey,
          folderId: targetFolderId,
          url: presign.publicMediaUrl,
          thumbnailKey: thumbnailUrl ? presign.thumbnailKey : null,
          thumbnailUrl,
          durationSeconds: thumb.duration,
          aspectRatio: classifyAspectRatio(thumb.width || 0, thumb.height || 0),
          width: thumb.width,
          height: thumb.height,
          captionText: null,
        },
        { schema: MediaItemSchema }
      );
      return toComposerMedia(confirmed);
    },
    [subdomain]
  );

  const runDeviceUpload = React.useCallback(
    async (row: DeviceUploadRow) => {
      setDeviceRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, status: 'uploading', error: undefined } : r))
      );
      try {
        const targetFolderId = folderId ?? (await resolvePageFolder());
        if (!folderId) setFolderId(targetFolderId);
        const item = await uploadOne(row, targetFolderId);
        setDeviceRows((prev) =>
          prev.map((r) => (r.key === row.key ? { ...r, status: 'done', item } : r))
        );
        // A freshly uploaded file is chosen by definition: in
        // single mode it attaches at once; in multi mode it joins
        // the selection so Add selected includes it.
        if (mode === 'single') {
          onSingleAttach(item);
          onOpenChange(false);
        } else {
          // The uploaded file stays visible in the device tab; it
          // joins the selection so Add selected includes it.
          setSelectedIds((prev) => new Set(prev).add(item.id));
        }
      } catch (error) {
        setDeviceRows((prev) =>
          prev.map((r) =>
            r.key === row.key
              ? { ...r, status: 'error', error: errorText(error, 'Upload failed.') }
              : r
          )
        );
      }
    },
    [folderId, mode, onOpenChange, onSingleAttach, resolvePageFolder, uploadOne]
  );

  const handleDeviceFiles = React.useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const rows: DeviceUploadRow[] = [];
      Array.from(files).forEach((file, index) => {
        const problem = validateFileForImport(file, file.type);
        const key = `${file.name}-${file.size}-${index}`;
        if (problem) {
          rows.push({ key, file, status: 'error', error: problem });
        } else {
          rows.push({ key, file, status: 'pending' });
        }
      });
      setDeviceRows((prev) => [...prev, ...rows]);
      rows
        .filter((row) => row.status === 'pending')
        .forEach((row) => void runDeviceUpload(row));
    },
    [runDeviceUpload]
  );

  const selectedItems = React.useMemo(
    () =>
      items
        .map(toComposerMedia)
        .filter((item) => selectedIds.has(item.id)),
    [items, selectedIds]
  );
  // Uploaded device files are not in the library list until it
  // reloads, so they count from their own rows too.
  const uploadedSelected = React.useMemo(
    () =>
      deviceRows
        .filter((row) => row.status === 'done' && row.item && selectedIds.has(row.item.id))
        .map((row) => row.item as ComposerMedia),
    [deviceRows, selectedIds]
  );
  const allSelected = React.useMemo(() => {
    const byId = new Map<string, ComposerMedia>();
    [...selectedItems, ...uploadedSelected].forEach((item) => byId.set(item.id, item));
    return [...byId.values()];
  }, [selectedItems, uploadedSelected]);

  const handleMultiAdd = () => {
    if (allSelected.length === 0) return;
    onMultiAttach(allSelected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="media-library-picker" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'single' ? 'Attach media' : 'Bulk Post — choose media'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'single'
              ? 'Pick one file from this page’s media, or upload one from your device.'
              : 'Tick as many images, reels and videos as you want — each one becomes its own post.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as 'library' | 'device')}
        >
          <TabsList data-testid="media-library-picker-tabs">
            <TabsTrigger value="library">Media Library</TabsTrigger>
            <TabsTrigger value="device">Upload from device</TabsTrigger>
          </TabsList>

          <TabsContent value="library">
            <p className="mb-2 text-body text-ink-sub">
              Folder: <span className="font-semibold text-brand-gold">{folderName}</span>
            </p>
            {isLoadingLibrary && <p className="text-body text-ink-sub">Loading media…</p>}
            {libraryError && !isLoadingLibrary && (
              <div className="flex flex-col items-start gap-2">
                <p className="text-body text-brand-rose">{libraryError}</p>
                <Button type="button" variant="secondary" size="sm" onClick={() => void loadLibrary()}>
                  Try again
                </Button>
              </div>
            )}
            {!isLoadingLibrary && !libraryError && items.length === 0 && (
              <p className="text-body text-ink-sub">
                No media in this folder yet — switch to Upload from device to add some.
              </p>
            )}
            {!isLoadingLibrary && !libraryError && items.length > 0 && (
              <div className="flex max-h-80 flex-col gap-1 overflow-y-auto pr-1">
                {items.map((item) => {
                  const media = toComposerMedia(item);
                  const checked = selectedIds.has(item.id);
                  if (mode === 'single') {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-testid="media-library-picker-item"
                        onClick={() => {
                          onSingleAttach(media);
                          onOpenChange(false);
                        }}
                        className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-hover"
                      >
                        <MediaThumb item={item} />
                        <span className="min-w-0 flex-1 truncate text-body text-ink">
                          {item.name}
                        </span>
                        <span className="shrink-0 text-metadata text-ink-sub">
                          {item.mediaType === 'video' ? 'Video' : 'Photo'}
                        </span>
                      </button>
                    );
                  }
                  return (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-center gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-hover"
                    >
                      <Checkbox
                        data-testid="media-library-picker-checkbox"
                        checked={checked}
                        onCheckedChange={() => toggleSelected(item.id)}
                      />
                      <MediaThumb item={item} />
                      <span className="min-w-0 flex-1 truncate text-body text-ink">
                        {item.name}
                      </span>
                      <span className="shrink-0 text-metadata text-ink-sub">
                        {item.mediaType === 'video' ? 'Video' : 'Photo'}
                      </span>
                    </label>
                  );
                })}
                {total > items.length && (
                  <p className="px-2 text-metadata text-ink-sub">
                    Showing {items.length} of {total} items.
                  </p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="device">
            <p className="mb-3 text-body text-ink-sub">
              Uploads go to the “{folderName}” folder. The folder is created
              automatically if it doesn’t exist yet.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              data-testid="media-library-device-input"
              className="hidden"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
              multiple={mode === 'multi'}
              onChange={(event) => {
                handleDeviceFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="secondary"
              data-testid="media-library-device-choose-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose files from your device
            </Button>
            {deviceRows.length > 0 && (
              <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
                {deviceRows.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center gap-3 rounded-sm border border-line px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {row.file.name}
                    </span>
                    {row.status === 'uploading' && (
                      <span className="shrink-0 text-metadata text-ink-sub">Uploading…</span>
                    )}
                    {row.status === 'pending' && (
                      <span className="shrink-0 text-metadata text-ink-sub">Waiting…</span>
                    )}
                    {row.status === 'done' && (
                      <span className="shrink-0 text-metadata text-brand-emerald">Uploaded</span>
                    )}
                    {row.status === 'error' && (
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-metadata text-brand-rose">
                          {row.error ?? 'Upload failed.'}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void runDeviceUpload(row)}
                        >
                          Retry
                        </Button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {mode === 'multi' && (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              type="button"
              data-testid="media-library-picker-add-btn"
              disabled={allSelected.length === 0}
              onClick={handleMultiAdd}
            >
              {allSelected.length === 0
                ? 'Add selected'
                : `Add selected (${allSelected.length})`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MediaThumb({ item }: Readonly<{ item: MediaItem }>) {
  if (!item.thumbnailUrl) {
    return (
      <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-subtle text-metadata text-ink-sub">
        {item.mediaType === 'video' ? 'Video' : 'Photo'}
      </span>
    );
  }
  return (
    <Image
      src={item.thumbnailUrl}
      alt={item.name}
      width={40}
      height={40}
      className="size-10 shrink-0 rounded-sm object-cover"
    />
  );
}
