'use client';

import React, { useMemo, useState } from 'react';
import { DownloadIcon, PlusIcon } from 'lucide-react';
import type { MediaFolder } from '@fbuploadpro/contracts';
import { deduplicateBatchUrls } from '@fbuploadpro/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/shared/ui';
import { toast } from '@/components/shared/ui/toast';
import { getErrorMessage } from '@/lib/api/errors';
import { formatFolderAncestryPath } from './media-library-breadcrumbs';
import { useCreateFolder, useMediaFolders } from './media-data';
import { useSubmitDownloadJobs } from './download-jobs-data';
import { NewFolderModal } from './new-folder-modal';

/**
 * Download dialog (spec 149). The only way into downloading: a button
 * next to Upload opens this dialog, the user pastes links, picks a
 * destination (defaulting to the folder currently open), and Save
 * closes the dialog at once — the tray, not this dialog, reports
 * progress. Validation mirrors the old form's contract: an invalid
 * batch shows inline errors and submits nothing, and typing clears
 * the error.
 */

/** Radix Select cannot hold an empty-string value; root is a sentinel. */
export const DOWNLOAD_DIALOG_ROOT_FOLDER_VALUE = '__root__';

export function folderIdToSelectValue(folderId: string | null): string {
  return folderId ?? DOWNLOAD_DIALOG_ROOT_FOLDER_VALUE;
}

export function selectValueToFolderId(value: string): string | null {
  return value === DOWNLOAD_DIALOG_ROOT_FOLDER_VALUE ? null : value;
}

export interface DownloadDialogProps {
  subdomain: string;
  /** Folder open in the library when the dialog opened (the default). */
  initialFolderId: string | null;
  onClose: () => void;
}

export function DownloadDialog({
  subdomain,
  initialFolderId,
  onClose,
}: Readonly<DownloadDialogProps>) {
  const foldersQuery = useMediaFolders(subdomain);
  const folders = useMemo<MediaFolder[]>(() => foldersQuery.data ?? [], [foldersQuery.data]);
  const createFolder = useCreateFolder(subdomain);
  const submitJobs = useSubmitDownloadJobs(subdomain);

  const [links, setLinks] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(initialFolderId);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);

  // Live parse (pure, cheap): dedup notice updates as the user types;
  // invalid lines are only shown after a submit attempt, so typing
  // never nags mid-paste — and any keystroke clears the shown error.
  const parsed = useMemo(() => deduplicateBatchUrls(links), [links]);
  const invalidLines = submitAttempted ? parsed.invalidUrls : [];

  const sortedFolderOptions = useMemo(() => {
    const withPaths = folders.map((folder) => ({
      folder,
      pathLabel: formatFolderAncestryPath(folder.id, folders),
    }));
    withPaths.sort((a, b) => a.pathLabel.toLowerCase().localeCompare(b.pathLabel.toLowerCase()));
    return withPaths;
  }, [folders]);

  const handleCreateFolder = async (name: string, parentId: string | null): Promise<void> => {
    const folder = await createFolder.mutateAsync({ name, parentId });
    setSelectedFolderId(folder.id);
    setIsNewFolderOpen(false);
  };

  const handleSubmit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    setSubmitAttempted(true);
    setServerError(null);
    if (parsed.urls.length === 0) {
      return;
    }
    try {
      const result = await submitJobs.mutateAsync({
        links: parsed.urls,
        folderId: selectedFolderId,
      });
      if (result.invalidLinks.length > 0) {
        toast(
          `${result.invalidLinks.length} ${result.invalidLinks.length === 1 ? 'link was' : 'links were'} skipped because ${result.invalidLinks.length === 1 ? 'it is' : 'they are'} not valid links.`
        );
      }
      onClose();
    } catch (err: unknown) {
      setServerError(getErrorMessage(err));
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent data-testid="download-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Download to Media Library</DialogTitle>
            <DialogDescription>
              Original post captions are saved with each video or image.
            </DialogDescription>
          </DialogHeader>

          <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <label
                htmlFor="download-folder-select"
                className="text-body font-medium text-ink"
              >
                Destination folder
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={folderIdToSelectValue(selectedFolderId)}
                  onValueChange={(value) => setSelectedFolderId(selectValueToFolderId(value))}
                >
                  <SelectTrigger
                    id="download-folder-select"
                    data-testid="download-folder-select"
                    className="min-w-55 flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DOWNLOAD_DIALOG_ROOT_FOLDER_VALUE}>
                      All Media (Root)
                    </SelectItem>
                    {sortedFolderOptions.map(({ folder, pathLabel }) => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {pathLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="download-new-folder-button"
                  onClick={() => setIsNewFolderOpen(true)}
                >
                  <PlusIcon aria-hidden />
                  New Folder
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="download-url-input" className="text-body font-medium text-ink">
                Media links
              </label>
              <Textarea
                id="download-url-input"
                rows={5}
                data-testid="download-url-input"
                value={links}
                placeholder={
                  'https://www.tiktok.com/@creator/video/1234567890\nhttps://www.instagram.com/reel/ABC123xyz/\nhttps://drive.google.com/file/d/1A2B3C/view'
                }
                onChange={(e) => {
                  setLinks(e.target.value);
                  // Typing clears the shown error.
                  setSubmitAttempted(false);
                  setServerError(null);
                }}
              />
              <p className="text-metadata text-ink-sub">
                Paste one link or multiple links (one per line). Up to 3 download at
                once · duplicates skipped · files up to 500 MB · TikTok, Facebook,
                Instagram, X, YouTube, Drive, Dropbox, direct links.
              </p>
              {parsed.duplicateCount > 0 && (
                <p data-testid="download-dedup-notice" className="text-metadata tabular-nums text-ink-sub">
                  Skipped {parsed.duplicateCount} duplicate{' '}
                  {parsed.duplicateCount === 1 ? 'link' : 'links'} in batch
                </p>
              )}
              {(invalidLines.length > 0 || serverError) && (
                <div role="alert" data-testid="download-url-error" className="flex flex-col gap-1">
                  {invalidLines.length > 0 && (
                    <p className="text-body text-signal-critical">
                      Please enter at least one valid public link.
                    </p>
                  )}
                  {invalidLines.map((line) => (
                    <p key={line} className="text-metadata break-all text-ink-sub">
                      {line}
                    </p>
                  ))}
                  {serverError && <p className="text-body text-signal-critical">{serverError}</p>}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                data-testid="download-submit-button"
                loading={submitJobs.isPending}
              >
                <DownloadIcon aria-hidden />
                Save to Media Library
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <NewFolderModal
        isOpen={isNewFolderOpen}
        folders={folders}
        initialParentId={selectedFolderId}
        onClose={() => setIsNewFolderOpen(false)}
        onCreateFolder={handleCreateFolder}
      />
    </>
  );
}
