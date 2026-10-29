'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { MediaFolder } from '@fbuploadpro/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormErrorSummary,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type FormErrorSummaryEntry,
} from '@/components/shared/ui';
import {
  DOWNLOADER_ROOT_FOLDER_VALUE,
  folderIdToSelectValue,
  selectValueToFolderId,
} from './downloader-form';

/**
 * New-folder dialog for the downloader (spec 140 PR-140-2, T11/T12) —
 * rebuilt on the shared/ui Dialog (the legacy dialog import is
 * gone), the parent select on shared/ui Select, and the
 * spec-137 form standard.
 *
 * Behaviour parity (§3 item 6): empty name → "Please enter a folder
 * name."; a server error message surfaces verbatim when provided; on
 * success the surface selects the new folder and this dialog closes.
 */

const newFolderFormSchema = z.object({
  name: z.string().trim().min(1, 'Please enter a folder name.'),
  parentId: z.string(),
});

type NewFolderFormValues = z.infer<typeof newFolderFormSchema>;

interface DownloaderNewFolderDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Parent folder preselected when the dialog opens. */
  initialParentId: string | null;
  sortedFolderOptions: Array<{ folder: MediaFolder; pathLabel: string }>;
  /**
   * Creates the folder (the surface's mutation). Rejects with an
   * `Error` whose message is shown verbatim; resolves on success, at
   * which point the dialog closes.
   */
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
}

export function DownloaderNewFolderDialog({
  isOpen,
  onOpenChange,
  initialParentId,
  sortedFolderOptions,
  onCreateFolder,
}: Readonly<DownloaderNewFolderDialogProps>) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent data-testid="downloader-new-folder-dialog">
        <DialogHeader>
          <DialogTitle>New Folder</DialogTitle>
          <DialogDescription>
            Create a destination folder in your Media Library and select it
            for upcoming downloads.
          </DialogDescription>
        </DialogHeader>

        {/* Mounted only while open, so every open starts from a fresh
            form seeded with the current parent folder. */}
        {isOpen ? (
          <NewFolderForm
            initialParentId={initialParentId}
            sortedFolderOptions={sortedFolderOptions}
            onCreateFolder={onCreateFolder}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewFolderForm({
  initialParentId,
  sortedFolderOptions,
  onCreateFolder,
  onOpenChange,
}: Readonly<{
  initialParentId: string | null;
  sortedFolderOptions: Array<{ folder: MediaFolder; pathLabel: string }>;
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}>) {
  const form = useForm<NewFolderFormValues>({
    resolver: zodResolver(newFolderFormSchema),
    mode: 'onTouched',
    reValidateMode: 'onSubmit',
    shouldFocusError: false,
    defaultValues: {
      name: '',
      parentId: folderIdToSelectValue(initialParentId),
    },
  });
  const [submitAttempted, setSubmitAttempted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const isCreating = form.formState.isSubmitting;

  const handleValidSubmit = async (values: NewFolderFormValues) => {
    setServerError(null);
    try {
      await onCreateFolder(values.name, selectValueToFolderId(values.parentId));
      onOpenChange(false);
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : 'Could not create folder.'
      );
    }
  };

  const handleInvalidSubmit = () => {
    setSubmitAttempted(true);
    setServerError(null);
  };

  const nameErrorMessage = form.formState.errors.name?.message
    ? String(form.formState.errors.name.message)
    : null;
  const summaryErrors: FormErrorSummaryEntry[] =
    submitAttempted || serverError
      ? [
          ...(nameErrorMessage
            ? [
                {
                  fieldId: 'downloader-new-folder-input',
                  message: nameErrorMessage,
                },
              ]
            : []),
          ...(serverError ? [{ message: serverError }] : []),
        ]
      : [];

  return (
    <Form {...form}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit(handleValidSubmit, handleInvalidSubmit)}
      >
        {summaryErrors.length > 0 ? (
          <FormErrorSummary errors={summaryErrors} />
        ) : null}

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem id="downloader-new-folder-input">
              <FormLabel>Folder name</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  data-testid="downloader-new-folder-input"
                  placeholder="e.g. Viral Hooks Q4"
                  maxLength={100}
                  disabled={isCreating}
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    if (form.formState.errors.name) {
                      form.clearErrors('name');
                    }
                    if (serverError) {
                      setServerError(null);
                    }
                  }}
                />
              </FormControl>
              <FormMessage data-testid="downloader-new-folder-error" />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="parentId"
          render={({ field }) => (
            <FormItem id="downloader-new-folder-parent-select">
              <FormLabel>Parent location</FormLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={isCreating}
              >
                <FormControl>
                  <SelectTrigger
                    data-testid="downloader-new-folder-parent-select"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={DOWNLOADER_ROOT_FOLDER_VALUE}>
                    All Media (Root)
                  </SelectItem>
                  {sortedFolderOptions.map(({ folder, pathLabel }) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {pathLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        {serverError ? (
          <div
            role="alert"
            data-testid="downloader-new-folder-error"
            className="text-body font-medium text-signal-critical"
          >
            {serverError}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            data-testid="downloader-new-folder-submit"
            disabled={isCreating}
            loading={isCreating}
          >
            {isCreating ? 'Creating...' : 'Create folder'}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
