'use client';

/**
 * New folder dialog (spec 133 PR-133-3, spec §6.4 / PB-7).
 *
 * Rebuilt on the shared/ui Dialog + the spec 137 form standard
 * (react-hook-form + zod): one name field (autofocused, Enter
 * submits) and a "Place inside" picker defaulting to the folder
 * being viewed. An empty name disables "Create folder" with the
 * reason present; a duplicate name under the chosen parent is an
 * inline field error — never a popup — and the input is never
 * cleared by a failed submit. On success the explorer opens the
 * new folder on its empty state.
 *
 * The form lives in the Dialog content, which mounts only while
 * the dialog is open, so every open starts from the defaults.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { MediaFolder } from '@fbuploadpro/contracts';

import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import {
  Form,
  FormControl,
  FormErrorSummary,
  FormField,
  FormItem,
  FormLabel,
  type FormErrorSummaryEntry,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';

const ROOT_VALUE = 'library';
export const DUPLICATE_FOLDER_MESSAGE = 'A folder with this name already exists';

/**
 * The new-folder schema. Duplicate detection needs the folder list
 * and the chosen parent, so the schema is built per render of the
 * form (the pattern of spec 135's connect form): the duplicate is a
 * field error on the name, worded exactly as PB-7 requires.
 */
export function createNewFolderSchema(folders: MediaFolder[]) {
  return z
    .object({
      name: z
        .string()
        .refine((value) => value.trim().length > 0, 'Enter a folder name.'),
      parentId: z.string(),
    })
    .superRefine((values, ctx) => {
      const name = values.name.trim().toLowerCase();
      if (name.length === 0) return;
      const parentId = values.parentId === ROOT_VALUE ? null : values.parentId;
      const isDuplicate = folders.some(
        (f) =>
          (f.parentId ?? null) === parentId &&
          f.name.trim().toLowerCase() === name
      );
      if (isDuplicate) {
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: DUPLICATE_FOLDER_MESSAGE,
        });
      }
    });
}

export type NewFolderValues = z.infer<ReturnType<typeof createNewFolderSchema>>;

export interface NewFolderModalProps {
  isOpen: boolean;
  folders: MediaFolder[];
  initialParentId: string | null;
  onClose: () => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
}

export function NewFolderModal({
  isOpen,
  folders,
  initialParentId,
  onClose,
  onCreateFolder,
}: Readonly<NewFolderModalProps>) {
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-testid="new-folder-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Give it a name. Files stay unsorted until you move them in.
          </DialogDescription>
        </DialogHeader>
        {isOpen ? (
          <NewFolderForm
            folders={folders}
            initialParentId={initialParentId}
            onClose={onClose}
            onCreateFolder={onCreateFolder}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewFolderForm({
  folders,
  initialParentId,
  onClose,
  onCreateFolder,
}: Readonly<{
  folders: MediaFolder[];
  initialParentId: string | null;
  onClose: () => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
}>) {
  const form = useForm<NewFolderValues>({
    resolver: zodResolver(createNewFolderSchema(folders)),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      parentId: initialParentId ?? ROOT_VALUE,
    },
  });

  const nameValue = form.watch('name');
  const parentValue = form.watch('parentId');
  const isSubmitting = form.formState.isSubmitting;

  // Live gating (the legacy behaviour): the duplicate state and the
  // empty state disable Create as the user types, with the reason
  // present. The zod error presents inline after blur/submit (the
  // shared validation pattern, UI Rule 4/5).
  const trimmedName = nameValue.trim();
  const parentId = parentValue === ROOT_VALUE ? null : parentValue;
  const isDuplicate =
    trimmedName.length > 0 &&
    folders.some(
      (f) =>
        (f.parentId ?? null) === parentId &&
        f.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
  const isEmpty = trimmedName.length === 0;
  const canSubmit = !isEmpty && !isDuplicate && !isSubmitting;
  const disabledReason = isSubmitting
    ? undefined
    : isEmpty
      ? 'Enter a folder name.'
      : isDuplicate
        ? DUPLICATE_FOLDER_MESSAGE
        : undefined;

  const summaryErrors: FormErrorSummaryEntry[] =
    form.formState.submitCount > 0
      ? Object.entries(form.formState.errors).flatMap(([field, error]) =>
          error.message
            ? [
                {
                  fieldId:
                    field === 'name'
                      ? 'new-folder-name-input'
                      : 'place-inside-select',
                  message: error.message,
                },
              ]
            : []
        )
      : [];

  const handleValid = async (values: NewFolderValues) => {
    await onCreateFolder(
      values.name.trim(),
      values.parentId === ROOT_VALUE ? null : values.parentId
    );
    onClose();
  };

  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit(handleValid)}
        noValidate
      >
        <FormErrorSummary errors={summaryErrors} />

        <FormField
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <FormItem id="new-folder-name-input">
              <FormLabel>Folder name</FormLabel>
              <FormControl>
                <Input
                  autoFocus
                  data-testid="new-folder-name-input"
                  placeholder="e.g. Summer Campaign"
                  disabled={isSubmitting}
                  value={field.value}
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                />
              </FormControl>
              {isDuplicate ? (
                <p
                  data-testid="folder-duplicate-warning"
                  role="alert"
                  className="text-metadata font-medium text-signal-critical"
                >
                  {DUPLICATE_FOLDER_MESSAGE}
                </p>
              ) : fieldState.error ? (
                <p
                  role="alert"
                  className="text-metadata font-medium text-signal-critical"
                >
                  {fieldState.error.message}
                </p>
              ) : null}
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="parentId"
          render={({ field }) => (
            <FormItem id="place-inside-select">
              <FormLabel>Place inside</FormLabel>
              <Select
                value={field.value}
                disabled={isSubmitting}
                onValueChange={(value) => {
                  field.onChange(value);
                  // The duplicate verdict depends on the parent —
                  // re-judge the name against the new parent.
                  void form.trigger('name');
                }}
              >
                <FormControl>
                  <SelectTrigger
                    data-testid="place-inside-select"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={ROOT_VALUE}>Library</SelectItem>
                  {folders.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        <DialogFooter>
          <Button variant="ghost" disabled={isSubmitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            data-testid="submit-create-folder"
            loading={isSubmitting}
            disabled={!canSubmit}
            {...(disabledReason ? { disabledReason } : {})}
          >
            {isSubmitting ? 'Creating...' : 'Create folder'}
          </Button>
        </DialogFooter>
        {disabledReason && !isDuplicate ? (
          <p className="text-right text-metadata text-ink-dim">{disabledReason}</p>
        ) : null}
      </form>
    </Form>
  );
}
